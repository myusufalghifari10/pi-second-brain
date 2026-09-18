import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ChunkInsert } from "../../src/storage/sqlite.ts";
import {
	createKB,
	deleteFormulasForChunks,
	deleteKB,
	findExactFormulas,
	getKB,
	insertChunks,
	listChunksForFormulaBackfill,
	markFormulaIndexBuilt,
	openDatabase,
	replaceFormulasForChunk,
	searchFormulasFTS,
} from "../../src/storage/sqlite.ts";

const E_MC2 = { ordinal: 0, raw: "$$E = mc^2$$", normalized: "E = mc ^ 2", tokenCount: 5 };
const INT = {
	ordinal: 1,
	raw: "$$\\int_0^\\infty e^{-x^2}dx$$",
	normalized: "int 0 infty e pow - x ^ 2 dx",
	tokenCount: 10,
};

let chunkCounter = 0;

function chunkInsert(overrides: Partial<ChunkInsert> = {}): ChunkInsert {
	chunkCounter += 1;
	return {
		content_hash: `hash-${chunkCounter}`,
		content: "body",
		content_tokenized: "body",
		file_path: "docs/physics.md",
		file_type: "md",
		start_line: 1,
		end_line: 10,
		metadata_json: JSON.stringify({ formulas: [E_MC2.raw] }),
		...overrides,
	};
}

function tableNames(db: Database.Database, kind: "table" | "trigger" | "index"): Set<string> {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(kind) as Array<{ name: string }>;
	return new Set(rows.map((row) => row.name));
}

function formulaCount(db: Database.Database, kbId: string): number {
	const row = db.prepare("SELECT COUNT(*) as count FROM formulas WHERE kb_id = ?").get(kbId) as { count: number };
	return row.count;
}

describe("formula storage schema (F3)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("creates schema version 7 with formulas table, FTS table, triggers, indexes, and kb flag column", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-formulas-"));
		tempDirs.push(dir);
		const db = openDatabase(dir);
		try {
			expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 7 });

			const tables = tableNames(db, "table");
			expect(tables.has("formulas")).toBe(true);
			expect(tables.has("formulas_fts")).toBe(true);

			const triggers = tableNames(db, "trigger");
			expect(triggers.has("formulas_ai")).toBe(true);
			expect(triggers.has("formulas_ad")).toBe(true);
			expect(triggers.has("formulas_au")).toBe(true);

			const indexes = tableNames(db, "index");
			expect(indexes.has("idx_formulas_kb_chunk")).toBe(true);
			expect(indexes.has("idx_formulas_kb_norm")).toBe(true);

			const columns = db.prepare("PRAGMA table_info(knowledge_bases)").all() as Array<{
				name: string;
				notnull: number;
				dflt_value: string | null;
			}>;
			const names = columns.map((column) => column.name);
			expect(names).toContain("formula_index_built");

			const flagColumn = columns.find((column) => column.name === "formula_index_built");
			expect(flagColumn?.notnull).toBe(1);
			expect(flagColumn?.dflt_value).toBe("0");
		} finally {
			db.close();
		}
	});

	it("migrates a legacy v5 database to v7 and preserves chunk data", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-formulas-"));
		tempDirs.push(dir);

		// Build a fresh v6 database, then downgrade it to a v5-shaped one to exercise the migration path.
		{
			const db = openDatabase(dir);
			try {
				const kb = createKB(db, { name: "legacy", source_type: "text" });
				insertChunks(db, kb.id, [chunkInsert()]);
				db.exec(`
					DROP TRIGGER IF EXISTS formulas_ai;
					DROP TRIGGER IF EXISTS formulas_ad;
					DROP TRIGGER IF EXISTS formulas_au;
					DROP TABLE formulas_fts;
					DROP TABLE formulas;
					ALTER TABLE knowledge_bases DROP COLUMN formula_index_built;
					UPDATE schema_version SET version = 5;
				`);
			} finally {
				db.close();
			}
		}

		const db = openDatabase(dir);
		try {
			expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 7 });
			expect(tableNames(db, "table").has("formulas")).toBe(true);
			expect(tableNames(db, "table").has("formulas_fts")).toBe(true);
			expect(tableNames(db, "table").has("label_edges")).toBe(true);
			const triggers = tableNames(db, "trigger");
			expect(triggers.has("formulas_ai")).toBe(true);
			expect(triggers.has("formulas_ad")).toBe(true);
			expect(triggers.has("formulas_au")).toBe(true);
			const names = (db.prepare("PRAGMA table_info(knowledge_bases)").all() as Array<{ name: string }>).map(
				(column) => column.name,
			);
			expect(names).toContain("formula_index_built");

			// The re-run must be safe: v6 migration objects already exist in a fresh v6 database.
			const kb = getKBByNameFromList(db);
			expect(kb).toBeDefined();
			const chunks = db.prepare("SELECT id FROM chunks").all() as Array<{ id: string }>;
			expect(chunks).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});

function getKBByNameFromList(db: Database.Database): { id: string; formula_index_built: number } | undefined {
	const row = db.prepare("SELECT id, formula_index_built FROM knowledge_bases LIMIT 1").get() as
		| { id: string; formula_index_built: number }
		| undefined;
	return row;
}

describe("formula sync API (F4)", () => {
	const tempDirs: string[] = [];
	let db: Database.Database;

	afterEach(() => {
		db?.close();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(): { kbId: string; kb2Id: string } {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-formulas-"));
		tempDirs.push(dir);
		db = openDatabase(dir);
		const kb = createKB(db, { name: "physics", source_type: "text" });
		const kb2 = createKB(db, { name: "other", source_type: "text" });
		return { kbId: kb.id, kb2Id: kb2.id };
	}

	it("replaces formula rows for a chunk deterministically and without duplicates", () => {
		const { kbId } = setup();
		const [chunkId] = insertChunks(db, kbId, [chunkInsert()]);
		expect(getKB(db, kbId)?.formula_index_built).toBe(0);

		replaceFormulasForChunk(db, kbId, chunkId, [E_MC2, INT]);

		const rows = db.prepare("SELECT * FROM formulas WHERE chunk_id = ? ORDER BY ordinal").all(chunkId) as Array<{
			id: string;
			ordinal: number;
			raw: string;
			normalized: string;
			content_tokenized: string;
			token_count: number;
		}>;
		expect(rows).toHaveLength(2);
		expect(rows[0].ordinal).toBe(E_MC2.ordinal);
		expect(rows[0].raw).toBe(E_MC2.raw);
		expect(rows[0].normalized).toBe(E_MC2.normalized);
		expect(rows[0].content_tokenized).toBe(E_MC2.normalized);
		expect(rows[0].token_count).toBe(E_MC2.tokenCount);
		expect(rows[0].id).toBe(
			createHash("sha256").update(`${kbId}\0${chunkId}\0${E_MC2.ordinal}\0${E_MC2.normalized}`).digest("hex"),
		);
		expect(rows[1].id).toBe(
			createHash("sha256").update(`${kbId}\0${chunkId}\0${INT.ordinal}\0${INT.normalized}`).digest("hex"),
		);

		// Re-replace with identical rows: no duplicates.
		replaceFormulasForChunk(db, kbId, chunkId, [E_MC2, INT]);
		expect(formulaCount(db, kbId)).toBe(2);
		expect(findExactFormulas(db, kbId, [E_MC2.normalized])).toEqual([
			{ chunk_id: chunkId, normalized: E_MC2.normalized },
		]);

		// Replace with a different set: old rows are gone.
		replaceFormulasForChunk(db, kbId, chunkId, [E_MC2]);
		const normalizedRows = db.prepare("SELECT normalized FROM formulas WHERE chunk_id = ?").all(chunkId) as Array<{
			normalized: string;
		}>;
		expect(normalizedRows).toEqual([{ normalized: E_MC2.normalized }]);

		// Replace with an empty list: rows are cleared.
		replaceFormulasForChunk(db, kbId, chunkId, []);
		expect(formulaCount(db, kbId)).toBe(0);
		expect(searchFormulasFTS(db, kbId, '"mc"', 10)).toEqual([]);
	});

	it("scopes exact lookups to the kb and handles empty input", () => {
		const { kbId, kb2Id } = setup();
		const [chunk1] = insertChunks(db, kbId, [chunkInsert()]);
		const [chunk2] = insertChunks(db, kb2Id, [chunkInsert()]);
		replaceFormulasForChunk(db, kbId, chunk1, [E_MC2]);
		replaceFormulasForChunk(db, kb2Id, chunk2, [E_MC2]);

		const scoped = findExactFormulas(db, kbId, [E_MC2.normalized, "nope"]);
		expect(scoped).toEqual([{ chunk_id: chunk1, normalized: E_MC2.normalized }]);
		expect(findExactFormulas(db, kbId, [])).toEqual([]);
	});

	it("deletes formula rows for chunks and keeps FTS in sync", () => {
		const { kbId } = setup();
		const [chunk1] = insertChunks(db, kbId, [chunkInsert()]);
		const [chunk2] = insertChunks(db, kbId, [chunkInsert()]);
		replaceFormulasForChunk(db, kbId, chunk1, [E_MC2]);
		replaceFormulasForChunk(db, kbId, chunk2, [INT]);
		expect(formulaCount(db, kbId)).toBe(2);

		deleteFormulasForChunks(db, [chunk1]);
		expect(formulaCount(db, kbId)).toBe(1);
		expect(searchFormulasFTS(db, kbId, '"mc"', 10)).toEqual([]);
		expect(searchFormulasFTS(db, kbId, '"int"', 10)).toHaveLength(1);

		deleteFormulasForChunks(db, []);
		expect(formulaCount(db, kbId)).toBe(1);
	});

	it("marks the kb formula index as built", () => {
		const { kbId, kb2Id } = setup();
		expect(getKB(db, kbId)?.formula_index_built).toBe(0);
		markFormulaIndexBuilt(db, kbId);
		expect(getKB(db, kbId)?.formula_index_built).toBe(1);
		expect(getKB(db, kb2Id)?.formula_index_built).toBe(0);
	});

	it("lists chunks with metadata for backfill across kbs", () => {
		const { kbId, kb2Id } = setup();
		const metadata = JSON.stringify({ formulas: ["$$a + b$$"] });
		const [chunk1] = insertChunks(db, kbId, [chunkInsert({ metadata_json: metadata })]);
		const [chunk2] = insertChunks(db, kb2Id, [chunkInsert()]);

		const rows = listChunksForFormulaBackfill(db);
		expect(rows).toHaveLength(2);
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get(chunk1)).toEqual({ id: chunk1, kb_id: kbId, metadata_json: metadata });
		expect(byId.get(chunk2)).toEqual({
			id: chunk2,
			kb_id: kb2Id,
			metadata_json: JSON.stringify({ formulas: [E_MC2.raw] }),
		});
	});

	it("searches formulas via FTS with rank order and kb scoping", () => {
		const { kbId, kb2Id } = setup();
		const [chunkA] = insertChunks(db, kbId, [chunkInsert()]);
		const [chunkB] = insertChunks(db, kbId, [chunkInsert()]);
		const [chunkC] = insertChunks(db, kb2Id, [chunkInsert()]);
		replaceFormulasForChunk(db, kbId, chunkA, [E_MC2]);
		replaceFormulasForChunk(db, kbId, chunkB, [INT]);
		replaceFormulasForChunk(db, kb2Id, chunkC, [E_MC2]);

		const results = searchFormulasFTS(db, kbId, '"mc" OR "int"', 10);
		expect(results.map((row) => row.chunk_id).sort()).toEqual([chunkA, chunkB].sort());
		expect(results.map((row) => row.rank)).toEqual([1, 2]);
		for (const row of results) {
			expect(typeof row.normalized).toBe("string");
			expect(row.normalized.length).toBeGreaterThan(0);
		}

		expect(searchFormulasFTS(db, kbId, '"mc" OR "int"', 1)).toHaveLength(1);
		expect(searchFormulasFTS(db, kb2Id, '"mc"', 10)).toEqual([
			{ chunk_id: chunkC, normalized: E_MC2.normalized, rank: 1 },
		]);
		expect(searchFormulasFTS(db, kbId, "", 10)).toEqual([]);
	});

	it("never executes raw ftsQuery text as FTS syntax", () => {
		const { kbId } = setup();
		const [chunkId] = insertChunks(db, kbId, [chunkInsert()]);
		replaceFormulasForChunk(db, kbId, chunkId, [E_MC2]);

		const hostile = 'mc" NOT (x y) NEAR OR --';
		let results: Array<{ chunk_id: string; normalized: string; rank: number }> = [];
		expect(() => {
			results = searchFormulasFTS(db, kbId, hostile, 10);
		}).not.toThrow();
		// Reduced to a quoted phrase: no NOT/NEAR/OR syntax executed, no match for the full phrase.
		expect(results).toEqual([]);

		const injection = '"; DROP TABLE formulas; --';
		expect(() => searchFormulasFTS(db, kbId, injection, 10)).not.toThrow();
		expect(tableNames(db, "table").has("formulas")).toBe(true);
		expect(formulaCount(db, kbId)).toBe(1);
	});

	it("removes formula rows when the kb is deleted", () => {
		const { kbId, kb2Id } = setup();
		const [chunkId] = insertChunks(db, kbId, [chunkInsert()]);
		const [chunk2] = insertChunks(db, kb2Id, [chunkInsert()]);
		replaceFormulasForChunk(db, kbId, chunkId, [E_MC2, INT]);
		replaceFormulasForChunk(db, kb2Id, chunk2, [E_MC2]);

		deleteKB(db, kbId);

		expect(formulaCount(db, kbId)).toBe(0);
		expect(formulaCount(db, kb2Id)).toBe(1);
		expect(findExactFormulas(db, kbId, [E_MC2.normalized])).toEqual([]);
		expect(getKB(db, kbId)).toBeUndefined();
	});
});
