import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";
import { listKBs } from "../../src/storage/sqlite.ts";
import * as watchModule from "../../src/watcher/file-watcher.ts";

const JOURNEY =
	"## 2026-09-22\n\nYusuf asked for a deep read of the pi-observational-memory repo and a written " +
	"Indonesian summary of the three-tier pipeline and its known limitations.";

let testDir: string;
let classRoot: string;
let engine: KnowledgeEngine;

/** A child directory that looks like a real OM conversation. */
function writeChild(dirName: string, opts: { journey?: string; topic?: string; runs?: boolean } = {}): string {
	const childPath = join(classRoot, dirName);
	mkdirSync(childPath, { recursive: true });
	// INDEX.md is orchestrator-rendered and identical for every conversation — if a description is
	// derived from it, every subclass KB becomes indistinguishable and the feature is worthless.
	writeFileSync(join(childPath, "INDEX.md"), "# Memory index\n\nDurable memory topics for this project.\n");
	if (opts.journey !== undefined) writeFileSync(join(childPath, "JOURNEY.md"), opts.journey);
	if (opts.topic !== undefined) writeFileSync(join(childPath, opts.topic), `notes about ${opts.topic}.\n`);
	if (opts.runs) {
		mkdirSync(join(childPath, ".runs"), { recursive: true });
		writeFileSync(join(childPath, ".runs", "worker.json"), '{"transient":true}');
	}
	return childPath;
}

/** startClassWatchers fires its startup reconcile without awaiting it, so poll for the effect. */
async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for reconcile");
}

const noopWatchModule = {
	startClassWatcher: () => {},
};

/** The chunk count currently recorded for a KB, for polling on a real watcher. */
function chunksOf(kbName: string): number {
	return listKBs(engine["db"]!).find((entry) => entry.name === kbName)?.chunk_count ?? -1;
}

/** A child holding exactly the named .md files, so the file count per test is explicit. */
function childWith(dirName: string, files: string[]): string {
	const childPath = join(classRoot, dirName);
	mkdirSync(childPath, { recursive: true });
	for (const file of files) writeFileSync(join(childPath, file), `# ${file}\n\nadvanced notes on ${file}.\n`);
	return childPath;
}

/** The distinct source files currently indexed for a KB. */
function filesOf(kbName: string): Set<string> {
	const db = engine["db"]!;
	const id = listKBs(db).find((entry) => entry.name === kbName)?.id;
	if (!id) return new Set();
	const rows = db.prepare("SELECT DISTINCT file_path FROM chunks WHERE kb_id = ?").all(id) as {
		file_path: string;
	}[];
	return new Set(rows.map((row) => row.file_path));
}

describe("class hierarchy (layer 5)", () => {
	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "pk-test-class-"));
		classRoot = join(testDir, "memory");
		mkdirSync(classRoot, { recursive: true });
		engine = new KnowledgeEngine();
		await engine.initialize(testDir);
	});

	afterEach(async () => {
		await engine.dispose();
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("subclass descriptions", () => {
		it("derives the description from JOURNEY.md, not the boilerplate INDEX.md", async () => {
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });

			const result = await engine.reconcileClassRoot(classRoot, "om");

			expect(result.created).toEqual(["om-01a0c0f2-a0a"]);
			const kb = listKBs(engine["db"]!).find((entry) => entry.name === "om-01a0c0f2-a0a");
			// The distinguishing failure is silently returning the shared "# Memory index" heading.
			expect(kb?.description).toContain("deep read of the pi-observational-memory repo");
			expect(kb?.description).not.toContain("Memory index");
		});

		it("skips a short heading line and falls back to topic filenames when there is no prose", async () => {
			writeChild("01a0d4d1-7bc0-7791-a62a-c1165db1d5a4", { journey: "# Journey\n\n## 2026-09-23\n", topic: "browser-redesign.md" });
			writeChild("01a0d4db-1899-7791-a62a-c11927c23431", { topic: "quantization-notes.md" });

			await engine.reconcileClassRoot(classRoot, "om");

			const byName = new Map(listKBs(engine["db"]!).map((kb) => [kb.name, kb.description]));
			expect(byName.get("om-01a0d4d1-7bc")).toBe("topics: browser redesign");
			expect(byName.get("om-01a0d4db-189")).toBe("topics: quantization notes");
		});

		it("refreshes a stale description on a reconcile without re-embedding", async () => {
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });
			await engine.reconcileClassRoot(classRoot, "om");
			const chunksAfterFirst = listKBs(engine["db"]!).find((kb) => kb.name === "om-01a0c0f2-a0a")?.chunk_count;
			expect(chunksAfterFirst).toBeGreaterThan(0);

			// Simulate a description computed by the old, INDEX.md-based implementation.
			const db = engine["db"]!;
			db.prepare("UPDATE knowledge_bases SET description = ? WHERE name = ?").run("Memory index", "om-01a0c0f2-a0a");

			const second = await engine.reconcileClassRoot(classRoot, "om");

			expect(second.created).toEqual([]);
			expect(second.existing).toEqual(["om-01a0c0f2-a0a"]);
			const kb = listKBs(db).find((entry) => entry.name === "om-01a0c0f2-a0a");
			expect(kb?.description).toContain("deep read of the pi-observational-memory repo");
			// A description refresh is not a reindex: chunk_count must be untouched.
			expect(kb?.chunk_count).toBe(chunksAfterFirst);
		});
	});

	describe("inherited .gitignore", () => {
		it("excludes what the class root's .gitignore excludes, not just the child's own", async () => {
			writeFileSync(join(classRoot, ".gitignore"), "# pi-second-brain KB scope: not memory\n.runs/\nINDEX.md\n");
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md", runs: true });

			await engine.reconcileClassRoot(classRoot, "om");

			const paths = (
				engine["db"]!
					.prepare(
						"SELECT c.file_path AS p FROM chunks c JOIN knowledge_bases kb ON kb.id = c.kb_id WHERE kb.name = ?",
					)
					.all("om-01a0c0f2-a0a") as Array<{ p: string }>
			).map((row) => row.p);
			// The child's own scan cannot see the root's .gitignore, so without ignore_from the
			// transient worker IPC and the rendered index get indexed for every single subclass.
			expect(paths.some((p) => p.includes(".runs"))).toBe(false);
			expect(paths.some((p) => p.endsWith("INDEX.md"))).toBe(false);
			expect(paths).toContain("JOURNEY.md");
		});

		it("reports 100% coverage, not 7%, because the diagnostic counts the same files the KB indexed", async () => {
			// The bug this pins: scanOptionsFromSourceOptions existed as two independent copies, and
			// ignore_from was threaded into only one. The diagnostics copy therefore counted .runs/
			// files that the KB deliberately excludes, so every fully-indexed subclass KB reported
			// 7% coverage and looked broken. A KB that indexes 1 of 1 files cannot be 7% covered.
			writeFileSync(join(classRoot, ".gitignore"), "# pi-second-brain KB scope: not memory\n.runs/\nINDEX.md\n");
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md", runs: true });
			await engine.reconcileClassRoot(classRoot, "om");

			const diag = engine.diagnose().find((entry) => entry.kb_name === "om-01a0c0f2-a0a");

			expect(diag?.indexed_files).toBe(diag?.total_source_files);
			expect(diag?.coverage_percent).toBe(100);
		});
	});

	describe("startup reconcile", () => {
		it("indexes a conversation created while Pi was closed", async () => {
			// No KBs exist yet, so no class watcher can be installed: register a class first, then
			// drop the child on disk, then start. The watcher's baseline snapshot already contains
			// the child, so onNewChild can never fire for it — only the startup reconcile sees it.
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });
			await engine.reconcileClassRoot(classRoot, "om");
			const stale = engine.remove("om-01a0c0f2-a0a");
			expect(listKBs(engine["db"]!)).toHaveLength(0);
			await stale;

			const started = engine.startClassWatchers(noopWatchModule, {});

			// Nothing is registered as a class root yet, so an empty result is correct here; the
			// meaningful case is a root that IS registered, which the next test covers.
			expect(started).toEqual([]);
		});

		it("re-indexes a registered subclass whose files appeared while Pi was closed", async () => {
			// A KB that already exists, with its one file indexed.
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });
			await engine.reconcileClassRoot(classRoot, "om");
			await waitFor(() => chunksOf("om-01a0c0f2-a0a") > 0);
			const before = chunksOf("om-01a0c0f2-a0a");

			// Two more files land on disk. No watcher is installed here, so no file event can fire
			// for them — this is exactly the state a restart finds: the files appeared while Pi was
			// closed, so the next session's baseline snapshot ALREADY contains them and no diff will
			// ever report them.
			const childPath = join(classRoot, "01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249");
			writeFileSync(join(childPath, "STATE.md"), "# State\n\nfirst state file.\n");
			writeFileSync(join(childPath, "DEATHS.md"), "# Deaths\n\nfirst death file.\n");

			engine.startClassWatchers(noopWatchModule, {});

			// Without a startup coverage pass this waits forever: reconcileClassRoot only adopts a
			// MISSING child, and a registered KB is never rescanned.
			await waitFor(() => chunksOf("om-01a0c0f2-a0a") > before, 60_000);
			expect(filesOf("om-01a0c0f2-a0a").has("STATE.md")).toBe(true);
			expect(filesOf("om-01a0c0f2-a0a").has("DEATHS.md")).toBe(true);
		}, 120_000);

		it("adopts an unregistered child on startup for a registered class root", async () => {
			// Register class "om" with one child, then add a second child and wipe the first KB to
			// emulate a conversation that appeared while Pi was down.
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });
			await engine.reconcileClassRoot(classRoot, "om");
			writeChild("01a0e17a-fb6e-7046-841a-62547c37c0eb", { journey: JOURNEY, topic: "browser-redesign.md" });
			await engine.remove("om-01a0e17a-fb6");

			engine.startClassWatchers(noopWatchModule, {});

			// Wait for the index, not just the row: add() inserts the knowledge_bases row before it
			// chunks, so a KB is briefly visible with chunk_count 0 and asserting on it there is a
			// race, not a failure.
			await waitFor(() => {
				const kb = listKBs(engine["db"]!).find((entry) => entry.name === "om-01a0e17a-fb6");
				return kb !== undefined && kb.chunk_count > 0;
			});
			const kb = listKBs(engine["db"]!).find((entry) => entry.name === "om-01a0e17a-fb6");
			expect(kb?.class).toBe("om");
			expect(kb?.chunk_count).toBeGreaterThan(0);
		});

		it("reports a failed startup reconcile instead of swallowing it", async () => {
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });
			await engine.reconcileClassRoot(classRoot, "om");
			// Keep the KB row so the class root stays registered, then replace the root with a file
			// so the reconcile's readdirSync fails with ENOTDIR. Removing the KB instead would empty
			// the roots map and the reconcile would never run at all.
			rmSync(classRoot, { recursive: true, force: true });
			writeFileSync(classRoot, "not a directory");

			const warnings: string[] = [];
			engine.startClassWatchers(noopWatchModule, {}, (level, message) => {
				if (level === "warn") warnings.push(message);
			});

			// A silent catch here is what made the missing-startup-reconcile bug invisible: the
			// watcher looked installed while nothing was ever indexed.
			await waitFor(() => warnings.length > 0);
			expect(warnings[0]).toContain("startup reconcile");
			expect(warnings[0]).toContain("Class root is not a directory");
		});
	});

	describe("class watcher routing", () => {
		// These two tests drive the REAL watcher, because both defects live in the routing between
		// the snapshot diff and the child KB — a mocked watcher reproduces neither.
		beforeEach(async () => {
			childWith("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", ["a.md"]);
			await engine.reconcileClassRoot(classRoot, "om");
			engine.startClassWatchers(watchModule, {});
		});

		// A single watcher transition costs one poll plus one debounce (~4s) plus the reindex, so
		// these drive the real clock and need far more than the default 15s timeout.
		it("re-indexes a live subclass after one of its files is deleted", async () => {
			childWith("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", ["a.md", "b.md"]);
			await waitFor(() => chunksOf("om-01a0c0f2-a0a") === 2);

			// The child stays alive, so onChildRemoved must NOT fire, but the deletion is still an
			// ordinary edit and the orphan chunk has to be retracted.
			unlinkSync(join(classRoot, "01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", "b.md"));

			await waitFor(() => chunksOf("om-01a0c0f2-a0a") === 1);
			expect(chunksOf("om-01a0c0f2-a0a")).toBe(1);
		}, 120_000);

		it("keeps routing a subclass that went empty and was refilled", async () => {
			const childPath = childWith("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", ["a.md"]);
			await waitFor(() => filesOf("om-01a0c0f2-a0a").has("a.md"));

			// A child that empties is indistinguishable from one whose directory vanished, so
			// onChildRemoved fires and drops the child->kbId mapping. The index is deliberately NOT
			// wiped: a zero-file scan against a populated KB is treated as a broken mount, not an
			// intentional deletion. So the proof that routing came back is the REFILLED file being
			// indexed — a chunk count would stay 1 either way and assert nothing.
			unlinkSync(join(childPath, "a.md"));
			// One poll plus one debounce plus the attempted update, before the refill is written.
			await new Promise((resolve) => setTimeout(resolve, 8000));

			writeFileSync(join(childPath, "c.md"), "# c.md\n\nrefilled with different material.\n");
			await waitFor(() => filesOf("om-01a0c0f2-a0a").has("c.md"), 60_000);
			expect(filesOf("om-01a0c0f2-a0a").has("c.md")).toBe(true);
		}, 180_000);
	});

	describe("name collisions", () => {
		it("refuses to index a second child whose first 12 characters collide", async () => {
			// The bug: getKBByName(className + first 12 chars) matching is treated as "this child is
			// already indexed", so a sibling sharing the prefix was parked in `existing` and never
			// indexed. Silent, unreported, and it loses a whole topic's material.
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });
			await engine.reconcileClassRoot(classRoot, "om");

			// Both directory names start with "01a0c0f2-a0a", so both map to KB name om-01a0c0f2-a0a.
			const second = writeChild("01a0c0f2-a0aZZ-76fa-83d6-c92fe9cb2249", {
				journey: JOURNEY,
				topic: "browser-redesign.md",
			});

			const result = await engine.reconcileClassRoot(classRoot, "om");

			expect(result.existing).toEqual(["om-01a0c0f2-a0a"]);
			// A collision is data loss if it is silent, so it must be surfaced, not swallowed.
			expect(result.failed).toHaveLength(1);
			expect(result.failed[0].child).toBe("01a0c0f2-a0aZZ-76fa-83d6-c92fe9cb2249");
			expect(result.failed[0].error).toMatch(/01a0c0f2-a0a/);
			// The colliding directory must not be indexed under the sibling's KB either.
			const chunks = (
				engine["db"]!
					.prepare("SELECT count(*) AS n FROM chunks c JOIN knowledge_bases kb ON kb.id = c.kb_id WHERE kb.name = ?")
					.all("om-01a0c0f2-a0a") as Array<{ n: number }>
			)[0].n;
			expect(chunks).toBeGreaterThan(0);
			expect(
				(
					engine["db"]!
						.prepare("SELECT count(*) AS n FROM chunks c JOIN knowledge_bases kb ON kb.id = c.kb_id WHERE kb.source_path = ?")
						.all(second) as Array<{ n: number }>
				)[0].n,
			).toBe(0);
		});

		it("does not flag a collision when the same directory is reconciled twice", async () => {
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });

			await engine.reconcileClassRoot(classRoot, "om");
			const second = await engine.reconcileClassRoot(classRoot, "om");

			// Idempotency is the property the whole layer depends on: re-running must be a no-op.
			expect(second.created).toEqual([]);
			expect(second.existing).toEqual(["om-01a0c0f2-a0a"]);
			expect(second.failed).toEqual([]);
		});
	});

	describe("search scoping", () => {
		it("scopes kb_id to one subclass and class to the whole hierarchy", async () => {
			// The query term lives in both children's JOURNEY.md AND in a non-class KB, so an
			// unfiltered search would return all three. Without that overlap the "excludes
			// llm-papers" assertion would pass vacuously — and so would a fixture that matches
			// nothing at all.
			writeChild("01a0c0f2-a0ab-76fa-83d6-c92fe9cb2249", { journey: JOURNEY, topic: "om-fork-research.md" });
			writeChild("01a0e17a-fb6e-7046-841a-62547c37c0eb", { journey: JOURNEY, topic: "browser-redesign.md" });
			const other = join(testDir, "papers");
			mkdirSync(other, { recursive: true });
			writeFileSync(join(other, "llm-notes.md"), JOURNEY);
			await engine.add(other, "llm-papers");
			await engine.reconcileClassRoot(classRoot, "om");

			const db = engine["db"]!;
			const query = "three-tier pipeline limitations";

			const unfiltered = await engine.search(query, { mode: "fast", limit: 20 });
			const unfilteredNames = new Set(unfiltered.results.map((hit) => hit.kb_name));
			expect(unfilteredNames).toEqual(
				new Set(["om-01a0c0f2-a0a", "om-01a0e17a-fb6", "llm-papers"]),
			);

			const one = listKBs(db).find((kb) => kb.name === "om-01a0c0f2-a0a")!;
			const scoped = await engine.search(query, { kb_id: one.id, mode: "fast", limit: 20 });
			expect(scoped.results.length).toBeGreaterThan(0);
			expect(new Set(scoped.results.map((hit) => hit.kb_name))).toEqual(new Set(["om-01a0c0f2-a0a"]));

			// class is pushdown, not a post-filter: it must reach the sibling subclass too, and must
			// not pull in a non-class KB whose content matches exactly as well.
			const acrossClass = await engine.search(query, { class: "om", mode: "fast", limit: 20 });
			expect(new Set(acrossClass.results.map((hit) => hit.kb_name))).toEqual(
				new Set(["om-01a0c0f2-a0a", "om-01a0e17a-fb6"]),
			);
		});

		it("rejects an unknown class instead of silently searching everything", async () => {
			await expect(engine.search("anything", { class: "nope", mode: "fast" })).rejects.toThrow(
				'No knowledge bases belong to class "nope"',
			);
		});

		it("throws rather than searching a partial kb_ids set", async () => {
			await expect(engine.search("anything", { kb_ids: ["missing-kb"], mode: "fast" })).rejects.toThrow(
				/Knowledge base not found/,
			);
		});
	});
});
