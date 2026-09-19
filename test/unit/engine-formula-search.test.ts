// Engine-level formula retrieval tests (Layer 3, spec §5 criteria F4/F5/F6/F8 of
// docs/layer3-formula-retrieval-plan.md). The embedding model cache is pinned to the real
// knowledge dir's models (same pattern as pdf-sidecar.e2e) so the local model is reused
// instead of re-downloaded; one shared engine + knowledge dir per file, isolation via
// distinct KB names and kb_id-scoped searches.
//
// F5 note (ratified via supervisor decision 2026-09-18): `$E=mc^{2}$` is always
// bm25-retrieved (the L1 metadata prefix indexes "E = mc pow2"), so it exercises the BOOST
// leg; `match_reason: "formula"` is asserted via the normalized-variant query
// `\mathrm{E}\!=\!mc^2` in fast mode, where the bm25 strict-AND provably misses. The plain
// boost baseline query is `e=mc^2`: it triggers no fusion (no `$…$` span, no TeX command)
// and yields bm25 terms identical to `$E=mc^{2}$` ({e=mc, pow2}), so the score delta
// isolates FORMULA_BOOST.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeEngine, kbTrustMultiplier, type SearchResponse, type SearchResult } from "../../src/engine.ts";
import { FORMULA_BOOST } from "../../src/search/ranking.ts";
import {
	type ChunkInsert,
	createKB,
	getDefaultKnowledgeDir,
	getKB,
	getKBByName,
	insertChunks,
	type KnowledgeBase,
	openDatabase,
	updateKBStatus,
} from "../../src/storage/sqlite.ts";

const USER_MODELS_DIR = join(getDefaultKnowledgeDir(), "models");

const E_MC2_NORMALIZED = "E = mc ^ 2";
const VARIANT_QUERY = "\\mathrm{E}\\!=\\!mc^2";

function firstResult(response: SearchResponse): SearchResult {
	const result = response.results[0];
	if (!result) throw new Error(`expected at least one result, got ${response.results.length}`);
	return result;
}

function expectNoFormulaReasons(response: SearchResponse): void {
	expect(response.results.every((result) => result.provenance?.match_reason !== "formula")).toBe(true);
}

let chunkCounter = 0;
function seededChunk(overrides: Partial<ChunkInsert> = {}): ChunkInsert {
	chunkCounter += 1;
	return {
		content_hash: `hash-${chunkCounter}`,
		content: "legacy body text",
		content_tokenized: "legacy body text",
		file_path: `seed/chunk-${chunkCounter}.md`,
		file_type: "markdown",
		start_line: 1,
		end_line: 2,
		metadata_json: JSON.stringify({ formulas: ["$$E = mc^2$$"] }),
		...overrides,
	};
}

describe("engine formula search", () => {
	let engine: KnowledgeEngine;
	let knowledgeDir: string;
	let workDir: string;

	function formulaRows(kbId: string): Array<{ chunk_id: string; ordinal: number; raw: string; normalized: string }> {
		const db = openDatabase(knowledgeDir);
		try {
			return db
				.prepare("SELECT chunk_id, ordinal, raw, normalized FROM formulas WHERE kb_id = ? ORDER BY rowid")
				.all(kbId) as Array<{ chunk_id: string; ordinal: number; raw: string; normalized: string }>;
		} finally {
			db.close();
		}
	}

	function kbFlag(kbId: string): number {
		const db = openDatabase(knowledgeDir);
		try {
			const built = getKB(db, kbId)?.formula_index_built;
			if (built === undefined) throw new Error(`kb not found: ${kbId}`);
			return built;
		} finally {
			db.close();
		}
	}

	function kbIdByName(name: string): string {
		const db = openDatabase(knowledgeDir);
		try {
			const kb = getKBByName(db, name);
			if (!kb) throw new Error(`kb not found: ${name}`);
			return kb.id;
		} finally {
			db.close();
		}
	}

	function getKbById(id: string): KnowledgeBase {
		const db = openDatabase(knowledgeDir);
		try {
			const kb = getKB(db, id);
			if (!kb) throw new Error(`kb not found: ${id}`);
			return kb;
		} finally {
			db.close();
		}
	}

	async function createSeededKb(name: string, chunks: ChunkInsert[]): Promise<{ kbId: string; chunkIds: string[] }> {
		const db = openDatabase(knowledgeDir);
		try {
			const kb = createKB(db, { name, source_type: "text" });
			const chunkIds = insertChunks(db, kb.id, chunks);
			return { kbId: kb.id, chunkIds };
		} finally {
			db.close();
		}
	}

	beforeAll(async () => {
		knowledgeDir = mkdtempSync(join(tmpdir(), "pk-engine-formula-kb-"));
		workDir = mkdtempSync(join(tmpdir(), "pk-engine-formula-work-"));
		// Pin the model cache before any engine work so the local embedding model is reused.
		process.env.PI_KNOWLEDGE_DIR = knowledgeDir;
		process.env.PI_KNOWLEDGE_MODEL_CACHE_DIR = USER_MODELS_DIR;
		engine = new KnowledgeEngine();
		await engine.initialize(knowledgeDir);
	});

	afterAll(async () => {
		await engine.dispose();
		rmSync(knowledgeDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
		delete process.env.PI_KNOWLEDGE_DIR;
		delete process.env.PI_KNOWLEDGE_MODEL_CACHE_DIR;
	});

	describe("F4: backfill and lifecycle sync", () => {
		it("backfills formula rows for pre-existing chunks, marks built, and is a no-op on re-run", async () => {
			const { kbId, chunkIds } = await createSeededKb("F4Legacy", [
				seededChunk(),
				seededChunk({ file_path: "seed/plain.md", metadata_json: "{}" }),
			]);
			expect(kbFlag(kbId)).toBe(0);

			// Seeded content is lexically inert, so any hit must come from the formula index.
			const response = await engine.search("$E=mc^{2}$", { mode: "fast", kb_id: kbId, limit: 5 });

			const rows = formulaRows(kbId);
			expect(rows).toHaveLength(1);
			expect(rows[0].chunk_id).toBe(chunkIds[0]);
			expect(rows[0].raw).toBe("$$E = mc^2$$");
			expect(rows[0].normalized).toBe(E_MC2_NORMALIZED);
			expect(kbFlag(kbId)).toBe(1);

			const injected = response.results.find((result) => result.provenance?.match_reason === "formula");
			expect(injected?.provenance?.chunk_id).toBe(chunkIds[0]);

			await engine.search("$E=mc^{2}$", { mode: "fast", kb_id: kbId, limit: 5 });
			expect(formulaRows(kbId)).toHaveLength(1);
		});

		it("add writes rows once, add-unchanged does not duplicate, update-delete removes rows", async () => {
			const source = join(workDir, "f4-sync.md");
			writeFileSync(source, "# Sync notes\n\nA famous law:\n\n$$E = mc^2$$\n\nEnergy prose.\n");
			const { kb } = await engine.add(source, "F4Sync");
			expect(kbFlag(kb.id)).toBe(1);
			expect(formulaRows(kb.id)).toHaveLength(1);

			const unchanged = await engine.update("F4Sync");
			expect(unchanged.unchanged).toBeGreaterThan(0);
			expect(unchanged.added).toBe(0);
			expect(formulaRows(kb.id)).toHaveLength(1);

			writeFileSync(source, "# Sync notes rewritten\n\nDifferent prose about tomatoes and sunlight only.\n");
			const removed = await engine.update("F4Sync");
			expect(removed.removed).toBeGreaterThan(0);
			expect(formulaRows(kb.id)).toHaveLength(0);
		});
	});

	describe("F5: search fusion", () => {
		let physicsChunkId = "";

		it("boosts the already-retrieved chunk by exactly FORMULA_BOOST with golden determinism", async () => {
			const fixtureDir = join(workDir, "f5-fixture");
			mkdirSync(fixtureDir, { recursive: true });
			writeFileSync(
				join(fixtureDir, "physics.md"),
				"# Physics notes\n\nMass-energy equivalence relates rest mass and energy through a famous physical law.\n\n$$E = mc^2$$\n\nIt connects energy, mass, and the speed of light in vacuum.\n",
			);
			writeFileSync(
				join(fixtureDir, "gardening.md"),
				"# Gardening notes\n\nTomatoes need sunlight and water. Pruning keeps plants healthy through the season.\n",
			);
			const { kb } = await engine.add(fixtureDir, "F5KB");

			// Plain baseline: identical bm25 terms as the formula query, but no fusion (no `$…$`
			// span, no TeX command), so its score is the un-boosted golden base.
			const plain = firstResult(await engine.search("e=mc^2", { mode: "fast", kb_id: kb.id, limit: 5 }));
			physicsChunkId = plain.provenance?.chunk_id ?? "";
			expect(physicsChunkId).not.toBe("");
			expect(plain.file_path).toBe("physics.md");
			expect(plain.provenance?.match_reason).toBe("bm25");

			const boostedResponse = await engine.search("$E=mc^{2}$", { mode: "fast", kb_id: kb.id, limit: 5 });
			const boosted = firstResult(boostedResponse);
			expect(boosted.provenance?.chunk_id).toBe(physicsChunkId);
			expect(boosted.provenance?.match_reason).toBe("bm25");
			expectNoFormulaReasons(boostedResponse);
			expect(boosted.score - plain.score).toBeCloseTo(FORMULA_BOOST, 10);
			// Diagnostics contract: adjusted_score tracks the final (boost-included) published
			// score, and retrieved diagnostics are not marked injected.
			expect(boosted.ranking?.adjusted_score).toBeCloseTo(boosted.score, 10);
			expect((boosted.ranking as Record<string, unknown> | undefined)?.injected).toBeUndefined();
		});

		it("injects the formula chunk via a normalized variant query with match_reason formula", async () => {
			const kbId = kbIdByName("F5KB");
			const response = await engine.search(VARIANT_QUERY, { mode: "fast", kb_id: kbId, limit: 5 });
			const injected = firstResult(response);
			expect(injected.provenance?.match_reason).toBe("formula");
			expect(injected.provenance?.chunk_id).toBe(physicsChunkId);
			expect(injected.file_path).toBe("physics.md");
			// Exact formula evidence scores 1.0, times the kb trust factor applied to retrieved legs.
			expect(injected.score).toBeCloseTo(kbTrustMultiplier(getKbById(kbId)), 10);
			expect(response.total_count).toBe(1);
			// Injected results carry ranking provenance marked injected, with adjusted_score pinned
			// to the published injected score.
			expect((injected.ranking as Record<string, unknown> | undefined)?.injected).toBe(true);
			expect(injected.ranking?.adjusted_score).toBeCloseTo(injected.score, 10);
		});

		it("no-math query: golden top chunk and score are deterministic with zero formula reasons", async () => {
			const kbId = kbIdByName("F5KB");
			const run1 = await engine.search("mass energy equivalence speed of light", {
				mode: "hybrid",
				kb_id: kbId,
				limit: 5,
			});
			const run2 = await engine.search("mass energy equivalence speed of light", {
				mode: "hybrid",
				kb_id: kbId,
				limit: 5,
			});
			const top1 = firstResult(run1);
			const top2 = firstResult(run2);
			expect(top1.provenance?.chunk_id).toBe(physicsChunkId);
			expect(top2.provenance?.chunk_id).toBe(physicsChunkId);
			expect(top2.score).toBe(top1.score);
			expectNoFormulaReasons(run1);
			expectNoFormulaReasons(run2);
		});
	});

	describe("F6: injection respects kb_id and file_type filters", () => {
		it("scopes injected results by kb_id, file_type, and the 5-result cap", async () => {
			const kbA = await createSeededKb("F6A", [
				seededChunk({ file_path: "notes.md", file_type: "markdown" }),
				seededChunk({
					file_path: "calc.py",
					file_type: "python",
					content: "def calc(): pass",
					content_tokenized: "def calc pass",
				}),
			]);
			const kbB = await createSeededKb("F6B", [seededChunk({ file_path: "other.md" })]);
			const kbCap = await createSeededKb(
				"F6Cap",
				Array.from({ length: 7 }, () => seededChunk()),
			);

			const scopedA = await engine.search(VARIANT_QUERY, { mode: "fast", kb_id: kbA.kbId, limit: 10 });
			expect(scopedA.results.map((result) => result.provenance?.chunk_id).sort()).toEqual([...kbA.chunkIds].sort());
			expect(scopedA.results.every((result) => result.provenance?.match_reason === "formula")).toBe(true);

			const mdOnly = await engine.search(VARIANT_QUERY, {
				mode: "fast",
				kb_id: kbA.kbId,
				filters: { file_type: "markdown" },
				limit: 10,
			});
			expect(mdOnly.results.map((result) => result.provenance?.chunk_id)).toEqual([kbA.chunkIds[0]]);

			const pyOnly = await engine.search(VARIANT_QUERY, {
				mode: "fast",
				kb_id: kbA.kbId,
				filters: { file_type: "python" },
				limit: 10,
			});
			expect(pyOnly.results.map((result) => result.provenance?.chunk_id)).toEqual([kbA.chunkIds[1]]);

			const scopedB = await engine.search(VARIANT_QUERY, { mode: "fast", kb_id: kbB.kbId, limit: 10 });
			expect(scopedB.results.map((result) => result.provenance?.chunk_id)).toEqual(kbB.chunkIds);

			const capped = await engine.search(VARIANT_QUERY, { mode: "fast", kb_id: kbCap.kbId, limit: 10 });
			expect(capped.results).toHaveLength(5);
			expect(capped.results.every((result) => result.provenance?.match_reason === "formula")).toBe(true);
		});

		it("injects filter-passing matches beyond the top-5 when higher-ranked candidates fail the filter", async () => {
			// Ranks 1-5 hold exact-match markdown chunks (formulaScore 1.0); the python chunk only
			// fuzzy-matches the query (formulaScore < 1.0), so it sits at rank 6. With
			// file_type=python the pre-fix cap-then-filter order sliced the top-5 (all markdown)
			// and injected nothing; filter-first ordering must inject the rank-6 chunk instead.
			const chunks = Array.from({ length: 5 }, () => seededChunk());
			chunks.push(
				seededChunk({
					file_path: "calc.py",
					file_type: "python",
					content: "def calc(): pass",
					content_tokenized: "def calc pass",
					metadata_json: JSON.stringify({ formulas: ["$E=mc^{3}$"] }),
				}),
			);
			const { kbId, chunkIds } = await createSeededKb("F6Underfill", chunks);
			const pythonChunkId = chunkIds[5];
			if (!pythonChunkId) throw new Error("expected 6 seeded chunks");

			const response = await engine.search(VARIANT_QUERY, {
				mode: "fast",
				kb_id: kbId,
				filters: { file_type: "python" },
				limit: 10,
			});

			expect(response.results).toHaveLength(1);
			expect(response.results[0]?.provenance?.match_reason).toBe("formula");
			expect(response.results[0]?.provenance?.chunk_id).toBe(pythonChunkId);
		});
	});

	describe("injected formula scores apply the kb trust multiplier", () => {
		it("multiplies injected scores by kbTrustMultiplier: stale kb below ready baseline", async () => {
			const { kbId, chunkIds } = await createSeededKb("F6TrustReady", [seededChunk()]);
			const chunkId = chunkIds[0];
			if (!chunkId) throw new Error("expected 1 seeded chunk");

			const ready = await engine.search(VARIANT_QUERY, { mode: "fast", kb_id: kbId, limit: 5 });
			const readyInjected = firstResult(ready);
			expect(readyInjected.provenance?.chunk_id).toBe(chunkId);
			expect(readyInjected.provenance?.match_reason).toBe("formula");
			// Exact formula evidence (1.0) × the same trust factor every retrieved leg applies.
			expect(readyInjected.score).toBeCloseTo(kbTrustMultiplier(getKbById(kbId)), 10);

			// Search skips non-ready KBs entirely, so "stale" is the non-ready state reachable here.
			const db = openDatabase(knowledgeDir);
			try {
				updateKBStatus(db, kbId, "stale");
			} finally {
				db.close();
			}

			const stale = await engine.search(VARIANT_QUERY, { mode: "fast", kb_id: kbId, limit: 5 });
			const staleInjected = firstResult(stale);
			expect(staleInjected.provenance?.chunk_id).toBe(chunkId);
			expect(staleInjected.provenance?.match_reason).toBe("formula");
			expect(staleInjected.score).toBeCloseTo(kbTrustMultiplier(getKbById(kbId)), 10);
			expect(staleInjected.score).toBeLessThan(readyInjected.score);
		});
	});

	describe("F8: resilience on formula-free and empty indexes", () => {
		it("formula query on a formula-free kb degrades to plain results without crashing", async () => {
			const { kb } = await engine.add(
				"Authentication tokens rotate hourly and refresh tokens persist for devices.",
				"F8KB",
			);
			expect((await engine.search("tokens", { mode: "fast", kb_id: kb.id })).results.length).toBeGreaterThan(0);

			const response = await engine.search("$\\int_0^\\infty e^{-x^2}dx$", {
				mode: "fast",
				kb_id: kb.id,
				limit: 5,
			});
			expect(Array.isArray(response.results)).toBe(true);
			expectNoFormulaReasons(response);
			expect(kbFlag(kb.id)).toBe(1);
		});

		it("formula query against a zero-chunk kb returns empty results without crashing", async () => {
			const { kbId } = await createSeededKb("F8Empty", []);
			const response = await engine.search("$x^2$", { mode: "fast", kb_id: kbId });
			expect(response.results).toEqual([]);
		});
	});
});
