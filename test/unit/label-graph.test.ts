import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeEngine, kbTrustMultiplier } from "../../src/engine.ts";
import { chunkLaTeX } from "../../src/indexer/chunker.ts";
import { resolveLabelTarget } from "../../src/indexer/label-resolve.ts";
import { extractTexRefs, MAX_REFS } from "../../src/indexer/math-text.ts";
import { DEPENDENCY_BOOST } from "../../src/search/ranking.ts";
import {
	type ChunkInsert,
	createKB,
	deleteKB,
	deleteLabelEdgesForChunks,
	findResolvedLabelEdges,
	getDefaultKnowledgeDir,
	getKB,
	insertChunks,
	type KnowledgeBase,
	listChunksForLabelBackfill,
	markLabelGraphBuilt,
	openDatabase,
	replaceLabelEdgesForChunk,
	updateKBCounts,
} from "../../src/storage/sqlite.ts";

const USER_MODELS_DIR = join(getDefaultKnowledgeDir(), "models");

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
		metadata_json: "{}",
		...overrides,
	};
}

describe("extractTexRefs", () => {
	it("captures all five ref macros including mixed-case Cref", () => {
		const text = "\\ref{eq:a} and \\eqref{eq:b} plus \\cref{sec:c}, \\Cref{fig:d}, \\autoref{app:e}.";
		expect(extractTexRefs(text)).toEqual(["eq:a", "eq:b", "sec:c", "fig:d", "app:e"]);
	});

	it("is case-sensitive: cref and Cref are both matched, targets kept verbatim", () => {
		expect(extractTexRefs("\\cref{fig:one} \\Cref{fig:one}")).toEqual(["fig:one"]);
		expect(extractTexRefs("\\Cref{Fig:One} \\cref{fig:one}")).toEqual(["Fig:One", "fig:one"]);
	});

	it("dedupes while preserving first-occurrence order", () => {
		expect(extractTexRefs("\\ref{b} \\ref{a} \\eqref{b} \\autoref{a} \\cref{c}")).toEqual(["b", "a", "c"]);
	});

	it("caps at MAX_REFS (40)", () => {
		const text = Array.from({ length: 45 }, (_, i) => `\\ref{r${i}}`).join(" ");
		const refs = extractTexRefs(text);
		expect(refs).toHaveLength(MAX_REFS);
		expect(refs[0]).toBe("r0");
		expect(refs[MAX_REFS - 1]).toBe("r39");
	});

	it("returns empty for text without refs and ignores labels", () => {
		expect(extractTexRefs("\\label{eq:x} plain text without any reference macro")).toEqual([]);
		expect(extractTexRefs("")).toEqual([]);
	});
});

describe("resolveLabelTarget", () => {
	it("resolves a same-file hit", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/a.tex"]);
		expect(r.status).toBe("resolved");
		expect(r.targetPath).toBe("docs/a.tex");
	});

	it("prefers a same-file hit over out-of-file definitions", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/b.tex", "docs/a.tex"]);
		expect(r.status).toBe("resolved");
		expect(r.targetPath).toBe("docs/a.tex");
	});

	it("resolves a unique cross-file hit", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/b.tex"]);
		expect(r.status).toBe("resolved");
		expect(r.targetPath).toBe("docs/b.tex");
	});

	it("stays unresolved on collision (label defined in more than one other file)", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/b.tex", "docs/c.tex"]);
		expect(r.status).toBe("unresolved");
		expect(r.targetPath).toBeNull();
	});

	it("stays unresolved when the label has no defining file", () => {
		expect(resolveLabelTarget("docs/a.tex", "eq:missing", []).status).toBe("unresolved");
		expect(resolveLabelTarget("docs/a.tex", "eq:missing", ["docs/b.tex", "docs/c.tex", "docs/d.tex"]).status).toBe(
			"unresolved",
		);
	});

	it("never guesses: empty label stays unresolved even with candidates", () => {
		const r = resolveLabelTarget("docs/a.tex", "  ", ["docs/a.tex"]);
		expect(r.status).toBe("unresolved");
		expect(r.targetPath).toBeNull();
	});

	it("scope-key is sha256(relPath + NUL + label), distinct per referencing file", () => {
		const expected = createHash("sha256").update("docs/a.tex\0eq:x").digest("hex");
		const inA = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/a.tex"]);
		const fromB = resolveLabelTarget("docs/b.tex", "eq:x", ["docs/a.tex"]);
		expect(inA.scopeKey).toBe(expected);
		expect(inA.scopeKey).not.toBe(fromB.scopeKey);
		expect(fromB.scopeKey).toBe(createHash("sha256").update("docs/b.tex\0eq:x").digest("hex"));
	});
});

describe("chunker metadata.refs threading", () => {
	const tex = [
		"\\documentclass{article}",
		"",
		"Preamble context paragraph with enough content to pass the fifty character minimum threshold.",
		"",
		"\\section{Derivation}",
		"",
		"Body paragraph with enough content to pass the fifty character minimum threshold here.",
		"",
		"\\begin{equation}",
		"E = mc^2",
		"\\end{equation}",
		"\\label{eq:main}",
		"As \\ref{eq:other} and \\eqref{eq:third} show, \\cref{fig:one} agrees with \\Cref{fig:one}.",
		"\\end{document}",
	].join("\n");

	it("writes metadata.refs alongside labels and both coexist on the same chunk", () => {
		const chunks = chunkLaTeX(tex, "paper.tex");
		const labeled = chunks.find((chunk) => chunk.metadata_json.includes('"labels"'));
		if (!labeled) throw new Error("expected a labeled latex chunk");
		const metadata = JSON.parse(labeled.metadata_json) as { labels?: string[]; refs?: string[] };
		expect(metadata.labels).toEqual(["eq:main"]);
		expect(metadata.refs).toEqual(["eq:other", "eq:third", "fig:one"]);
	});

	it("omits the refs key when a section references nothing", () => {
		const chunks = chunkLaTeX(
			[
				"\\documentclass{article}",
				"",
				"Preamble context paragraph with enough content to pass the fifty character minimum threshold.",
				"",
				"\\section{Plain}",
				"",
				"Section body paragraph with enough content to pass the fifty character minimum threshold.",
				"",
				"\\label{eq:only} and a closing line with enough content to pass the fifty character limit.",
				"\\end{document}",
			].join("\n"),
			"plain.tex",
		);
		const labeled = chunks.find((chunk) => chunk.metadata_json.includes('"labels"'));
		if (!labeled) throw new Error("expected a labeled latex chunk");
		const metadata = JSON.parse(labeled.metadata_json) as { refs?: string[] };
		expect(metadata.refs).toBeUndefined();
	});
});

describe("label graph schema v8 (F7)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("creates schema version 8 with label_edges table, indexes, and label_graph_built flag column", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-label-graph-"));
		tempDirs.push(dir);
		const db = openDatabase(dir);
		try {
			expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 8 });

			const objects = (kind: string) =>
				new Set(
					(db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(kind) as Array<{ name: string }>).map(
						(row) => row.name,
					),
				);
			expect(objects("table").has("label_edges")).toBe(true);
			expect(objects("index").has("idx_label_edges_kb_src")).toBe(true);
			expect(objects("index").has("idx_label_edges_kb_scope")).toBe(true);

			const columns = db.prepare("PRAGMA table_info(label_edges)").all() as Array<{ name: string; notnull: number }>;
			const names = columns.map((column) => column.name);
			expect(names).toEqual([
				"id",
				"kb_id",
				"src_chunk_id",
				"target_label",
				"scope_key",
				"resolved_chunk_id",
				"target_content_hash",
				"kind",
				"indexed_at",
			]);
			const resolved = columns.find((column) => column.name === "resolved_chunk_id");
			const targetHash = columns.find((column) => column.name === "target_content_hash");
			expect(resolved?.notnull).toBe(0);
			expect(targetHash?.notnull).toBe(0);

			const kbColumns = db.prepare("PRAGMA table_info(knowledge_bases)").all() as Array<{
				name: string;
				notnull: number;
				dflt_value: string | null;
			}>;
			const flag = kbColumns.find((column) => column.name === "label_graph_built");
			expect(flag?.notnull).toBe(1);
			expect(flag?.dflt_value).toBe("0");
		} finally {
			db.close();
		}
	});

	it("migrates a v6 database additively through v7 to v8 and preserves chunk data", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-label-graph-"));
		tempDirs.push(dir);

		// Build a fresh v7 database, then downgrade it to a v6-shaped one to exercise the path.
		{
			const db = openDatabase(dir);
			try {
				const kb = createKB(db, { name: "legacy", source_type: "text" });
				insertChunks(db, kb.id, [chunkInsert()]);
				db.exec(`
					DROP TABLE label_edges;
					ALTER TABLE knowledge_bases DROP COLUMN label_graph_built;
					UPDATE schema_version SET version = 6;
				`);
			} finally {
				db.close();
			}
		}

		const db = openDatabase(dir);
		try {
			expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 8 });
			expect(
				(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).some(
					(row) => row.name === "label_edges",
				),
			).toBe(true);
			const names = (db.prepare("PRAGMA table_info(knowledge_bases)").all() as Array<{ name: string }>).map(
				(column) => column.name,
			);
			expect(names).toContain("label_graph_built");
			const chunks = db.prepare("SELECT id FROM chunks").all() as Array<{ id: string }>;
			expect(chunks).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});

describe("label edge storage API", () => {
	const tempDirs: string[] = [];
	let db: Database.Database;

	afterEach(() => {
		db?.close();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(): { kbId: string; chunkId: string } {
		const dir = mkdtempSync(join(tmpdir(), "pk-label-graph-"));
		tempDirs.push(dir);
		db = openDatabase(dir);
		const kb = createKB(db, { name: "labels", source_type: "text" });
		const [chunkId] = insertChunks(db, kb.id, [chunkInsert()]);
		return { kbId: kb.id, chunkId };
	}

	it("writes edges with sha256(kb, chunk, scope) ids and replaces/clears per chunk", () => {
		const { kbId, chunkId } = setup();
		const edge = {
			targetLabel: "eq:flux",
			scopeKey: createHash("sha256").update("docs/a.md\0eq:flux").digest("hex"),
			resolvedChunkId: null,
			targetContentHash: null,
			kind: "ref" as const,
		};
		replaceLabelEdgesForChunk(db, kbId, chunkId, [edge]);

		const rows = db.prepare("SELECT * FROM label_edges ORDER BY rowid").all() as Array<{
			id: string;
			kb_id: string;
			src_chunk_id: string;
			target_label: string;
			scope_key: string;
			resolved_chunk_id: string | null;
			target_content_hash: string | null;
			kind: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(
			createHash("sha256").update(`${kbId}\0${chunkId}\0${edge.scopeKey}\0${edge.kind}`).digest("hex"),
		);
		expect(rows[0].kb_id).toBe(kbId);
		expect(rows[0].src_chunk_id).toBe(chunkId);
		expect(rows[0].target_label).toBe("eq:flux");
		expect(rows[0].resolved_chunk_id).toBeNull();
		expect(rows[0].target_content_hash).toBeNull();
		expect(rows[0].kind).toBe("ref");

		// Re-replace with an identical edge: no duplicates. Clear with []: rows gone.
		replaceLabelEdgesForChunk(db, kbId, chunkId, [edge]);
		expect((db.prepare("SELECT COUNT(*) as c FROM label_edges").get() as { c: number }).c).toBe(1);
		replaceLabelEdgesForChunk(db, kbId, chunkId, []);
		expect((db.prepare("SELECT COUNT(*) as c FROM label_edges").get() as { c: number }).c).toBe(0);
	});

	it("deletes edges for removed chunks and by kb, and marks the kb graph built", () => {
		const { kbId, chunkId } = setup();
		const kb2 = createKB(db, { name: "labels-2", source_type: "text" });
		const [chunk2] = insertChunks(db, kb2.id, [chunkInsert()]);
		const edge = {
			targetLabel: "eq:x",
			scopeKey: "scope",
			resolvedChunkId: null,
			targetContentHash: null,
			kind: "ref" as const,
		};
		replaceLabelEdgesForChunk(db, kbId, chunkId, [edge]);
		replaceLabelEdgesForChunk(db, kb2.id, chunk2, [edge]);

		deleteLabelEdgesForChunks(db, []);
		expect((db.prepare("SELECT COUNT(*) as c FROM label_edges").get() as { c: number }).c).toBe(2);
		deleteLabelEdgesForChunks(db, [chunkId]);
		expect((db.prepare("SELECT COUNT(*) as c FROM label_edges").get() as { c: number }).c).toBe(1);

		expect(getKB(db, kb2.id)?.label_graph_built).toBe(0);
		markLabelGraphBuilt(db, kb2.id);
		expect(getKB(db, kb2.id)?.label_graph_built).toBe(1);

		deleteKB(db, kb2.id);
		expect((db.prepare("SELECT COUNT(*) as c FROM label_edges").get() as { c: number }).c).toBe(0);
	});

	it("lists chunks scoped to the kb with metadata, path, and hash for backfill; resolves only resolved edges", () => {
		const { kbId, chunkId } = setup();
		const rows = listChunksForLabelBackfill(db, kbId);
		expect(rows).toEqual([
			{
				id: chunkId,
				kb_id: kbId,
				metadata_json: expect.any(String),
				file_path: "docs/physics.md",
				content_hash: expect.any(String),
			},
		]);
		// Other KBs are not scanned by a per-kb backfill.
		const otherKb = createKB(db, { name: "labels-other", source_type: "text" });
		expect(listChunksForLabelBackfill(db, otherKb.id)).toEqual([]);

		const target = {
			targetLabel: "eq:t",
			scopeKey: "scope-t",
			resolvedChunkId: chunkId,
			targetContentHash: "hash-target",
			kind: "ref" as const,
		};
		const unresolved = { ...target, targetLabel: "eq:missing", scopeKey: "scope-m", resolvedChunkId: null };
		replaceLabelEdgesForChunk(db, kbId, chunkId, [target, unresolved]);

		expect(findResolvedLabelEdges(db, [])).toEqual([]);
		expect(findResolvedLabelEdges(db, [chunkId])).toEqual([
			{
				src_chunk_id: chunkId,
				target_label: "eq:t",
				scope_key: "scope-t",
				resolved_chunk_id: chunkId,
				target_content_hash: "hash-target",
			},
		]);
		// The optional kbId filter scopes rows to one kb (idx_label_edges_kb_src).
		expect(findResolvedLabelEdges(db, [chunkId], kbId)).toHaveLength(1);
		expect(findResolvedLabelEdges(db, [chunkId], "kb-that-does-not-exist")).toEqual([]);
	});
});

describe("engine label graph backfill and dependency leg (F7/F8)", () => {
	let engine: KnowledgeEngine;
	let knowledgeDir: string;
	let workDir: string;

	function openDb(): Database.Database {
		return openDatabase(knowledgeDir);
	}

	function getKb(id: string): KnowledgeBase {
		const db = openDb();
		try {
			const kb = getKB(db, id);
			if (!kb) throw new Error(`kb not found: ${id}`);
			return kb;
		} finally {
			db.close();
		}
	}

	function labelFlag(kbId: string): number {
		return getKb(kbId).label_graph_built;
	}

	function edgeRows(kbId: string): Array<{
		src_chunk_id: string;
		target_label: string;
		resolved_chunk_id: string | null;
		target_content_hash: string | null;
		kind: string;
	}> {
		const db = openDb();
		try {
			return db
				.prepare(
					"SELECT src_chunk_id, target_label, resolved_chunk_id, target_content_hash, kind FROM label_edges WHERE kb_id = ? ORDER BY rowid",
				)
				.all(kbId) as Array<{
				src_chunk_id: string;
				target_label: string;
				resolved_chunk_id: string | null;
				target_content_hash: string | null;
				kind: string;
			}>;
		} finally {
			db.close();
		}
	}

	function chunkIdByFile(kbId: string, filePath: string): string {
		const db = openDb();
		try {
			const row = db.prepare("SELECT id FROM chunks WHERE kb_id = ? AND file_path = ?").get(kbId, filePath) as
				| { id: string }
				| undefined;
			if (!row) throw new Error(`chunk not found: ${filePath}`);
			return row.id;
		} finally {
			db.close();
		}
	}

	async function createSeededKb(name: string, chunks: ChunkInsert[]): Promise<{ kbId: string; chunkIds: string[] }> {
		const db = openDb();
		try {
			const kb = createKB(db, { name, source_type: "text" });
			const chunkIds = insertChunks(db, kb.id, chunks);
			// bm25 retrieval skips KBs with chunk_count 0; seeded KBs bypass the counting paths.
			updateKBCounts(db, kb.id, chunkIds.length, new Set(chunks.map((chunk) => chunk.file_path)).size);
			return { kbId: kb.id, chunkIds };
		} finally {
			db.close();
		}
	}

	function labeledChunk(overrides: Partial<ChunkInsert> = {}): ChunkInsert {
		return chunkInsert({
			file_path: `docs/chunk-${chunkCounter}.md`,
			file_type: "markdown",
			...overrides,
		});
	}

	beforeAll(async () => {
		knowledgeDir = mkdtempSync(join(tmpdir(), "pk-engine-label-kb-"));
		workDir = mkdtempSync(join(tmpdir(), "pk-engine-label-work-"));
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

	it("backfills edges from seeded labels/refs metadata on first search, flags built, idempotent", async () => {
		const { kbId } = await createSeededKb("F7Backfill", [
			labeledChunk({
				file_path: "docs/main.md",
				content: "gauss theorem overview",
				content_tokenized: "gauss theorem overview",
				metadata_json: JSON.stringify({ labels: ["eq:gauss"], refs: ["eq:flux"] }),
			}),
			labeledChunk({
				file_path: "docs/flux.md",
				content: "flux integral divergence theorem",
				content_tokenized: "flux integral divergence theorem",
				metadata_json: JSON.stringify({ labels: ["eq:flux"] }),
			}),
		]);
		expect(labelFlag(kbId)).toBe(0);

		const response = await engine.search("gauss theorem", { mode: "fast", kb_id: kbId, limit: 5 });
		expect(labelFlag(kbId)).toBe(1);
		const mainId = chunkIdByFile(kbId, "docs/main.md");
		const fluxId = chunkIdByFile(kbId, "docs/flux.md");
		expect(edgeRows(kbId)).toEqual([
			{
				src_chunk_id: mainId,
				target_label: "eq:flux",
				resolved_chunk_id: fluxId,
				target_content_hash: expect.any(String),
				kind: "ref",
			},
		]);

		const injected = response.results.find((result) => result.provenance?.match_reason === "dependency");
		expect(injected?.provenance?.chunk_id).toBe(fluxId);
		expect(injected?.score).toBeCloseTo(DEPENDENCY_BOOST * kbTrustMultiplier(getKb(kbId)), 10);
		const trigger = response.results.find((result) => result.provenance?.chunk_id === mainId);
		expect(trigger?.provenance?.depends_on).toEqual([{ label: "eq:flux", chunk_id: fluxId, pinned: true }]);

		// Re-search: no duplicate edges, still flagged.
		await engine.search("gauss theorem", { mode: "fast", kb_id: kbId, limit: 5 });
		expect(edgeRows(kbId)).toHaveLength(1);
	});

	it("add path builds edges from a LaTeX fixture immediately; update re-syncs changed refs", async () => {
		const fixtureDir = join(workDir, "latex-fixture");
		mkdirSync(fixtureDir, { recursive: true });
		const source = join(fixtureDir, "paper.tex");
		writeFileSync(
			source,
			[
				"\\documentclass{article}",
				"",
				"Preamble context paragraph with enough content to pass the fifty character minimum threshold.",
				"",
				"\\section{Derivation}",
				"",
				"\\begin{equation}",
				"E = mc^2",
				"\\end{equation}",
				"\\label{eq:main}",
				"The main result follows from the auxiliary estimate stated in \\ref{eq:aux} with extra words.",
				"",
				"\\section{Appendix}",
				"",
				"\\begin{equation}",
				"x + y = z",
				"\\end{equation}",
				"\\label{eq:aux}",
				"Auxiliary estimate body paragraph with enough content to pass the fifty character threshold.",
				"\\end{document}",
			].join("\n"),
		);
		const { kb } = await engine.add(fixtureDir, "F7LatexAdd");
		expect(labelFlag(kb.id)).toBe(1);
		const edges = edgeRows(kb.id);
		expect(edges).toHaveLength(1);
		expect(edges[0].target_label).toBe("eq:aux");
		expect(edges[0].resolved_chunk_id).not.toBeNull();
		expect(edges[0].kind).toBe("ref");

		writeFileSync(
			source,
			[
				"\\documentclass{article}",
				"",
				"Preamble context paragraph with enough content to pass the fifty character minimum threshold.",
				"",
				"\\section{Derivation}",
				"",
				"Plain revised body paragraph with enough content to pass the fifty character minimum limit.",
				"\\label{eq:main}",
				"The revised derivation no longer references the auxiliary estimate anywhere below here.",
				"\\end{document}",
			].join("\n"),
		);
		await engine.update("F7LatexAdd");
		expect(edgeRows(kb.id)).toEqual([]);
	}, 30000);

	it("F8: boosts an already-retrieved referenced chunk by exactly DEPENDENCY_BOOST vs a dormant twin", async () => {
		const chunkDefs = [
			{
				file_path: "docs/main.md",
				content: "shared topic marker alpha flux law",
				metadata: { labels: ["eq:gauss"], refs: ["eq:flux"] },
			},
			{
				file_path: "docs/flux.md",
				content: "shared topic marker beta flux law",
				metadata: { labels: ["eq:flux"], refs: [] },
			},
		];
		const active = await createSeededKb(
			"F8BoostActive",
			chunkDefs.map((def) =>
				labeledChunk({
					file_path: def.file_path,
					content: def.content,
					content_tokenized: def.content,
					metadata_json: JSON.stringify(def.metadata),
				}),
			),
		);
		const dormant = await createSeededKb(
			"F8BoostDormant",
			chunkDefs.map((def) =>
				labeledChunk({
					file_path: def.file_path,
					content: def.content,
					content_tokenized: def.content,
					// refs dropped entirely: KB has no unresolved-or-resolved edges
					metadata_json: JSON.stringify({ labels: def.metadata.labels }),
				}),
			),
		);

		const query = { mode: "fast" as const, limit: 5 };
		const activeResponse = await engine.search("shared topic marker flux law", {
			...query,
			kb_id: active.kbId,
		});
		const dormantResponse = await engine.search("shared topic marker flux law", {
			...query,
			kb_id: dormant.kbId,
		});

		const scoreOf = (response: typeof activeResponse, filePath: string): number => {
			const result = response.results.find((candidate) => candidate.file_path === filePath);
			if (!result) throw new Error(`no result for ${filePath}`);
			return result.score;
		};
		expect(activeResponse.results.map((result) => result.file_path).sort()).toEqual(["docs/flux.md", "docs/main.md"]);
		expect(scoreOf(activeResponse, "docs/main.md")).toBeCloseTo(scoreOf(dormantResponse, "docs/main.md"), 10);
		expect(scoreOf(activeResponse, "docs/flux.md") - scoreOf(dormantResponse, "docs/flux.md")).toBeCloseTo(
			DEPENDENCY_BOOST,
			10,
		);
		// Boosted retrieval keeps its lexical match_reason (formula-leg precedent).
		expect(activeResponse.results.every((result) => result.provenance?.match_reason !== "dependency")).toBe(true);
		// Diagnostics contract: adjusted_score tracks the final (boost-included) published score.
		const fluxResult = activeResponse.results.find((result) => result.file_path === "docs/flux.md");
		expect(fluxResult?.ranking?.adjusted_score).toBeCloseTo(scoreOf(activeResponse, "docs/flux.md"), 10);
		const mainResult = activeResponse.results.find((result) => result.file_path === "docs/main.md");
		expect(mainResult?.provenance?.depends_on).toEqual([
			{ label: "eq:flux", chunk_id: chunkIdByFile(active.kbId, "docs/flux.md"), pinned: true },
		]);
		// Dormant KB: no edges, no dependency provenance anywhere.
		expect(dormantResponse.results.every((result) => result.provenance?.depends_on === undefined)).toBe(true);
	});

	it("F8: a chunk injected by the formula leg is not re-injected as a dependency duplicate", async () => {
		const { kbId } = await createSeededKb("F8FormulaDependencyOverlap", [
			labeledChunk({
				file_path: "docs/main.md",
				// content_tokenized contains every pipeline token of the query below (for
				// \ce{H2SO4} that is ... ce ... h2so4 (the formula run collapses to one token on
				// both sides), so strict-AND bm25 retrieves this chunk: it is the dependency
				// TRIGGER (refs eq:aux).
				content: "shared topic marker alpha flux law ce h2so4",
				content_tokenized: "shared topic marker alpha flux law ce h2so4",
				metadata_json: JSON.stringify({ labels: ["eq:main"], refs: ["eq:aux"] }),
			}),
			labeledChunk({
				file_path: "docs/aux.md",
				// Lexically unrelated to the query (fast mode strict-AND misses), but carries
				// the queried formula, so the formula leg injects it outside the lexical top set.
				content: "auxiliary estimate body",
				content_tokenized: "auxiliary estimate body",
				metadata_json: JSON.stringify({ labels: ["eq:aux"], formulas: ["\\\\ce{H2SO4}"] }),
			}),
		]);

		const response = await engine.search("shared topic marker flux law \\ce{H2SO4}", {
			mode: "fast",
			limit: 5,
			kb_id: kbId,
		});

		const auxRows = response.results.filter((result) => result.file_path === "docs/aux.md");
		expect(auxRows).toHaveLength(1);
		expect(auxRows[0]?.provenance?.match_reason).toBe("formula");
		expect(response.results.filter((result) => result.file_path === "docs/main.md")).toHaveLength(1);
	});

	it("F8: unresolved edges are recorded with NULL targets, never guessed or injected", async () => {
		const { kbId } = await createSeededKb("F8Unresolved", [
			labeledChunk({
				file_path: "docs/main.md",
				content: "unresolved overview",
				content_tokenized: "unresolved overview",
				metadata_json: JSON.stringify({ refs: ["eq:missing", "eq:collide"] }),
			}),
			labeledChunk({
				file_path: "docs/b.md",
				content: "collision record one",
				content_tokenized: "collision record one",
				metadata_json: JSON.stringify({ labels: ["eq:collide"] }),
			}),
			labeledChunk({
				file_path: "docs/c.md",
				content: "collision record two",
				content_tokenized: "collision record two",
				metadata_json: JSON.stringify({ labels: ["eq:collide"] }),
			}),
		]);

		const response = await engine.search("unresolved overview", { mode: "fast", kb_id: kbId, limit: 10 });
		const rows = edgeRows(kbId);
		expect(rows.map((row) => [row.target_label, row.resolved_chunk_id])).toEqual([
			["eq:missing", null],
			["eq:collide", null],
		]);
		expect(response.results.map((result) => result.file_path)).toEqual(["docs/main.md"]);
		expect(response.results[0]?.provenance?.match_reason).not.toBe("dependency");
		expect(response.results[0]?.provenance?.depends_on).toBeUndefined();
	});

	it("F8: dependency injection respects kb_id and file_type filters", async () => {
		const { kbId } = await createSeededKb("F8Filters", [
			labeledChunk({
				file_path: "docs/main.md",
				content: "gauss theorem overview",
				content_tokenized: "gauss theorem overview",
				metadata_json: JSON.stringify({ refs: ["eq:flux", "eq:py"] }),
			}),
			labeledChunk({
				file_path: "docs/flux.md",
				content: "flux integral divergence",
				content_tokenized: "flux integral divergence",
				metadata_json: JSON.stringify({ labels: ["eq:flux"] }),
			}),
			labeledChunk({
				file_path: "docs/calc.py",
				file_type: "python",
				content: "def calc pass",
				content_tokenized: "def calc pass",
				metadata_json: JSON.stringify({ labels: ["eq:py"] }),
			}),
		]);

		const markdownOnly = await engine.search("gauss theorem", {
			mode: "fast",
			kb_id: kbId,
			filters: { file_type: "markdown" },
			limit: 10,
		});
		expect(markdownOnly.results.map((result) => result.file_path).sort()).toEqual(["docs/flux.md", "docs/main.md"]);
		const injected = markdownOnly.results.find((result) => result.provenance?.match_reason === "dependency");
		expect(injected?.file_path).toBe("docs/flux.md");
		expect(injected?.score).toBeCloseTo(DEPENDENCY_BOOST * kbTrustMultiplier(getKb(kbId)), 10);

		const pythonOnly = await engine.search("gauss theorem", {
			mode: "fast",
			kb_id: kbId,
			filters: { file_type: "python" },
			limit: 10,
		});
		expect(pythonOnly.results.map((result) => result.file_path)).toEqual(["docs/calc.py"]);
		expect(pythonOnly.results[0]?.provenance?.match_reason).toBe("dependency");
	});

	it("F8: walk consumes at most 2 edges per triggering chunk", async () => {
		const chunks = [
			labeledChunk({
				file_path: "docs/main.md",
				content: "cap trigger body",
				content_tokenized: "cap trigger body",
				metadata_json: JSON.stringify({ refs: ["eq:t1", "eq:t2", "eq:t3"] }),
			}),
		];
		for (const label of ["eq:t1", "eq:t2", "eq:t3"]) {
			chunks.push(
				labeledChunk({
					file_path: `docs/${label}.md`,
					content: `target body ${label}`,
					content_tokenized: `target body ${label}`,
					metadata_json: JSON.stringify({ labels: [label] }),
				}),
			);
		}
		const { kbId } = await createSeededKb("F8WalkCap", chunks);
		const response = await engine.search("cap trigger", { mode: "fast", kb_id: kbId, limit: 10 });
		const injected = response.results.filter((result) => result.provenance?.match_reason === "dependency");
		expect(injected.map((result) => result.file_path).sort()).toEqual(["docs/eq:t1.md", "docs/eq:t2.md"]);
		for (const result of injected) {
			expect(result.score).toBeCloseTo(DEPENDENCY_BOOST * kbTrustMultiplier(getKb(kbId)), 10);
		}
	});

	it("F8: injection budget is 10 candidates per query", async () => {
		const chunks: ChunkInsert[] = [];
		for (let i = 1; i <= 6; i++) {
			chunks.push(
				labeledChunk({
					file_path: `docs/trigger-${i}.md`,
					content: `budget trigger number ${i}`,
					content_tokenized: `budget trigger number ${i}`,
					metadata_json: JSON.stringify({ refs: [`eq:a${i}`, `eq:b${i}`] }),
				}),
			);
			for (const prefix of ["a", "b"]) {
				const label = `eq:${prefix}${i}`;
				chunks.push(
					labeledChunk({
						file_path: `docs/target-${label}.md`,
						content: `target body ${label}`,
						content_tokenized: `target body ${label}`,
						metadata_json: JSON.stringify({ labels: [label] }),
					}),
				);
			}
		}
		const { kbId } = await createSeededKb("F8Budget", chunks);
		const response = await engine.search("budget trigger", { mode: "fast", kb_id: kbId, limit: 20 });
		const injected = response.results.filter((result) => result.provenance?.match_reason === "dependency");
		expect(injected).toHaveLength(10);
	});

	it("F8: dormant kb without labels or refs keeps results free of dependency artifacts", async () => {
		const { kbId } = await createSeededKb("F8Dormant", [
			labeledChunk({
				file_path: "docs/plain.md",
				content: "plain body without annotations",
				content_tokenized: "plain body without annotations",
			}),
		]);
		const response = await engine.search("plain body", { mode: "fast", kb_id: kbId, limit: 5 });
		expect(response.results).toHaveLength(1);
		expect(labelFlag(kbId)).toBe(1);
		expect(edgeRows(kbId)).toEqual([]);
		for (const result of response.results) {
			expect(result.provenance?.match_reason).toBe("bm25");
			expect(result.provenance?.depends_on).toBeUndefined();
		}
	});
});
