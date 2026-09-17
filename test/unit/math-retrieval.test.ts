import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../src/indexer/chunker.ts";
import { searchBM25 } from "../../src/search/bm25.ts";
import { normalizedQueryText } from "../../src/search/query.ts";
import { createKB, getChunkById, insertChunks, openDatabase } from "../../src/storage/sqlite.ts";

const TEST_DIR = "/tmp/pk-test-math-retrieval";

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
};

describe("math-aware retrieval (engine-less FTS)", () => {
	let db: Database.Database;
	let chunkIdByDoc: Record<string, string>;

	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
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
});
