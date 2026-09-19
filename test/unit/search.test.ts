import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveVectors } from "../../src/embedding/vectors.ts";
import { contentHash, preTokenizeForFTS } from "../../src/indexer/chunker.ts";
import { searchBM25 } from "../../src/search/bm25.ts";
import { weightedScoreFusion } from "../../src/search/fusion.ts";
import { searchVector, searchVectorFile } from "../../src/search/vector.ts";
import { createKB, getChunkIdsByKB, insertChunks, openDatabase } from "../../src/storage/sqlite.ts";

let TEST_DIR: string;

describe("search pipeline", () => {
	let db: Database.Database;
	let chunkIds: string[];

	beforeEach(() => {
		TEST_DIR = mkdtempSync(join(tmpdir(), "pk-test-search-"));
		db = openDatabase(TEST_DIR);
		const kb = createKB(db, { name: "test", source_type: "text" });
		const texts = [
			"SQLite FTS5 full-text search",
			"Vector embeddings semantic",
			"認證流程 OAuth token",
			"React useState state",
		];
		insertChunks(
			db,
			kb.id,
			texts.map((t) => ({
				content_hash: contentHash(t),
				content: t,
				content_tokenized: preTokenizeForFTS(t),
				file_path: "t.md",
				file_type: "markdown",
				start_line: 1,
				end_line: 1,
				metadata_json: "{}",
			})),
		);
		chunkIds = getChunkIdsByKB(db, kb.id);
	});

	afterEach(() => {
		db.close();
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	describe("BM25", () => {
		it("finds exact terms", () => expect(searchBM25(db, "OAuth token").length).toBe(1));
		it("finds CJK", () => expect(searchBM25(db, "認證").length).toBe(1));
		it("no match → empty", () => expect(searchBM25(db, "zzzzz")).toEqual([]));
		it("empty query → empty", () => expect(searchBM25(db, "")).toEqual([]));
		it("breaks bm25 score ties by insertion order (rowid secondary sort)", () => {
			const tieKb = createKB(db, { name: "tie", source_type: "text" });
			const tieIds = insertChunks(
				db,
				tieKb.id,
				[1, 2, 3].map((n) => ({
					content_hash: contentHash(`tie anchor ${n}`),
					content: `tie anchor ${n}`,
					content_tokenized: preTokenizeForFTS(`tie anchor ${n}`),
					file_path: "tie.md",
					file_type: "markdown",
					start_line: n,
					end_line: n,
					metadata_json: "{}",
				})),
			);
			// Identical term frequencies → identical bm25 → the rowid tiebreak must keep
			// insertion order (reverting to bare ORDER BY bm25 makes tie order arbitrary).
			const results = searchBM25(db, "tie anchor");
			expect(results.map((r) => r.chunkId)).toEqual(tieIds);
		});

		it("returns relevance scores where higher is better", () => {
			const results = searchBM25(db, "OAuth token");
			expect(results[0].score).toBeGreaterThan(0);
		});
	});

	describe("Vector search", () => {
		it("top-K sorted", () => {
			const q = new Float32Array([1, 0, 0, 0]);
			const vecs = [
				new Float32Array([0.9, 0.1, 0, 0]),
				new Float32Array([0, 1, 0, 0]),
				new Float32Array([0.5, 0.5, 0, 0]),
				new Float32Array([0.8, 0.2, 0, 0]),
			];
			const r = searchVector(q, vecs, chunkIds, 2);
			expect(r.length).toBe(2);
			expect(r[0].score).toBeGreaterThan(r[1].score);
		});
		it("empty → empty", () => expect(searchVector(new Float32Array([1]), [], [], 10)).toEqual([]));
		it("streams top-K from a vector file without loading every vector into the result map", () => {
			const q = new Float32Array([1, 0, 0, 0]);
			const vectorPath = `${TEST_DIR}/vectors.bin`;
			saveVectors(vectorPath, [
				new Float32Array([0.9, 0.1, 0, 0]),
				new Float32Array([0, 1, 0, 0]),
				new Float32Array([0.5, 0.5, 0, 0]),
				new Float32Array([0.8, 0.2, 0, 0]),
			]);

			const r = searchVectorFile(q, vectorPath, chunkIds, 2);

			expect(r.results).toHaveLength(2);
			expect(r.results[0].score).toBeGreaterThan(r.results[1].score);
			expect(r.vectorsByChunkId.size).toBe(2);
			expect(r.vectorsByChunkId.has(r.results[0].chunkId)).toBe(true);
		});
		it("accepts streamed chunk id rows from storage", () => {
			const q = new Float32Array([1, 0, 0, 0]);
			const vectorPath = `${TEST_DIR}/vectors-row-iterator.bin`;
			saveVectors(vectorPath, [
				new Float32Array([0, 1, 0, 0]),
				new Float32Array([0.95, 0.05, 0, 0]),
				new Float32Array([0.2, 0.8, 0, 0]),
			]);
			const streamedRows = chunkIds.slice(0, 3).map((id) => ({ id }));

			const r = searchVectorFile(q, vectorPath, streamedRows, 1);

			expect(r.results).toHaveLength(1);
			expect(r.results[0].chunkId).toBe(chunkIds[1]);
			expect(r.vectorsByChunkId.size).toBe(1);
		});
	});

	describe("weighted fusion", () => {
		it("preserves score spread from lexical and vector channels", () => {
			const fused = weightedScoreFusion(
				[
					{ chunkId: "a", score: 100 },
					{ chunkId: "b", score: 20 },
					{ chunkId: "c", score: 1 },
				],
				[
					{ chunkId: "a", score: 0.95 },
					{ chunkId: "b", score: 0.7 },
					{ chunkId: "c", score: 0.2 },
				],
			);

			expect(fused[0].chunkId).toBe("a");
			expect(fused[0].score - fused[2].score).toBeGreaterThan(0.5);
		});
	});
});
