// Chemistry normalization (Layer 4, spec §3.1 of docs/layer4-fidelity-breadth-plan.md).
// Single deterministic chem path behind normalizeFormula: mhchem inputs (\ce{…}) and
// anchored molecular formulas/reactions collapse to element-count tokens with paren groups
// flattened WITH multiplier distribution. Case is preserved throughout (Co ≠ CO). The
// pipeline is pure and total except the documented rejects (zero species,
// > MAX_FORMULA_CHARS). Unicode sub/superscript folding uses a LOCAL char map — the
// FTS-layer sub*/pow* token forms (math-text folds) must never leak into chem signatures.

import type { NormalizedFormula } from "./formula-normalize.ts";
import { MAX_FORMULA_CHARS } from "./math-text.ts";

// All 118 element symbols, case-sensitive.
const ELEMENTS = [
	"H",
	"He",
	"Li",
	"Be",
	"B",
	"C",
	"N",
	"O",
	"F",
	"Ne",
	"Na",
	"Mg",
	"Al",
	"Si",
	"P",
	"S",
	"Cl",
	"Ar",
	"K",
	"Ca",
	"Sc",
	"Ti",
	"V",
	"Cr",
	"Mn",
	"Fe",
	"Co",
	"Ni",
	"Cu",
	"Zn",
	"Ga",
	"Ge",
	"As",
	"Se",
	"Br",
	"Kr",
	"Rb",
	"Sr",
	"Y",
	"Zr",
	"Nb",
	"Mo",
	"Tc",
	"Ru",
	"Rh",
	"Pd",
	"Ag",
	"Cd",
	"In",
	"Sn",
	"Sb",
	"Te",
	"I",
	"Xe",
	"Cs",
	"Ba",
	"La",
	"Ce",
	"Pr",
	"Nd",
	"Pm",
	"Sm",
	"Eu",
	"Gd",
	"Tb",
	"Dy",
	"Ho",
	"Er",
	"Tm",
	"Yb",
	"Lu",
	"Hf",
	"Ta",
	"W",
	"Re",
	"Os",
	"Ir",
	"Pt",
	"Au",
	"Hg",
	"Tl",
	"Pb",
	"Bi",
	"Po",
	"At",
	"Rn",
	"Fr",
	"Ra",
	"Ac",
	"Th",
	"Pa",
	"U",
	"Np",
	"Pu",
	"Am",
	"Cm",
	"Bk",
	"Cf",
	"Es",
	"Fm",
	"Md",
	"No",
	"Lr",
	"Rf",
	"Db",
	"Sg",
	"Bh",
	"Hs",
	"Mt",
	"Ds",
	"Rg",
	"Cn",
	"Nh",
	"Fl",
	"Mc",
	"Lv",
	"Ts",
	"Og",
];

// Longest-first so regex alternation prefers two-letter symbols (Co before C, Cl before C).
const ELEMENTS_BY_LENGTH = [...ELEMENTS].sort((a, b) => b.length - a.length);
const ELEMENT_SOURCE = ELEMENTS_BY_LENGTH.join("|");
const ELEMENT_TWO = new Set(ELEMENTS.filter((symbol) => symbol.length === 2));
const ELEMENT_ONE = new Set(ELEMENTS.filter((symbol) => symbol.length === 1));

// §3.1.1 MOLECULAR_RE — anchored structural pattern: element runs with optional counts
// (ASCII digits or LaTeX-style `_` separators), paren groups nested ≤ 2, trailing charges
// (^{n±}/^n±/+/-), hydrate dots (·/*), and state suffixes ((s)(l)(g)(aq), stripped later).
// Arrows split multi-species sequences. NO internal whitespace inside a species —
// whitespace only around arrows. Matched text must additionally clear the §3.1.1 guards
// in isMolecularFormula (≥ 2 element tokens AND ≥ 1 uppercase letter).
// Parenthesize the alternations: without (?:…) the trailing \\d*/_* prefixes would bind
// only to the first/last alternative (H|He|…\d* is not the same as (?:H|He|…)\d*).
const ELEMENT_UNIT = `(?:${ELEMENT_SOURCE})\\d*`;
const ELEMENT_UNIT_SUB = `(?:${ELEMENT_SOURCE})_\\d+`;
const GROUP_LEVEL_1 = `\\((?:${ELEMENT_UNIT})+\\)\\d*`;
const GROUP_LEVEL_2 = `\\((?:${ELEMENT_UNIT}|${GROUP_LEVEL_1})+\\)\\d*`;
const STATE_SUFFIX = `\\((?:s|l|g|aq)\\)`;
const CHARGE = `\\^\\{?\\d*[+-]\\}?|[+-]\\d+|\\d+[+-]|[+-]`;
const CORE_ATOM = `(?:_*${ELEMENT_UNIT}|_*${ELEMENT_UNIT_SUB}|_*${GROUP_LEVEL_1}|_*${GROUP_LEVEL_2}|_*${STATE_SUFFIX}|[·*]\\d*|(?<![A-Za-z0-9)])\\d+)`;
const SPECIES = `(?:${CORE_ATOM})+(?:${CHARGE})?`;
const ARROW = `->|→|\\\\rightarrow|\\\\leftrightarrow`;
export const MOLECULAR_RE = new RegExp(`^${SPECIES}(?:\\s*(?:${ARROW})\\s*${SPECIES})*$`);

// §3.1.2 step 2 — LOCAL unicode char map (never the FTS FOLD_MAP): sub/superscript
// characters become plain ASCII digits and signs before scanning and before detection.
const CHEM_CHAR_MAP: Record<string, string> = {
	"₀": "0",
	"₁": "1",
	"₂": "2",
	"₃": "3",
	"₄": "4",
	"₅": "5",
	"₆": "6",
	"₇": "7",
	"₈": "8",
	"₉": "9",
	"⁰": "0",
	"¹": "1",
	"²": "2",
	"³": "3",
	"⁴": "4",
	"⁵": "5",
	"⁶": "6",
	"⁷": "7",
	"⁸": "8",
	"⁹": "9",
	"⁺": "+",
	"⁻": "-",
	"₊": "+",
	"₋": "-",
};

function escapeCharClass(ch: string): string {
	return ch.replace(/[\]\\^|-]/g, "\\$&");
}

const CHEM_CHAR_RE = new RegExp(`[${Object.keys(CHEM_CHAR_MAP).map(escapeCharClass).join("")}]`, "g");

const STATE_RE = /\((?:s|l|g|aq)\)/g;
const ARROW_RE = /\\leftrightarrow|\\rightarrow|→/g;
const HYDRATE_RE = /[·*]/g;

function foldChemChars(text: string): string {
	return text.replace(CHEM_CHAR_RE, (ch) => CHEM_CHAR_MAP[ch] ?? ch);
}

// Molecular detection (routing gate + F2 query side): the anchored structural match plus
// the two §3.1.1 guards — ≥ 2 element tokens AND ≥ 1 uppercase letter. Unicode
// sub/superscript characters fold to ASCII first so H₂SO₄ detects exactly like H2SO4 (S1).
export function isMolecularFormula(text: string): boolean {
	const candidate = foldChemChars(text.trim());
	if (candidate === "") return false;
	// Defensive ReDoS guard: a 25+ digit run has no meaning in MOLECULAR_RE beyond
	// extending an element's greedy \\d*, and the CORE_ATOM lookbehind removes the
	// partition ambiguity between that \\d* and the bare \\d+ alternative that made
	// such runs backtrack exponentially. Reject these inputs without running the RE.
	if (/\d{25}/.test(candidate)) return false;
	if (!MOLECULAR_RE.test(candidate)) return false;
	if (!/[A-Z]/.test(candidate)) return false;
	const elementTokens = candidate.match(new RegExp(ELEMENT_SOURCE, "g"));
	return (elementTokens?.length ?? 0) >= 2;
}

// §3.1.2 pipeline (normative order):
// 1. strip outer math fences, \ce{…} wrappers and state suffixes;
// 2. fold unicode sub/superscript characters to ASCII via the local map;
// 3. unify arrows to `->` (charges unify at emission to the canonical trailing ^n± form);
// 4. unify hydrate dots ·/* to the `.` token;
// 5-6. scan species into element-count tokens, flattening paren groups WITH multiplier
//      distribution (mismatched parens tolerated: unterminated groups flatten with
//      multiplier 1), joined by single spaces, case preserved;
// 7. reject (undefined) on zero species or > MAX_FORMULA_CHARS.
export function chemNormalize(raw: string): NormalizedFormula | undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_FORMULA_CHARS) return undefined;
	let work = stripMathFences(trimmed);
	work = stripCeWrappers(work);
	work = work.replace(STATE_RE, " ");
	work = work.replace(/_/g, ""); // `_` subscript separators (MOLECULAR_RE-allowed) vanish before scanning
	work = foldChemChars(work);
	work = work.replace(ARROW_RE, "->");
	work = work.replace(HYDRATE_RE, " . ");
	const entries = scanSpeciesSequence(work);
	if (!entries.some((entry) => entry.kind === "element")) return undefined; // zero species
	const tokens = entries.map((entry) =>
		entry.kind === "element" ? (entry.count > 1 ? `${entry.symbol}${entry.count}` : entry.symbol) : entry.text,
	);
	return { raw: trimmed, normalized: tokens.join(" "), tokens, tokenCount: tokens.length };
}

// Repeatedly strips whole-string math wrappers ($$…$$, $…$, \[…\], \(…\)). Mirrors the L3
// generic-path semantics: a wrapper is only stripped while it wraps the entire string.
function stripMathFences(value: string): string {
	let current = value;
	for (;;) {
		current = current.trim();
		if (current.startsWith("$$") && current.endsWith("$$") && current.length >= 4) {
			const inner = current.slice(2, -2);
			if (!inner.includes("$$")) {
				current = inner;
				continue;
			}
		}
		if (current.startsWith("$") && current.endsWith("$") && current.length >= 2) {
			const inner = current.slice(1, -1);
			if (!inner.includes("$")) {
				current = inner;
				continue;
			}
		}
		if (current.startsWith("\\[") && current.endsWith("\\]") && current.length >= 4) {
			current = current.slice(2, -2);
			continue;
		}
		if (current.startsWith("\\(") && current.endsWith("\\)") && current.length >= 4) {
			current = current.slice(2, -2);
			continue;
		}
		return current;
	}
}

// Removes every \ce{…} wrapper (keeping the content), tolerating nested braces inside
// (e.g. \ce{SO4^{2-}}) and unmatched wrappers (fail-open: only matched braces are dropped).
function stripCeWrappers(text: string): string {
	let out = "";
	let i = 0;
	for (;;) {
		const open = text.indexOf("\\ce{", i);
		if (open === -1) {
			out += text.slice(i);
			return out;
		}
		out += text.slice(i, open);
		let depth = 1;
		let j = open + 4;
		while (j < text.length && depth > 0) {
			if (text[j] === "{") depth++;
			else if (text[j] === "}") depth--;
			j++;
		}
		out += text.slice(open + 4, depth === 0 ? j - 1 : j);
		i = j;
	}
}

type ChemEntry = { kind: "element"; symbol: string; count: number } | { kind: "fixed"; text: string };

// Arrows split species; species order is preserved and species are joined by the arrow
// token (no per-species splitting in v1).
function scanSpeciesSequence(work: string): ChemEntry[] {
	const out: ChemEntry[] = [];
	const speciesList = work.split("->");
	for (let i = 0; i < speciesList.length; i++) {
		if (i > 0) out.push({ kind: "fixed", text: "->" });
		scanSpecies(speciesList[i], out);
	}
	return out;
}

function scanSpecies(species: string, out: ChemEntry[]): void {
	const stack: ChemEntry[][] = [[]];
	let i = 0;
	while (i < species.length) {
		const ch = species[i];
		if (isSkippable(ch)) {
			i++;
			continue;
		}
		if (ch === "(") {
			stack.push([]);
			i++;
			continue;
		}
		if (ch === ")") {
			const digits = takeDigits(species, i + 1);
			closeGroup(stack, digits.text === "" ? 1 : Number.parseInt(digits.text, 10));
			i = digits.next;
			continue;
		}
		if (ch === "^") {
			i = takeCaretCharge(species, i, stack);
			continue;
		}
		if (ch === "+" || ch === "-") {
			if (i === 0 || species[i - 1] === " ") {
				// whitespace-preceded sign is a reaction separator, not a charge
				stack[stack.length - 1].push({ kind: "fixed", text: ch });
				i++;
				continue;
			}
			const digits = takeDigits(species, i + 1);
			pushCharge(stack, digits.text + ch); // "+2" ≡ "2+" ≡ "^2+" → canonical digits+sign body
			i = digits.next;
			continue;
		}
		if (ch === ".") {
			stack[stack.length - 1].push({ kind: "fixed", text: "." }); // hydrate dot, distinct from arrow
			i++;
			continue;
		}
		if (isDigit(ch)) {
			const digits = takeDigits(species, i);
			const sign = species[digits.next];
			if ((sign === "+" || sign === "-") && !isDigit(species[digits.next + 1])) {
				pushCharge(stack, digits.text + sign); // trailing digits+sign charge (e.g. SO42-)
				i = digits.next + 1;
				continue;
			}
			stack[stack.length - 1].push({ kind: "fixed", text: digits.text }); // stoichiometric coefficient
			i = digits.next;
			continue;
		}
		const pair = species.slice(i, i + 2);
		if (ELEMENT_TWO.has(pair)) {
			i = takeElement(species, i + 2, pair, stack);
			continue;
		}
		if (ELEMENT_ONE.has(ch)) {
			i = takeElement(species, i + 1, ch, stack);
			continue;
		}
		i++; // tolerated junk: chemNormalize is total; routing already vetted the input
	}
	while (stack.length > 1) closeGroup(stack, 1); // unterminated group flattens with multiplier 1
	out.push(...stack[0]);
}

function takeElement(species: string, start: number, symbol: string, stack: ChemEntry[][]): number {
	const top = stack[stack.length - 1];
	const digits = takeDigits(species, start);
	if (digits.text !== "") {
		const sign = species[digits.next];
		if ((sign === "+" || sign === "-") && !isDigit(species[digits.next + 1])) {
			top.push({ kind: "element", symbol, count: 1 });
			pushCharge(stack, digits.text + sign); // digits+sign directly after an element is a charge (Ca2+)
			return digits.next + 1;
		}
		top.push({ kind: "element", symbol, count: Number.parseInt(digits.text, 10) });
		return digits.next;
	}
	top.push({ kind: "element", symbol, count: 1 });
	return start;
}

function takeCaretCharge(species: string, start: number, stack: ChemEntry[][]): number {
	let i = start + 1;
	let braced = false;
	if (species[i] === "{") {
		braced = true;
		i++;
	}
	const digits = takeDigits(species, i);
	const sign = species[digits.next];
	if (sign !== "+" && sign !== "-") {
		stack[stack.length - 1].push({ kind: "fixed", text: "^" }); // malformed caret: tolerated, scan continues
		return start + 1;
	}
	pushCharge(stack, digits.text + sign);
	return braced && species[digits.next + 1] === "}" ? digits.next + 2 : digits.next + 1;
}

// Charges canonicalize to the trailing ^n± form: an op token `^` followed by a single
// digits-then-sign body ("2-", "-", "2+").
function pushCharge(stack: ChemEntry[][], body: string): void {
	const top = stack[stack.length - 1];
	top.push({ kind: "fixed", text: "^" });
	top.push({ kind: "fixed", text: body });
}

function closeGroup(stack: ChemEntry[][], multiplier: number): void {
	if (stack.length <= 1) return; // stray ")": tolerated, skipped
	const inner = stack.pop();
	if (!inner) return;
	const parent = stack[stack.length - 1];
	for (const entry of inner) {
		parent.push(
			entry.kind === "element" ? { kind: "element", symbol: entry.symbol, count: entry.count * multiplier } : entry,
		);
	}
}

function takeDigits(text: string, start: number): { text: string; next: number } {
	let end = start;
	while (end < text.length && isDigit(text[end])) end++;
	return { text: text.slice(start, end), next: end };
}

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= "0" && ch <= "9";
}

function isSkippable(ch: string): boolean {
	return (
		ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "_" || ch === "{" || ch === "}" || ch === "$"
	);
}
