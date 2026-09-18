// Golden-query eval harness — docs/layer4-fidelity-breadth-plan.md §3.3 (Wave 1 worker B).
//
// Modes:
//   --fixture   (default, hard gate) Build an ephemeral KB from test/fixtures + test/eval/fixtures*/
//               (existing dirs only, sorted), run every kb-less golden query, print per-domain
//               recall@k. Exit 1 on any miss.
//   --kb <name> Read-only golden run against an existing KB in the default knowledge dir
//               (~/.pi/knowledge). Only entries whose "kb" field matches <name> run. Advisory:
//               always exits 0 unless the KB is missing or the run fails.
//
// Byte-determinism (plan S3): sorted iteration everywhere, no timestamps/durations/chunk ids in
// the report, and the fixture build asserts the warm-cache local embedding signature before any
// query runs. Verify with two consecutive runs:
//   npm run eval -- --fixture > /tmp/eval-a.txt && npm run eval -- --fixture > /tmp/eval-b.txt && diff /tmp/eval-a.txt /tmp/eval-b.txt
//
// Usage: node dist/eval/run.js [--fixture | --kb <name>] [--k <n>] [--verbose]
// Paths are resolved relative to the process cwd (npm scripts run at the repo root).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { embeddingSignature, resolveEmbeddingConfig } from "../src/embedding/provider.ts";
import { KnowledgeEngine, type SearchMode, type SearchResult } from "../src/engine.ts";
import { getDefaultKnowledgeDir } from "../src/storage/sqlite.ts";

interface GoldenExpect {
	file_path?: string;
	path_prefix?: string;
	min_score?: number;
	must_reason?: string;
}

interface GoldenEntry {
	id: string;
	query: string;
	mode: SearchMode;
	kb?: string;
	expect: GoldenExpect;
}

interface GoldenFile {
	name: string;
	entries: GoldenEntry[];
}

interface QueryOutcome {
	file: string;
	entry: GoldenEntry;
	pass: boolean;
	rank: number;
	topCount: number;
}

const VALID_MODES: ReadonlySet<string> = new Set([
	"auto",
	"fast",
	"semantic",
	"hybrid",
	"deep",
	"adaptive",
	"code",
	"config",
	"errors",
	"decision",
]);

// Sorted by design; each entry becomes one ephemeral KB named after its basename. chem worker's
// test/eval/fixtures is picked up automatically once it exists (plan §3.3: runner globs fixtures).
const FIXTURE_SOURCE_DIRS = ["test/eval/fixtures", "test/eval/fixtures-eval", "test/fixtures"];
const GOLDEN_DIR = "eval/golden";
const DEFAULT_K = 5;

function fail(message: string): never {
	console.error(`eval: ${message}`);
	process.exit(2);
}

function parseArgs(argv: string[]): { mode: "fixture" | "kb"; kbName?: string; k: number; verbose: boolean } {
	let mode: "fixture" | "kb" = "fixture";
	let kbName: string | undefined;
	let k = DEFAULT_K;
	let verbose = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--fixture") {
			mode = "fixture";
		} else if (arg === "--kb") {
			i += 1;
			kbName = argv[i];
			if (!kbName) fail("--kb requires a KB name");
			mode = "kb";
		} else if (arg === "--k") {
			i += 1;
			const parsed = Number(argv[i]);
			if (!Number.isInteger(parsed) || parsed < 1) fail("--k requires a positive integer");
			k = parsed;
		} else if (arg === "--verbose") {
			verbose = true;
		} else {
			fail(`unknown argument: ${arg}`);
		}
	}
	if (mode === "fixture" && kbName) fail("--fixture does not accept a KB name");
	return { mode, kbName, k, verbose };
}

function loadGoldenFiles(goldenDir: string): GoldenFile[] {
	if (!existsSync(goldenDir)) fail(`golden directory not found: ${goldenDir}`);
	const files = readdirSync(goldenDir)
		.filter((name) => name.endsWith(".json"))
		.sort();
	if (files.length === 0) fail(`no golden files in ${goldenDir}`);
	return files.map((name) => {
		const raw: unknown = JSON.parse(readFileSync(join(goldenDir, name), "utf-8"));
		if (!Array.isArray(raw)) fail(`${name}: top-level JSON must be an array`);
		const entries = raw.map((item, index) => parseEntry(name, index, item));
		return { name, entries };
	});
}

function parseEntry(file: string, index: number, item: unknown): GoldenEntry {
	const where = `${file}[${index}]`;
	if (typeof item !== "object" || item === null) fail(`${where}: entry must be an object`);
	const entry = item as Record<string, unknown>;
	if (typeof entry.id !== "string" || entry.id.length === 0) fail(`${where}: missing "id"`);
	if (typeof entry.query !== "string" || entry.query.length === 0) fail(`${where}: missing "query"`);
	if (typeof entry.mode !== "string" || !VALID_MODES.has(entry.mode)) fail(`${where}: invalid "mode"`);
	if (typeof entry.expect !== "object" || entry.expect === null) fail(`${where}: missing "expect"`);
	const expect = entry.expect as Record<string, unknown>;
	const hasPath = typeof expect.file_path === "string";
	const hasPrefix = typeof expect.path_prefix === "string";
	if (hasPath === hasPrefix) fail(`${where}: expect needs exactly one of "file_path" | "path_prefix"`);
	if (expect.min_score !== undefined && typeof expect.min_score !== "number") {
		fail(`${where}: "min_score" must be a number`);
	}
	if (expect.must_reason !== undefined && typeof expect.must_reason !== "string") {
		fail(`${where}: "must_reason" must be a string`);
	}
	if (entry.kb !== undefined && typeof entry.kb !== "string") fail(`${where}: "kb" must be a string`);
	return {
		id: entry.id,
		query: entry.query,
		mode: entry.mode as SearchMode,
		kb: entry.kb,
		expect: {
			file_path: expect.file_path as string | undefined,
			path_prefix: expect.path_prefix as string | undefined,
			min_score: expect.min_score as number | undefined,
			must_reason: expect.must_reason as string | undefined,
		},
	};
}

function matchesExpect(result: SearchResult, expect: GoldenExpect): boolean {
	if (expect.file_path !== undefined && result.file_path !== expect.file_path) return false;
	if (expect.path_prefix !== undefined && !result.file_path.startsWith(expect.path_prefix)) return false;
	if (expect.min_score !== undefined && !(result.score >= expect.min_score)) return false;
	if (expect.must_reason !== undefined && result.provenance?.match_reason !== expect.must_reason) return false;
	return true;
}

function assertWarmCacheSignature(embeddingModel: string, signature: string, dimension: number): void {
	const config = resolveEmbeddingConfig();
	if (config.provider !== "local") {
		fail(
			`embedding provider is "${config.provider}"; fixture determinism requires the pinned local ` +
				"warm-cache model (unset embedding API env overrides)",
		);
	}
	if (embeddingModel !== config.model || signature !== embeddingSignature(config, dimension)) {
		fail(
			`fixture KB embedding signature "${signature}" does not match the warm-cache local model ` +
				`"${embeddingModel}"/"${embeddingSignature(config, dimension)}"`,
		);
	}
}

async function runFixture(
	goldenFiles: GoldenFile[],
	k: number,
	verbose: boolean,
): Promise<{ outcomes: QueryOutcome[]; skipped: number }> {
	const fixtureDirs = FIXTURE_SOURCE_DIRS.map((dir) => resolve(dir)).filter((dir) => {
		if (!existsSync(dir)) return false;
		return statSync(dir).isDirectory();
	});
	if (fixtureDirs.length === 0) fail("no fixture source directories found");

	const knowledgeDir = mkdtempSync(join(tmpdir(), "pk-eval-fixture-"));
	const engine = new KnowledgeEngine();
	try {
		await engine.initialize(knowledgeDir);
		const onProgress = verbose ? (msg: string) => console.error(`[build] ${msg}`) : undefined;
		for (const dir of fixtureDirs) {
			const name = basename(dir);
			const { kb } = await engine.add(dir, name, onProgress);
			if (kb.embedding_dimension === null) fail(`fixture KB "${name}" has no embedding dimension after add`);
			assertWarmCacheSignature(kb.embedding_model, kb.embedding_signature ?? "", kb.embedding_dimension);
		}
		const outcomes: QueryOutcome[] = [];
		let skipped = 0;
		for (const file of goldenFiles) {
			for (const entry of file.entries) {
				if (entry.kb !== undefined) {
					skipped += 1;
					continue;
				}
				const response = await engine.search(entry.query, { mode: entry.mode, limit: k });
				const top = response.results.slice(0, k);
				let rank = 0;
				for (let i = 0; i < top.length; i++) {
					if (matchesExpect(top[i], entry.expect)) {
						rank = i + 1;
						break;
					}
				}
				outcomes.push({ file: file.name, entry, pass: rank > 0, rank, topCount: top.length });
			}
		}
		return { outcomes, skipped };
	} finally {
		await engine.dispose();
		rmSync(knowledgeDir, { recursive: true, force: true });
	}
}

async function runKb(
	goldenFiles: GoldenFile[],
	kbName: string,
	k: number,
): Promise<{ outcomes: QueryOutcome[]; skipped: number }> {
	const engine = new KnowledgeEngine();
	try {
		await engine.initialize(getDefaultKnowledgeDir());
		const kb = engine.list().find((candidate) => candidate.name === kbName);
		if (!kb) fail(`KB "${kbName}" not found in ${getDefaultKnowledgeDir()}`);
		const outcomes: QueryOutcome[] = [];
		let skipped = 0;
		for (const file of goldenFiles) {
			for (const entry of file.entries) {
				if (entry.kb !== kbName) {
					skipped += 1;
					continue;
				}
				const response = await engine.search(entry.query, { mode: entry.mode, limit: k, kb_id: kbName });
				const top = response.results.slice(0, k);
				let rank = 0;
				for (let i = 0; i < top.length; i++) {
					if (matchesExpect(top[i], entry.expect)) {
						rank = i + 1;
						break;
					}
				}
				outcomes.push({ file: file.name, entry, pass: rank > 0, rank, topCount: top.length });
			}
		}
		return { outcomes, skipped };
	} finally {
		await engine.dispose();
	}
}

function renderReport(
	mode: "fixture" | "kb",
	kbName: string | undefined,
	k: number,
	outcomes: QueryOutcome[],
	skipped: number,
): string {
	// Deterministic order: sort by (golden file, entry id) regardless of run order.
	const sorted = [...outcomes].sort((a, b) => a.file.localeCompare(b.file) || a.entry.id.localeCompare(b.entry.id));
	const lines: string[] = [];
	const scope = mode === "kb" ? `kb: ${kbName} (advisory; corpus evolves)` : "fixture (ephemeral KB, hard gate)";
	lines.push(`knowledge eval — mode: ${mode} — ${scope}`);
	lines.push(`golden files: ${[...new Set(sorted.map((o) => o.file))].sort().join(", ")}`);
	lines.push(`recall window k: ${k}`);
	lines.push("");
	const domains = [...new Set(sorted.map((o) => o.file))].sort();
	for (const domain of domains) {
		const rows = sorted.filter((o) => o.file === domain);
		const hits = rows.filter((o) => o.pass).length;
		const recall = rows.length > 0 ? (100 * hits) / rows.length : 0;
		lines.push(`recall@${k}  ${domain.padEnd(16)} ${hits}/${rows.length}  ${recall.toFixed(1)}%`);
	}
	lines.push("");
	lines.push("per-query:");
	for (const outcome of sorted) {
		const status = outcome.pass ? "PASS" : "MISS";
		const rank = outcome.pass ? `rank=${outcome.rank}` : `top=${outcome.topCount}`;
		const expect = outcome.entry.expect.file_path ?? outcome.entry.expect.path_prefix ?? "";
		lines.push(`${status} ${outcome.file} ${outcome.entry.id} ${rank} ${expect}`);
	}
	const hits = sorted.filter((o) => o.pass).length;
	const recall = sorted.length > 0 ? (100 * hits) / sorted.length : 0;
	lines.push("");
	const skippedNote = skipped > 0 ? ` (skipped ${skipped} entries scoped to other modes)` : "";
	lines.push(`total: ${hits}/${sorted.length} queries hit (recall@${k} ${recall.toFixed(1)}%)${skippedNote}`);
	return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const goldenFiles = loadGoldenFiles(GOLDEN_DIR);
	const total = goldenFiles.reduce((sum, file) => sum + file.entries.length, 0);
	if (total === 0) fail("golden files contain no entries");
	const { outcomes, skipped } =
		args.mode === "fixture"
			? await runFixture(goldenFiles, args.k, args.verbose)
			: await runKb(goldenFiles, args.kbName as string, args.k);
	process.stdout.write(renderReport(args.mode, args.kbName, args.k, outcomes, skipped));
	if (args.mode === "fixture") {
		const misses = outcomes.filter((o) => !o.pass);
		if (misses.length > 0) {
			console.error(`eval: fixture gate FAILED — ${misses.length} golden query(ies) missed their anchor`);
			process.exit(1);
		}
	}
}

main().catch((error: unknown) => {
	console.error(`eval: run failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
});
