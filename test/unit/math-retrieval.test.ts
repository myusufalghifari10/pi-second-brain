import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../src/indexer/chunker.ts";
import { searchBM25 } from "../../src/search/bm25.ts";
import { normalizedQueryText } from "../../src/search/query.ts";
import { createKB, getChunkById, insertChunks, openDatabase } from "../../src/storage/sqlite.ts";

let TEST_DIR = "";

function doc(title: string, body: string): string {
	return `## ${title}\n\n${body}`;
}

const DOCS: Record<string, string> = {
	massEnergy: doc(
		"Mass Energy",
		"Mass energy equivalence states that the rest mass of a body is related to its energy content. $$E = mc^2$$ The equation appeared in a 1905 paper by Albert Einstein discussing special relativity and inertia.",
	),
	alphaDecay: doc(
		"Alpha Decay",
		"Alpha decay is a type of radioactive decay in which an atomic nucleus emits an alpha particle. The emitted particle carries \\alpha notation in nuclear physics papers and reduces the mass number by four.",
	),
	squarePower: doc(
		"Square Power",
		"Polynomial expansion often writes the square of a variable as x² in plain text. Expanding x² + y² over the reals gives a circle of radius one when the equation is set equal to one in geometry class.",
	),
	omegaNotation: doc(
		"Omega Notation",
		"In physics the angular frequency is commonly written with \\Omega for ohm and \\omega for angular measure. The uppercase form appears in circuit analysis documents discussing resistance values.",
	),
	waterAscii: doc(
		"Heavy Water ASCII",
		"Heavy water is water that contains deuterium. Its molecular formula is H2O with an extra neutron in the nucleus of the hydrogen atoms.",
	),
	waterSubscript: doc(
		"Heavy Water Subscript",
		"Heavy water is water that contains deuterium. Its molecular formula is H₂O with an extra neutron in the nucleus of the hydrogen atoms.",
	),
};

describe("math-aware retrieval (engine-less FTS)", () => {
	let db: Database.Database;
	let chunkIdByDoc: Record<string, string>;

	beforeEach(() => {
		TEST_DIR = mkdtempSync(join(tmpdir(), "pk-test-math-retrieval-"));
		db = openDatabase(TEST_DIR);
		const kb = createKB(db, { name: "math", source_type: "text" });
		chunkIdByDoc = {};
		for (const [name, content] of Object.entries(DOCS)) {
			const ids = insertChunks(db, kb.id, chunkMarkdown(content, `docs/${name}.md`));
			expect(ids.length).toBeGreaterThan(0);
			chunkIdByDoc[name] = ids[0];
		}
	});

	afterEach(() => {
		db.close();
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("finds an indexed $$E = mc^2$$ doc from the unicode query mc² (fast mode)", () => {
		const results = searchBM25(db, "mc²");
		expect(results.length).toBeGreaterThan(0);
		const target = getChunkById(db, chunkIdByDoc.massEnergy);
		expect(results.map((result) => result.chunkId)).toContain(chunkIdByDoc.massEnergy);
		expect(target?.content).toContain("$$E = mc^2$$");
	});

	it("finds a \\alpha doc from the unicode query α", () => {
		const results = searchBM25(db, "α");
		expect(results.length).toBeGreaterThan(0);
		expect(results.map((result) => result.chunkId)).toContain(chunkIdByDoc.alphaDecay);
	});

	it("finds an x² doc from the ASCII query x^2 via the pow2 token (canonicalize-last proof)", () => {
		// If canonicalization ran before the letter-digit split, pow2 would be shredded
		// into "pow 2" and the digit dropped — the FTS term must be exactly pow2.
		expect(normalizedQueryText("x^2")).toBe("pow2");
		const results = searchBM25(db, "x^2");
		expect(results.length).toBeGreaterThan(0);
		expect(results.map((result) => result.chunkId)).toContain(chunkIdByDoc.squarePower);
		const target = getChunkById(db, chunkIdByDoc.squarePower);
		expect(target?.content).toContain("x²");
	});

	it("finds a \\Omega doc from the unicode query Ω (case-folded canonical name)", () => {
		const results = searchBM25(db, "Ω");
		expect(results.length).toBeGreaterThan(0);
		expect(results.map((result) => result.chunkId)).toContain(chunkIdByDoc.omegaNotation);
	});

	it("finds ASCII H2O and subscript H₂O docs from both query spellings in fast mode (token symmetry)", () => {
		for (const query of ["H2O", "H₂O"]) {
			const results = searchBM25(db, query);
			expect(results.length, query).toBeGreaterThan(0);
			const hits = results.map((result) => result.chunkId);
			expect(hits, query).toContain(chunkIdByDoc.waterAscii);
			expect(hits, query).toContain(chunkIdByDoc.waterSubscript);
		}
		const asciiTarget = getChunkById(db, chunkIdByDoc.waterAscii);
		expect(asciiTarget?.content).toContain("H2O");
		const subscriptTarget = getChunkById(db, chunkIdByDoc.waterSubscript);
		expect(subscriptTarget?.content).toContain("H₂O");
	});

	it("canonicalizes a 100KB caret run in under 100ms (single-pass caret chain rewrite)", () => {
		const text = `${"^".repeat(100_000)}x`;
		const start = performance.now();
		const result = normalizedQueryText(text);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(100);
		expect(result).toContain("pow");
	});
});
