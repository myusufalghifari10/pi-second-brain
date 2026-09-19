// Formula normalization + query-side formula extraction (Layer 3, spec §3.1 of
// docs/layer3-formula-retrieval-plan.md; L4 §3.1 adds the chemistry branch). Structural-
// lexical canonical form: a formula collapses to single-space-joined tokens;
// braces/brackets/parens are structural and removed; case is preserved. Unicode maps,
// MAX_FORMULA_CHARS and the protected-segment scanner are reused from L1 math-text.ts
// (imports only, never duplicated).

import { chemNormalize, isMolecularFormula } from "./chem-normalize.ts";
import {
	MATH_UNICODE_MAP,
	MAX_FORMULA_CHARS,
	SUBSCRIPT_FOLDS,
	SUPERSCRIPT_FOLDS,
	splitProtectedSegments,
} from "./math-text.ts";

export interface NormalizedFormula {
	raw: string; // input, trimmed
	normalized: string; // canonical tokens, single-space joined
	tokens: string[];
	tokenCount: number;
}

export interface QueryFormulas {
	formulas: NormalizedFormula[];
	cleanedQuery: string;
}

const MAX_QUERY_FORMULAS = 5;
const BARE_TEX_MIN_COMMANDS = 2;

// Unicode canonicalization folds (§3.1 step 4), composed from the exported L1 maps:
// superscripts → pow*, subscripts → sub*, Greek → word form, operators/arrows per map.
const FOLD_MAP: Record<string, string> = { ...MATH_UNICODE_MAP, ...SUPERSCRIPT_FOLDS, ...SUBSCRIPT_FOLDS };

function escapeCharClass(ch: string): string {
	return ch.replace(/[\]\\^|-]/g, "\\$&");
}

const FOLD_RE = new RegExp(`[${Object.keys(FOLD_MAP).map(escapeCharClass).join("")}]`, "g");

// §3.1 step 2 — layout commands: drop the command, keep any delimiter character.
// The (?![a-zA-Z]) guard keeps command boundaries intact (\left( vs \leftarrow, \big vs \bigcup).
const LAYOUT_COMMANDS_RE = /\\(?:displaystyle|qquad|quad|left|right|bigg|Bigg|big|Big|limits)(?![a-zA-Z])|\\[,;:!]/g;
// §3.1 step 3 — style wrappers: drop the wrapper, keep its argument.
const STYLE_UNWRAP_RE =
	/\\(?:mathrm|mathit|mathbf|mathsf|mathtt|mathcal|mathbb|mathfrak|textrm|text|operatorname)(?![a-zA-Z])/g;
// §3.1 step 3 — fraction variants all become \frac.
const FRAC_VARIANT_RE = /\\(?:dfrac|tfrac|cfrac)(?![a-zA-Z])/g;

// §3.1 step 5 — frozen TeX alias table (17 groups): command name (no backslash) → canonical name.
const TEX_ALIASES: Record<string, string | undefined> = {
	le: "leq",
	leq: "leq",
	ge: "geq",
	geq: "geq",
	ne: "neq",
	neq: "neq",
	to: "to",
	rightarrow: "to",
	leftarrow: "leftarrow",
	gets: "leftarrow",
	Leftrightarrow: "iff",
	iff: "iff",
	Rightarrow: "Rightarrow",
	implies: "Rightarrow",
	land: "land",
	wedge: "land",
	lor: "lor",
	vee: "lor",
	varepsilon: "epsilon",
	vartheta: "theta",
	varphi: "phi",
	varpi: "pi",
	varrho: "rho",
	varsigma: "sigma",
	dots: "dots",
	ldots: "dots",
	cdots: "dots",
	cdot: "cdot",
};

const BRACKET_CHARS = new Set(["{", "}", "[", "]", "(", ")"]);
const TEX_TOKEN_RE = /\\([a-zA-Z]+)|([a-zA-Z0-9]+)|([\s\S])/g;

// §3.1 step 1 — strip outer math delimiters repeatedly while the whole string stays
// wrapped. The inner no-delimiter check refuses false wraps like "$a$ + $b$".
function stripOuterDelimiters(value: string): string {
	let current = value;
	for (;;) {
		current = current.trim();
		if (current.startsWith("$$") && current.endsWith("$$") && current.length >= 4) {
			const inner = current.slice(2, -2);
			if (!inner.includes("$")) {
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

function foldUnicode(text: string): string {
	return text.replace(FOLD_RE, (ch) => ` ${FOLD_MAP[ch]} `);
}

// §3.1 step 6 — tokenizer: TeX commands, alnum runs, single non-alnum op chars.
// Braces/brackets/parens are structural and removed; lone backslashes (row separators,
// escaped punctuation) are TeX syntax, not math content; whitespace only separates.
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	text.replace(TEX_TOKEN_RE, (_full: string, command?: string, run?: string, ch?: string) => {
		if (command !== undefined) {
			tokens.push(TEX_ALIASES[command] ?? command);
		} else if (run !== undefined) {
			tokens.push(run);
		} else if (ch !== undefined && !BRACKET_CHARS.has(ch) && ch !== "\\" && ch.trim() !== "") {
			tokens.push(ch);
		}
		return "";
	});
	return tokens;
}

export function normalizeFormula(raw: string): NormalizedFormula | undefined {
	const trimmed = raw.trim();
	if (trimmed.length > MAX_FORMULA_CHARS) return undefined;
	// L4 chem routing (spec §3.1): mhchem inputs, and inputs with no TeX commands whose
	// unwrapped text full-matches the anchored molecular pattern, take the chemistry
	// pipeline. Index-side formula strings carry outer math fences ($$…$$), so the
	// molecular test runs on the fence-unwrapped text (S1: plain ≡ \ce rows); the raw
	// input is still what chemNormalize consumes. Everything else keeps the generic path.
	if (trimmed.includes("\\ce{")) return chemNormalize(trimmed);
	const unwrapped = stripOuterDelimiters(trimmed);
	if (!HAS_TEX_COMMAND_RE.test(unwrapped) && isMolecularFormula(unwrapped)) return chemNormalize(trimmed);
	let work = stripOuterDelimiters(trimmed);
	work = work.replace(LAYOUT_COMMANDS_RE, "");
	work = work.replace(STYLE_UNWRAP_RE, "");
	work = work.replace(FRAC_VARIANT_RE, "\\frac");
	work = foldUnicode(work);
	const tokens = tokenize(work);
	if (tokens.length === 0) return undefined;
	return { raw: trimmed, normalized: tokens.join(" "), tokens, tokenCount: tokens.length };
}

// Inline $…$ spans inside a text line (escaped \$ never opens or closes a span).
// Empty/whitespace spans are left as literal text.
function extractInlineMath(line: string): { spans: string[]; rest: string } {
	const spans: string[] = [];
	let rest = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "$" && line[i - 1] !== "\\") {
			let close = -1;
			for (let j = i + 1; j < line.length; j++) {
				if (line[j] === "$" && line[j - 1] !== "\\") {
					close = j;
					break;
				}
			}
			if (close !== -1) {
				const inner = line.slice(i + 1, close);
				if (inner.trim().length > 0) {
					spans.push(inner);
					rest += " ";
					i = close + 1;
					continue;
				}
			}
		}
		rest += ch;
		i++;
	}
	return { spans, rest };
}

// Ratified bare-TeX rule (spec §3.1 step 2): ≥2 TeX commands, or ≥1 command directly
// followed by a braced argument — prose mentioning a single bare command stays text.
const TEX_COMMAND_RE = /\\[a-zA-Z]+/g;
const BRACED_COMMAND_RE = /\\[a-zA-Z]+\{/;
// L4 chem routing gate: non-global variant for stateless .test() use.
const HAS_TEX_COMMAND_RE = /\\[a-zA-Z]+/;

function isBareTexFormula(text: string): boolean {
	const commandCount = text.match(TEX_COMMAND_RE)?.length ?? 0;
	if (commandCount >= BARE_TEX_MIN_COMMANDS) return true;
	return commandCount >= 1 && BRACED_COMMAND_RE.test(text);
}

function addFormula(formulas: NormalizedFormula[], candidate: string): void {
	if (formulas.length >= MAX_QUERY_FORMULAS) return;
	const normalized = normalizeFormula(candidate);
	if (normalized !== undefined) formulas.push(normalized);
}

export function extractQueryFormulas(query: string): QueryFormulas {
	// splitProtectedSegments detects display math only; text segments are additionally
	// scanned for inline $…$ spans below (queries are not markdown documents).
	const segments = splitProtectedSegments(query, "text");
	const formulas: NormalizedFormula[] = [];
	const cleanedParts: string[] = [];
	for (const segment of segments) {
		if (segment.kind === "math") {
			addFormula(formulas, segment.text);
			continue; // math segments are removed from the text leg
		}
		if (segment.kind !== "text") {
			cleanedParts.push(segment.text); // table/code segments pass through untouched
			continue;
		}
		const spans: string[] = [];
		const lines: string[] = [];
		for (const line of segment.text.split("\n")) {
			const scan = extractInlineMath(line);
			spans.push(...scan.spans);
			lines.push(scan.rest);
		}
		for (const span of spans) addFormula(formulas, span);
		const remainder = lines.join("\n");
		// Shared cap above both legs: oversized segments can never yield a formula
		// (normalizeFormula rejects > MAX_FORMULA_CHARS), so skip both scans entirely.
		if (remainder.length <= MAX_FORMULA_CHARS) {
			if (isBareTexFormula(remainder)) addFormula(formulas, remainder);
			// L4 F2 (spec §3.1): text segments that full-match the molecular pattern become one
			// chem formula (the plain query H2SO4 works). Bare-TeX keeps L3 precedence.
			else if (isMolecularFormula(remainder)) addFormula(formulas, remainder);
		}
		cleanedParts.push(remainder);
	}
	if (formulas.length === 0) return { formulas: [], cleanedQuery: query };
	let cleanedQuery = cleanedParts.join("\n").replace(/\s+/g, " ").trim();
	if (cleanedQuery === "") cleanedQuery = query; // the text leg must never starve
	return { formulas, cleanedQuery };
}
