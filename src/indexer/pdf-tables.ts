// Table-narrative coupling for PDF-derived text (unpdf extraction path only).
//
// unpdf flattens tables into bare lines with no heading structure, so table chunks end up
// ISOLATED from the sentence that introduces them ("Table 5 shows ..."): concept queries
// retrieve the narrative, number queries retrieve the numbers, never both. This module
// detects table-shaped line runs and prepends the nearest preceding narrative line as a
// "Context: ..." line so the math-aware chunker keeps them in one chunk.
//
// Deliberately detection-only (no table parsing), applied ONLY to the unpdf plain-text path
// in engine.ts — sidecar markdown keeps its own heading-based provenance.

export const PDF_TABLE_CONTEXT_PREFIX = "Context: ";

/** Max characters of narrative scanned backwards from a table block. */
const CONTEXT_SCAN_BUDGET = 400;

/** A table block must contain at least this many consecutive table-shaped lines. */
const MIN_TABLE_RUN = 3;

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
 * keeps the couple together. Oversized tables carry the context in their FIRST chunk only.
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
			for (let k = i; k < blockEnd; k++) out.push(lines[k]);
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
