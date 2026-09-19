// Math & science text utilities: unicode/LaTeX canonicalization for FTS,
// protected-region scanning (math blocks, tables, code fences), and
// metadata extraction (frontmatter, wikilinks, labels, formulas).
// All functions are pure, deterministic, and fail-open by design.

export const MATH_UNICODE_MAP: Record<string, string> = {
	// Greek lowercase (25)
	α: "alpha",
	β: "beta",
	γ: "gamma",
	δ: "delta",
	ε: "epsilon",
	ζ: "zeta",
	η: "eta",
	θ: "theta",
	ι: "iota",
	κ: "kappa",
	λ: "lambda",
	μ: "mu",
	ν: "nu",
	ξ: "xi",
	ο: "omicron",
	π: "pi",
	ρ: "rho",
	σ: "sigma",
	ς: "sigma",
	τ: "tau",
	υ: "upsilon",
	φ: "phi",
	χ: "chi",
	ψ: "psi",
	ω: "omega",
	// Greek uppercase (24) — folded to the same lowercase word as lowercase
	Α: "alpha",
	Β: "beta",
	Γ: "gamma",
	Δ: "delta",
	Ε: "epsilon",
	Ζ: "zeta",
	Η: "eta",
	Θ: "theta",
	Ι: "iota",
	Κ: "kappa",
	Λ: "lambda",
	Μ: "mu",
	Ν: "nu",
	Ξ: "xi",
	Ο: "omicron",
	Π: "pi",
	Ρ: "rho",
	Σ: "sigma",
	Τ: "tau",
	Υ: "upsilon",
	Φ: "phi",
	Χ: "chi",
	Ψ: "psi",
	Ω: "omega",
	// Relations (12)
	"≤": "leq",
	"≥": "geq",
	"≠": "neq",
	"≈": "approx",
	"≡": "equiv",
	"∝": "propto",
	"∈": "in",
	"∉": "notin",
	"⊂": "subset",
	"⊆": "subseteq",
	"∪": "cup",
	"∩": "cap",
	// Operators (20)
	"±": "pm",
	"∓": "mp",
	"×": "times",
	"÷": "div",
	"·": "cdot",
	"∞": "infty",
	"∂": "partial",
	"∇": "nabla",
	"∑": "sum",
	"∏": "prod",
	"∫": "int",
	"∮": "oint",
	"√": "sqrt",
	"∀": "forall",
	"∃": "exists",
	"∅": "emptyset",
	"∴": "therefore",
	"∵": "because",
	"⊕": "oplus",
	"⊗": "otimes",
	// Arrows (6)
	"→": "to",
	"←": "gets",
	"⇒": "implies",
	"⇔": "iff",
	"↦": "mapsto",
	"↔": "leftrightarrow",
	// Misc (5)
	"∠": "angle",
	"∘": "circ",
	"°": "degree",
	ℏ: "hbar",
	ℓ: "ell",
	// Unit glyphs (3) — L4 §3.2: fold to the same words as their Greek counterparts
	// (µ≡μ→mu, Ω≡Ω→omega) so both codepoints hit identical FTS tokens; Å U+212B
	// (angstrom sign) → angstrom — the Latin letter U+00C5 is deliberately unmapped.
	µ: "mu",
	"\u212B": "angstrom",
	Ω: "omega",
};

// Superscript/subscript code points fold directly to plain alphanumeric
// composite tokens. Word suffixes (powplus, not pow+) are required because
// FTS5 unicode61 and the query-side punctuation strip would shred punctuation.
export const SUPERSCRIPT_FOLDS: Record<string, string> = {
	"⁰": "pow0",
	"¹": "pow1",
	"²": "pow2",
	"³": "pow3",
	"⁴": "pow4",
	"⁵": "pow5",
	"⁶": "pow6",
	"⁷": "pow7",
	"⁸": "pow8",
	"⁹": "pow9",
	"⁺": "powplus",
	"⁻": "powminus",
	"⁼": "poweq",
	ⁿ: "pown",
	ⁱ: "powi",
};

export const SUBSCRIPT_FOLDS: Record<string, string> = {
	"₀": "sub0",
	"₁": "sub1",
	"₂": "sub2",
	"₃": "sub3",
	"₄": "sub4",
	"₅": "sub5",
	"₆": "sub6",
	"₇": "sub7",
	"₈": "sub8",
	"₉": "sub9",
	"₊": "subplus",
	"₋": "subminus",
	"₌": "subeq",
	ₙ: "subn",
};

const ALL_FOLDS: Record<string, string> = { ...MATH_UNICODE_MAP, ...SUPERSCRIPT_FOLDS, ...SUBSCRIPT_FOLDS };

function escapeCharClass(ch: string): string {
	return ch.replace(/[\]\\^|-]/g, "\\$&");
}

const MAPPED_CHARS_RE = new RegExp(`[${Object.keys(ALL_FOLDS).map(escapeCharClass).join("")}]`, "g");

const MATH_BOUNDARY = "\x00"; // token boundary marker; never present in input, becomes one space in output

// Caret rule: ^2 / ^{ij} / ^n → powN; non-alphanumeric braced body (^{\top}) → bare pow.
// The boundary marker is treated as space so caret composition with mapped unicode (^∞ → powinfty) works.
// Chains of carets separated only by whitespace/boundary runs each contribute one `pow`
// (^^x → powpowx), matching the historical fixpoint semantics — but the single left-to-right
// pass in rewriteCaretChains consumes a whole chain at once instead of re-scanning the
// string once per caret (the previous do-while was O(n²) on adjacent-caret runs).
const BOUNDARY_RUN_RE = new RegExp(`(?: *${MATH_BOUNDARY})+ *`, "g");

function isCaretSep(ch: string | undefined): boolean {
	return ch !== undefined && (ch === MATH_BOUNDARY || /\s/.test(ch));
}

function isCaretBodyChar(ch: string | undefined): boolean {
	return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9"));
}

// Caret body at `start`, preserving the historical CARET_RE alternative order and captures:
// {alnum} → braced-alnum body; bare alnum run; {other} → braced body with empty capture.
function matchCaretBody(text: string, start: number): { end: number; captured: string } | undefined {
	const ch = text[start];
	if (ch === undefined) return undefined;
	if (ch === "{") {
		let k = start + 1;
		while (k < text.length && isCaretBodyChar(text[k])) k++;
		if (k > start + 1 && text[k] === "}") return { end: k + 1, captured: text.slice(start + 1, k) };
		const close = text.indexOf("}", start + 1);
		if (close !== -1) return { end: close + 1, captured: "" };
		return undefined;
	}
	if (isCaretBodyChar(ch)) {
		let k = start;
		while (k < text.length && isCaretBodyChar(text[k])) k++;
		return { end: k, captured: text.slice(start, k) };
	}
	return undefined;
}

interface CaretRun {
	start: number;
	end: number;
}

// Rewrites all caret chains in one pass. A maximal run of carets is consumed when the text
// after its trailing separator run is a body, or when the next caret run through that
// separator run is consumed (chain transitivity, resolved right-to-left). A consumed chain
// of `n` carets emits boundary + `pow` × n + terminal body capture + boundary; unconsumed
// carets pass through verbatim.
function rewriteCaretChains(mapped: string): string {
	const runs: CaretRun[] = [];
	for (let i = 0; i < mapped.length; i++) {
		if (mapped[i] !== "^") continue;
		let j = i;
		while (j < mapped.length && mapped[j] === "^") j++;
		runs.push({ start: i, end: j });
		i = j - 1;
	}
	const chains = new Map<number, { chainEnd: number; pows: number; captured: string }>();
	for (let r = runs.length - 1; r >= 0; r--) {
		const run = runs[r];
		if (!run) continue;
		let j = run.end;
		while (j < mapped.length && isCaretSep(mapped[j])) j++;
		const body = matchCaretBody(mapped, j);
		if (body) {
			chains.set(run.start, { chainEnd: body.end, pows: run.end - run.start, captured: body.captured });
			continue;
		}
		const next = runs[r + 1];
		const nextChain = next ? chains.get(next.start) : undefined;
		if (next && next.start === j && nextChain) {
			chains.set(run.start, {
				chainEnd: nextChain.chainEnd,
				pows: run.end - run.start + nextChain.pows,
				captured: nextChain.captured,
			});
		}
	}
	let out = "";
	for (let i = 0; i < mapped.length; i++) {
		const chain = chains.get(i);
		if (chain) {
			out += `${MATH_BOUNDARY}pow${"pow".repeat(chain.pows - 1)}${chain.captured}${MATH_BOUNDARY}`;
			i = chain.chainEnd - 1;
			continue;
		}
		out += mapped[i];
	}
	return out;
}

export function canonicalizeMathText(text: string): string {
	// Identity fast-path: text with zero math characters and no caret is returned
	// by reference — byte-identical output for all non-math content.
	let hasMath = false;
	for (const ch of text) {
		if (ch === "^" || ALL_FOLDS[ch] !== undefined) {
			hasMath = true;
			break;
		}
	}
	if (!hasMath) return text;

	const mapped = text.replace(MAPPED_CHARS_RE, (ch) => `${MATH_BOUNDARY}${ALL_FOLDS[ch]}${MATH_BOUNDARY}`);
	return rewriteCaretChains(mapped).replace(BOUNDARY_RUN_RE, " ").trim();
}

// --- Protected-region scanner ---

export type SegmentKind = "text" | "math" | "table" | "code";

export interface Segment {
	kind: SegmentKind;
	text: string;
	startLine: number; // 1-based inclusive
	endLine: number; // 1-based inclusive
}

export const MAX_MATH_BLOCK_CHARS = 6_000;
export const MAX_FORMULAS = 10;
export const MAX_FORMULA_CHARS = 2_000;
export const MAX_LINKS = 20;
export const MAX_LABELS = 20;
export const MAX_REFS = 40;
export const MAX_TAGS = 20;
export const MAX_ALIASES = 10;

type ScanMode = "markdown" | "latex" | "text";

const LATEX_MATH_ENVS = new Set([
	"equation",
	"equation*",
	"align",
	"align*",
	"gather",
	"gather*",
	"eqnarray",
	"math",
	"displaymath",
]);
const LATEX_TABLE_ENVS = new Set(["table", "table*", "tabular", "tabular*"]);

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const BACKTICK_CLOSE_RE = /^\s*`{3,}\s*$/;
const TILDE_CLOSE_RE = /^\s*~{3,}\s*$/;
const PIPE_ROW_RE = /^\s*\|.*\|\s*$/;
const DISPLAY_OPEN_RE = /^\s*\$\$/;
const LATEX_DISPLAY_OPEN_RE = /^\s*\\\[/;
const LATEX_ENV_BEGIN_RE = /\\begin\{([^}]+)\}/;

function findUnescaped(line: string, needle: string, from: number): number {
	let idx = line.indexOf(needle, from);
	while (idx !== -1) {
		if (line[idx - 1] !== "\\") return idx;
		idx = line.indexOf(needle, idx + 1);
	}
	return -1;
}

interface DetectedRegion {
	kind: Exclude<SegmentKind, "text">;
	endIdx: number; // 0-based inclusive last line of the region
}

function findFenceClose(lines: string[], openIdx: number, closeRe: RegExp): number {
	for (let j = openIdx + 1; j < lines.length; j++) {
		if (closeRe.test(lines[j])) return j;
	}
	return -1;
}

function findLatexEnvClose(lines: string[], openIdx: number, name: string): number {
	const closeToken = `\\end{${name}}`;
	for (let j = openIdx + 1; j < lines.length; j++) {
		if (lines[j].includes(closeToken)) return j;
	}
	return -1;
}

function detectRegion(lines: string[], i: number, mode: ScanMode): DetectedRegion | undefined {
	const line = lines[i];

	if (mode !== "latex") {
		const fence = FENCE_RE.exec(line);
		if (fence) {
			const info = fence[2].trim();
			const isMathFence = info.split(/\s+/)[0] === "math";
			if (isMathFence) {
				const close = findFenceClose(lines, i, BACKTICK_CLOSE_RE);
				if (close !== -1) return { kind: "math", endIdx: close };
			} else {
				const close = findFenceClose(lines, i, fence[1].startsWith("`") ? BACKTICK_CLOSE_RE : TILDE_CLOSE_RE);
				if (close !== -1) return { kind: "code", endIdx: close };
			}
		}

		// Display $$: line starting $$ not closed on the same line spans until a line containing $$.
		if (DISPLAY_OPEN_RE.test(line) && findUnescaped(line, "$$", 0) !== -1) {
			const openIdx = line.indexOf("$$");
			if (line[openIdx - 1] !== "\\") {
				const closeIdx = findUnescaped(line, "$$", openIdx + 2);
				if (closeIdx !== -1) return { kind: "math", endIdx: i }; // single-line $$…$$ is atomic
				for (let j = i + 1; j < lines.length; j++) {
					if (findUnescaped(lines[j], "$$", 0) !== -1) return { kind: "math", endIdx: j };
				}
			}
		}

		if (LATEX_DISPLAY_OPEN_RE.test(line)) {
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].includes("\\]")) return { kind: "math", endIdx: j };
			}
		}

		// Pipe table: run of >= 2 consecutive pipe rows.
		if (PIPE_ROW_RE.test(line) && i + 1 < lines.length && PIPE_ROW_RE.test(lines[i + 1])) {
			let end = i + 1;
			while (end + 1 < lines.length && PIPE_ROW_RE.test(lines[end + 1])) end++;
			return { kind: "table", endIdx: end };
		}
	}

	// LaTeX environments: math envs in all modes, table envs only in latex mode.
	const envMatch = LATEX_ENV_BEGIN_RE.exec(line);
	if (envMatch) {
		const name = envMatch[1];
		const isMathEnv = LATEX_MATH_ENVS.has(name);
		const isTableEnv = mode === "latex" && LATEX_TABLE_ENVS.has(name);
		if (isMathEnv || isTableEnv) {
			const close = findLatexEnvClose(lines, i, name);
			if (close !== -1) return { kind: isTableEnv ? "table" : "math", endIdx: close };
		}
	}

	return undefined;
}

export function splitProtectedSegments(text: string, mode: ScanMode): Segment[] {
	const lines = text.split("\n");
	const segments: Segment[] = [];
	let textStart = 0; // 0-based start of the pending text run
	let i = 0;
	while (i < lines.length) {
		const region = detectRegion(lines, i, mode);
		if (!region) {
			i++;
			continue;
		}
		if (i > textStart) {
			segments.push({
				kind: "text",
				text: lines.slice(textStart, i).join("\n"),
				startLine: textStart + 1,
				endLine: i,
			});
		}
		segments.push({
			kind: region.kind,
			text: lines.slice(i, region.endIdx + 1).join("\n"),
			startLine: i + 1,
			endLine: region.endIdx + 1,
		});
		i = region.endIdx + 1;
		textStart = i;
	}
	if (textStart < lines.length) {
		segments.push({
			kind: "text",
			text: lines.slice(textStart).join("\n"),
			startLine: textStart + 1,
			endLine: lines.length,
		});
	}
	return segments;
}

// --- Oversized protected-segment splitting ---

function countNewlines(text: string): number {
	let count = 0;
	for (const ch of text) if (ch === "\n") count++;
	return count;
}

// Find cut offsets (index right after each top-level \\ row separator).
function topLevelRowCuts(text: string): number[] {
	const cuts: number[] = [];
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") {
			if (text[i + 1] === "\\") {
				if (depth === 0) cuts.push(i + 2);
				i++;
			} else {
				i++; // escaped char: never a brace
			}
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
	}
	return cuts;
}

interface RawPiece {
	text: string;
	lineOffset: number; // 0-based line offset from the start of the segment
}

function splitMathPieces(text: string, maxChars: number): RawPiece[] {
	const cuts = topLevelRowCuts(text);
	if (cuts.length === 0) return [{ text, lineOffset: 0 }];
	// Slices between cuts concatenate back to the full text exactly.
	const rows: RawPiece[] = [];
	let start = 0;
	let lineOffset = 0;
	for (const cut of cuts) {
		const rowText = text.slice(start, cut);
		rows.push({ text: rowText, lineOffset });
		lineOffset += countNewlines(rowText);
		start = cut;
	}
	rows.push({ text: text.slice(start), lineOffset });

	const pieces: RawPiece[] = [];
	let current: RawPiece | undefined;
	for (const row of rows) {
		if (current && current.text.length + row.text.length > maxChars) {
			pieces.push(current);
			current = row;
		} else if (current) {
			current.text += row.text;
		} else {
			current = { ...row };
		}
	}
	if (current) pieces.push(current);
	return pieces;
}

function splitLinePieces(text: string, maxChars: number): RawPiece[] {
	const lines = text.split("\n");
	const pieces: RawPiece[] = [];
	let current: string[] = [];
	let startLineIdx = 0;
	for (let i = 0; i < lines.length; i++) {
		const candidate = [...current, lines[i]].join("\n");
		if (current.length > 0 && candidate.length > maxChars) {
			pieces.push({ text: current.join("\n"), lineOffset: startLineIdx });
			current = [lines[i]];
			startLineIdx = i;
		} else {
			current.push(lines[i]);
		}
	}
	if (current.length > 0) pieces.push({ text: current.join("\n"), lineOffset: startLineIdx });
	return pieces;
}

// Splits an oversized protected segment at structural boundaries only
// (math: top-level \\ row separators; table/code: row/line boundaries).
// Never splits inside a row or line; a single oversized row/line becomes its own piece.
export function splitOversizedProtected(segment: Segment, maxChars: number): Segment[] {
	if (segment.text.length <= maxChars) return [segment];
	const rawPieces =
		segment.kind === "math" ? splitMathPieces(segment.text, maxChars) : splitLinePieces(segment.text, maxChars);
	return rawPieces.map((piece) => {
		const startLine = segment.startLine + piece.lineOffset;
		return { kind: segment.kind, text: piece.text, startLine, endLine: startLine + countNewlines(piece.text) };
	});
}

// --- Metadata extractors ---

// Display formulas from math segments, verbatim, deduped, capped at MAX_FORMULAS
// entries of MAX_FORMULA_CHARS each (truncated with an ellipsis).
export function extractDisplayFormulas(segments: Segment[]): string[] {
	const formulas: string[] = [];
	const seen = new Set<string>();
	for (const segment of segments) {
		if (segment.kind !== "math") continue;
		let text = segment.text;
		if (text.length > MAX_FORMULA_CHARS) text = `${text.slice(0, MAX_FORMULA_CHARS)}…`;
		if (seen.has(text)) continue;
		seen.add(text);
		formulas.push(text);
		if (formulas.length >= MAX_FORMULAS) break;
	}
	return formulas;
}

// Obsidian wikilinks: [[target]], [[target|alias]], [[target#heading]] → target.
export function extractWikiLinks(text: string): string[] {
	const links: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
		const target = match[1].trim();
		if (!target || seen.has(target)) continue;
		seen.add(target);
		links.push(target);
		if (links.length >= MAX_LINKS) break;
	}
	return links;
}

function stripQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1).trim();
	}
	return value;
}

function parseFrontmatterList(raw: string): string[] | undefined {
	const value = raw.trim();
	if (value === "") return [];
	if (value.startsWith("[")) {
		if (!value.endsWith("]")) return undefined; // malformed: unclosed list
		const inner = value.slice(1, -1).trim();
		if (inner === "") return [];
		return inner
			.split(",")
			.map((item) => stripQuotes(item.trim()))
			.filter(Boolean);
	}
	if (value.includes(",")) {
		return value
			.split(",")
			.map((item) => stripQuotes(item.trim()))
			.filter(Boolean);
	}
	const single = stripQuotes(value);
	return single ? [single] : [];
}

export interface Frontmatter {
	title?: string;
	tags: string[];
	aliases: string[];
	bodyStartLine: number;
}

// Obsidian-style frontmatter: "---" on line 1 plus a closing "---" line.
// Allowlist: title (string), tags, aliases. Malformed → all-empty, bodyStartLine 1 (fail-open).
export function parseFrontmatter(text: string): Frontmatter {
	const empty: Frontmatter = { tags: [], aliases: [], bodyStartLine: 1 };
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return empty;
	let closeIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) return empty;

	const result: Frontmatter = { tags: [], aliases: [], bodyStartLine: closeIdx + 2 };
	for (let i = 1; i < closeIdx; i++) {
		const match = /^(title|tags|aliases)\s*:\s*(.*)$/.exec(lines[i].trim());
		if (!match) continue;
		if (match[1] === "title") {
			result.title = stripQuotes(match[2].trim());
		} else {
			const list = parseFrontmatterList(match[2]);
			if (list === undefined) return empty; // malformed → all-empty, bodyStartLine 1
			if (match[1] === "tags") result.tags = list.slice(0, MAX_TAGS);
			else result.aliases = list.slice(0, MAX_ALIASES);
		}
	}
	return result;
}

// \label{…} values, deduped, capped at MAX_LABELS.
export function extractTexLabels(text: string): string[] {
	const labels: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(/\\label\{([^}]+)\}/g)) {
		const label = match[1].trim();
		if (!label || seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
		if (labels.length >= MAX_LABELS) break;
	}
	return labels;
}

// \ref/\eqref/\cref/\Cref/\autoref targets, deduped, capped at MAX_REFS.
export function extractTexRefs(text: string): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(/\\(?:ref|eqref|cref|Cref|autoref)\{([^}]+)\}/g)) {
		const ref = match[1].trim();
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		refs.push(ref);
		if (refs.length >= MAX_REFS) break;
	}
	return refs;
}
