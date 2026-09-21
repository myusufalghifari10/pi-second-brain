// Table-narrative coupling for PDF-derived text (unpdf extraction path only).
//
// unpdf flattens tables into bare lines with no heading structure, so table chunks end up
// ISOLATED from the sentence that introduces them ("Table 5 shows ..."): concept queries
// retrieve the narrative, number queries retrieve the numbers, never both. This module
// detects table-shaped line runs and prepends the nearest preceding narrative line as a
// "Context: ..." line so the math-aware chunker keeps them in one chunk.
//
// Each table line additionally carries a "Row: <label> | " stamp of its first cell (data rows
// only), so a numeric fast query hitting one row still arrives with the row's identity attached.
//
// Deliberately detection-only (no table parsing), applied ONLY to the unpdf plain-text path
// in engine.ts — sidecar markdown keeps its own heading-based provenance.

export const PDF_TABLE_CONTEXT_PREFIX = "Context: ";
export const PDF_TABLE_ROW_PREFIX = "Row: ";

/** Max characters of narrative scanned backwards from a table block. */
const CONTEXT_SCAN_BUDGET = 400;

/** A table block must contain at least this many consecutive table-shaped lines. */
const MIN_TABLE_RUN = 3;

/** Max characters of a stamped row label; longer labels truncate at a word boundary. */
const MAX_ROW_LABEL_CHARS = 60;

/**
 * First cell of a table line, mirroring isTableLine's column heuristics (pipes when 2+ pipes are
 * present, otherwise 2+ space runs), plus the remainder of the line after that cell.
 */
function splitTableFirstCell(trimmed: string): { label: string; rest: string } {
	if ((trimmed.match(/\|/g) ?? []).length >= 2) {
		const cells = trimmed.split("|");
		for (let k = 0; k < cells.length; k++) {
			const cell = cells[k] ?? "";
			if (cell.trim() !== "") {
				return { label: cell, rest: cells.slice(k + 1).join("|") };
			}
		}
	}
	const cells = trimmed.split(/ {2,}/);
	return { label: cells[0] ?? "", rest: cells.slice(1).join("  ") };
}

function truncateRowLabel(label: string): string {
	if (label.length <= MAX_ROW_LABEL_CHARS) return label;
	const cut = label.lastIndexOf(" ", MAX_ROW_LABEL_CHARS);
	return cut > 0 ? label.slice(0, cut) : label.slice(0, MAX_ROW_LABEL_CHARS);
}

/**
 * Row-label stamp for one table line: "Row: <first cell> | <original line>", so a numeric hit on
 * the row always carries its identity. Only data rows are stamped — the first cell must contain
 * an ASCII letter and a digit must appear later in the line — so pure-numeric rank cells,
 * "---" separators, and delimiter-only rows stay unstamped. Already-stamped lines pass through
 * unchanged (byte-stable re-runs).
 */
function stampTableRow(line: string): string {
	if (line.startsWith(PDF_TABLE_ROW_PREFIX)) return line;
	const { label, rest } = splitTableFirstCell(line.trim());
	const clean = label.trim().replace(/\s+/g, " ");
	if (!/[a-zA-Z]/.test(clean) || !/\d/.test(rest)) return line;
	return `${PDF_TABLE_ROW_PREFIX}${truncateRowLabel(clean)} | ${line}`;
}

function isTableLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return false;
	// Pipe-delimited row (at least one separator on each side of a cell).
	const pipeCount = (trimmed.match(/\|/g) ?? []).length;
	if (pipeCount >= 2) return true;
	// Column gaps: two or more runs of 2+ spaces in one line.
	const gaps = trimmed.match(/ {2,}/g);
	return gaps !== null && gaps.length >= 2;
}

function isHeadingLine(line: string): boolean {
	return /^#{1,6} /.test(line.trimStart());
}

function countTableRun(lines: string[], start: number): number {
	let end = start;
	while (end < lines.length && isTableLine(lines[end])) end++;
	return end - start;
}

/**
 * Nearest preceding narrative line for a table block starting at `tableStart`, or undefined.
 * Stops (without coupling) at another table, a heading, an already-coupled "Context:" line,
 * or after scanning more than CONTEXT_SCAN_BUDGET characters.
 */
function findNarrativeContext(lines: string[], tableStart: number): string | undefined {
	let budget = CONTEXT_SCAN_BUDGET;
	for (let k = tableStart - 1; k >= 0; k--) {
		const line = lines[k];
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.startsWith(PDF_TABLE_CONTEXT_PREFIX)) return undefined; // already coupled: idempotency
		if (isTableLine(line)) return undefined; // previous table: do not couple table-to-table
		if (isHeadingLine(line)) return undefined; // heading: section provenance already exists
		const sentence = trimmed.replace(/\s+/g, " ");
		if (sentence.length > budget) {
			const tail = sentence.slice(-budget);
			const cut = tail.indexOf(" ");
			return cut === -1 ? tail : tail.slice(cut + 1);
		}
		budget -= sentence.length;
		return sentence;
	}
	return undefined;
}

/**
 * Idempotent text transform: every detected table run (MIN_TABLE_RUN+ consecutive table-shaped
 * lines) gets its nearest preceding narrative line prepended as "Context: <sentence>" so chunking
 * keeps the couple together, and each table line is stamped with its row label (see stampTableRow).
 * Oversized tables carry the context in their FIRST chunk only.
 */
export function couplePdfTableNarrative(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (isTableLine(lines[i]) && countTableRun(lines, i) >= MIN_TABLE_RUN) {
			const blockEnd = i + countTableRun(lines, i);
			const context = findNarrativeContext(lines, i);
			if (context !== undefined) {
				out.push(`${PDF_TABLE_CONTEXT_PREFIX}${context}`);
				out.push("");
			}
			for (let k = i; k < blockEnd; k++) out.push(stampTableRow(lines[k]));
			// Separator only when the original text continues directly — never stack blanks
			// (keeps re-coupling byte-stable).
			if (blockEnd < lines.length && lines[blockEnd].trim() !== "") out.push("");
			i = blockEnd;
		} else {
			out.push(lines[i]);
			i++;
		}
	}
	return out.join("\n");
}
