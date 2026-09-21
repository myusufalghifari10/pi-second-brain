import { describe, expect, it } from "vitest";
import {
	couplePdfTableNarrative,
	PDF_TABLE_CONTEXT_PREFIX,
	PDF_TABLE_ROW_PREFIX,
} from "../../src/indexer/pdf-tables.ts";

const INTRO = "Table 5 shows the wall-clock latency of each method on an RTX 5060 GPU.";
const TABLE = [
	"Method        Latency (us)   PPL",
	"LLVQ          11.94          5.33",
	"QTIP          9.87           5.15",
	"FP16          16.30          4.62",
];
const tableText = TABLE.join("\n");

describe("couplePdfTableNarrative (PDF table-narrative coupling)", () => {
	it("prepends the nearest preceding narrative line as a Context line before a table block", () => {
		const text = `${INTRO}\n\n${tableText}\n\nSome closing narrative.\n`;
		const coupled = couplePdfTableNarrative(text);
		expect(coupled).toContain(`${PDF_TABLE_CONTEXT_PREFIX}${INTRO}`);
		// Context sits immediately before the table block, separated by one blank line.
		const lines = coupled.split("\n");
		const contextIndex = lines.findIndex((line) => line.startsWith(PDF_TABLE_CONTEXT_PREFIX));
		expect(lines[contextIndex]).toBe(`${PDF_TABLE_CONTEXT_PREFIX}${INTRO}`);
		expect(lines[contextIndex + 1]).toBe("");
		expect(lines[contextIndex + 2]).toBe(TABLE[0]);
		// Table lines are preserved verbatim and stay adjacent.
		for (const tableLine of TABLE) expect(coupled).toContain(tableLine);
	});

	it("does not couple a table at the very start of the document", () => {
		const coupled = couplePdfTableNarrative(`${tableText}\n\nClosing text.\n`);
		expect(coupled).not.toContain(PDF_TABLE_CONTEXT_PREFIX);
		// Data rows are stamped, so the block is no longer one contiguous substring; check per line.
		for (const tableLine of TABLE) expect(coupled).toContain(tableLine);
	});

	it("does not couple a table preceded only by a heading", () => {
		const text = `# Results\n\n${tableText}\n`;
		const coupled = couplePdfTableNarrative(text);
		expect(coupled).not.toContain(PDF_TABLE_CONTEXT_PREFIX);
	});

	it("does not couple table-to-table", () => {
		const intro = "Two tables follow.";
		const text = `${intro}\n\n${tableText}\n\n${tableText}\n`;
		const coupled = couplePdfTableNarrative(text);
		// The first table gets the intro; the second table's nearest preceding line is a table
		// line, which must NOT become its context.
		expect(coupled).toContain(`${PDF_TABLE_CONTEXT_PREFIX}${intro}`);
		const contextCount = coupled.split("\n").filter((line) => line.startsWith(PDF_TABLE_CONTEXT_PREFIX)).length;
		expect(contextCount).toBe(1);
	});

	it("is idempotent: re-coupling already-coupled text does not duplicate Context lines", () => {
		const text = `${INTRO}\n\n${tableText}\n\nClosing.\n`;
		const once = couplePdfTableNarrative(text);
		const twice = couplePdfTableNarrative(once);
		expect(twice).toBe(once);
	});

	it("ignores runs shorter than three table-like lines", () => {
		const text = `${INTRO}\n\n${TABLE[0]}\n${TABLE[1]}\n\nClosing.\n`;
		const coupled = couplePdfTableNarrative(text);
		expect(coupled).not.toContain(PDF_TABLE_CONTEXT_PREFIX);
		expect(coupled).toContain(text);
	});

	it("detects pipe-delimited table rows without multi-space gaps", () => {
		const pipes = ["name|value|unit", "alpha|11.94|us", "beta|16.30|us"].join("\n");
		const text = `${INTRO}\n\n${pipes}\n`;
		const coupled = couplePdfTableNarrative(text);
		expect(coupled).toContain(`${PDF_TABLE_CONTEXT_PREFIX}${INTRO}`);
	});

	it("cuts overly long narrative lines to the tail at a word boundary within the 400-char budget", () => {
		const words = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
		const text = `${words}\n${tableText}\n`;
		const coupled = couplePdfTableNarrative(text);
		const contextLine = coupled.split("\n").find((line) => line.startsWith(PDF_TABLE_CONTEXT_PREFIX)) ?? "";
		expect(contextLine.length).toBeLessThanOrEqual(PDF_TABLE_CONTEXT_PREFIX.length + 400);
		// The cut happens at a word boundary: the line ends with a complete word.
		expect(contextLine.endsWith("word119")).toBe(true);
	});

	it("leaves ordinary prose without table runs byte-identical", () => {
		const text = "Just two narrative lines.\nNothing tabular here at all.\n";
		expect(couplePdfTableNarrative(text)).toBe(text);
	});
});

describe("couplePdfTableNarrative row-label stamping", () => {
	const STAMP_ROWS = [
		"Method | Sparsity | PPL",
		"--- | --- | ---",
		"MaskLLM (end-to-end) | 62.53 | 5.1",
		"GSQ (block-wise) | 62.86 | 5.3",
		"62.86 | 1.0 | 2.0",
	];

	it("stamps lettered-first-cell data rows, leaving header, separator, and numeric-first-cell rows unstamped", () => {
		const coupled = couplePdfTableNarrative(`${INTRO}\n\n${STAMP_ROWS.join("\n")}\n`);
		expect(coupled).toContain(`${PDF_TABLE_ROW_PREFIX}MaskLLM (end-to-end) | ${STAMP_ROWS[2]}`);
		expect(coupled).toContain(`${PDF_TABLE_ROW_PREFIX}GSQ (block-wise) | ${STAMP_ROWS[3]}`);
		// Header row: no digit after the first cell. Separator: no letter. Rank-style row: pure-numeric first cell.
		expect(coupled).toContain(STAMP_ROWS[0]);
		expect(coupled).toContain(STAMP_ROWS[1]);
		expect(coupled).toContain(STAMP_ROWS[4]);
		expect(coupled).not.toContain(`${PDF_TABLE_ROW_PREFIX}Method`);
		expect(coupled).not.toContain(`${PDF_TABLE_ROW_PREFIX}---`);
	});

	it("keeps a numeric hit co-located with its row label: number and method name share one line", () => {
		const coupled = couplePdfTableNarrative(STAMP_ROWS.slice(0, 4).join("\n"));
		const lines = coupled.split("\n");
		const gsq = lines.find((line) => line.includes("62.86"));
		expect(gsq).toBeDefined();
		expect(gsq).toContain("GSQ (block-wise)");
		const mask = lines.find((line) => line.includes("62.53"));
		expect(mask).toBeDefined();
		expect(mask).toContain("MaskLLM (end-to-end)");
	});

	it("is byte-identical when applied twice to stamped tables", () => {
		const text = `${INTRO}\n\n${STAMP_ROWS.join("\n")}\n\nClosing narrative.\n`;
		const once = couplePdfTableNarrative(text);
		const twice = couplePdfTableNarrative(once);
		expect(twice).toBe(once);
	});

	it("truncates row labels longer than 60 characters at a word boundary", () => {
		const label = "MaskLLM trainable N:M sparsity with a very long descriptive method name that keeps going and going";
		expect(label.length).toBeGreaterThan(60);
		const expectedLabel = label.slice(0, label.lastIndexOf(" ", 60));
		expect(expectedLabel.length).toBeLessThanOrEqual(60);
		const rows = ["Method | Score | Rank", `${label} | 62.86 | 1`, "GSQ | 61.40 | 2"];
		const coupled = couplePdfTableNarrative(rows.join("\n"));
		expect(coupled).toContain(`${PDF_TABLE_ROW_PREFIX}${expectedLabel} | ${rows[1]}`);
	});

	it("passes markdown prose without table runs through unchanged", () => {
		const md =
			"# Results\n\nThe GSQ block-wise method scores 62.86 on the benchmark, as introduced in Table 5.\nDerivations appear in the appendix.\n";
		expect(couplePdfTableNarrative(md)).toBe(md);
	});
});
