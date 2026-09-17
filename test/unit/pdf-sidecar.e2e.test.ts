import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";
import { convertPdf, resolvePdfSidecarConfig } from "../../src/indexer/pdf-sidecar.ts";
import { getChunksByKB, getDefaultKnowledgeDir, openDatabase } from "../../src/storage/sqlite.ts";

const FAKE_SIDECAR = fileURLToPath(new URL("../fixtures/fake-sidecar.mjs", import.meta.url));
const FIXTURE_PDF = fileURLToPath(new URL("../fixtures/fixture-paper.pdf", import.meta.url));

// E5 gate: runs only when the real-binary gate env is set AND marker_single responds to
// --help. Otherwise the test is skipped cleanly (the binary is not installed in CI/dev).
function markerSingleAvailable(): boolean {
	try {
		execFileSync("marker_single", ["--help"], { timeout: 10000, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
const RUN_E5 = process.env.PI_KNOWLEDGE_TEST_SIDECAR === "marker" && markerSingleAvailable();
const itE5 = RUN_E5 ? it : it.skip;

// Captured at module load (before tests touch env): the embedding model cache follows
// PI_KNOWLEDGE_DIR, so tests must pin it to the real knowledge dir's models — otherwise
// every run would re-download the model into the temp dir. Same effective behavior as the
// rest of the engine unit suite, just explicit.
const USER_MODELS_DIR = join(getDefaultKnowledgeDir(), "models");

const SIDECAR_ENV_KEYS = [
	"PI_KNOWLEDGE_PDF_ENGINE",
	"PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS",
	"PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD",
	"PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD",
	"PI_KNOWLEDGE_PDF_SIDECAR_CMD",
	"PI_KNOWLEDGE_DIR",
	"PI_KNOWLEDGE_MODEL_CACHE_DIR",
	"FAKE_SIDECAR_MODE",
	"FAKE_SIDECAR_COUNTER",
	"FAKE_SIDECAR_ARGV",
	"FAKE_SIDECAR_SLEEP_MS",
];

function configureFakeSidecar(mode?: string): void {
	process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${FAKE_SIDECAR} {input} {output_dir}`;
	if (mode) process.env.FAKE_SIDECAR_MODE = mode;
}

function chunkMetadata(knowledgeDir: string, kbId: string): Record<string, unknown>[] {
	const db = openDatabase(knowledgeDir);
	try {
		return getChunksByKB(db, kbId).map((chunk) => ({
			file_type: chunk.file_type,
			file_path: chunk.file_path,
			...(JSON.parse(chunk.metadata_json) as Record<string, unknown>),
		}));
	} finally {
		db.close();
	}
}

function variantFixtureBytes(marker: string): Buffer {
	return Buffer.concat([readFileSync(FIXTURE_PDF), Buffer.from(`\n% ${marker}\n`)]);
}

describe("pdf sidecar engine e2e", () => {
	// One shared knowledge dir for the whole file (model loads once); tests isolate via
	// distinct KB names and distinct PDF bytes so cache observations stay deterministic.
	let engine: KnowledgeEngine;
	let knowledgeDir: string;
	let workDir: string;
	let initialized = false;
	let savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		knowledgeDir = mkdtempSync(join(tmpdir(), "pk-sidecar-kb-"));
		workDir = mkdtempSync(join(tmpdir(), "pk-sidecar-work-"));
	});

	beforeEach(() => {
		savedEnv = {};
		for (const key of SIDECAR_ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.PI_KNOWLEDGE_DIR = knowledgeDir;
		process.env.PI_KNOWLEDGE_MODEL_CACHE_DIR = USER_MODELS_DIR;
		engine = new KnowledgeEngine();
	});

	afterEach(async () => {
		if (initialized) await engine.dispose();
		initialized = false;
		for (const key of SIDECAR_ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	afterAll(() => {
		rmSync(knowledgeDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	});

	it("E1: sidecar add makes the fixture searchable across notation with pdf provenance and converter metadata", async () => {
		process.env.PI_KNOWLEDGE_PDF_ENGINE = "marker";
		configureFakeSidecar();
		await engine.initialize(knowledgeDir);
		initialized = true;
		const pdfPath = join(workDir, "paper.pdf");
		copyFileSync(FIXTURE_PDF, pdfPath);

		const { chunkCount, kb } = await engine.add(pdfPath, "Sidecar OK");
		expect(chunkCount).toBeGreaterThan(0);

		// Pin the provenance first: if the sidecar silently fell back under load, these fail
		// loudly instead of the search below.
		const metadata = chunkMetadata(knowledgeDir, kb.id);
		const pdfChunks = metadata.filter((chunk) => chunk.file_type === "pdf");
		expect(pdfChunks.length).toBeGreaterThan(0);
		expect(pdfChunks.every((chunk) => String(chunk.file_path).endsWith("paper.pdf"))).toBe(true);
		expect(pdfChunks.every((chunk) => chunk.converter === "marker")).toBe(true);

		// Unicode query "mc²" must find "$$E = mc^2$$" via Layer 1 canonicalization.
		const found = await engine.search("mc²", { mode: "fast", kb_id: "Sidecar OK" });
		expect(found.total_count).toBeGreaterThan(0);
		expect(found.results[0]?.file_path.endsWith("paper.pdf")).toBe(true);
		expect(found.results[0]?.file_type).toBe("pdf");

		const filtered = await engine.search("mc²", {
			mode: "fast",
			kb_id: "Sidecar OK",
			filters: { file_type: "pdf" },
		});
		expect(filtered.total_count).toBeGreaterThan(0);
	});

	it("E2: failing sidecar falls back to unpdf and records pdf_sidecar_failed in scan stats", async () => {
		process.env.PI_KNOWLEDGE_PDF_ENGINE = "marker";
		configureFakeSidecar("fail");
		await engine.initialize(knowledgeDir);
		initialized = true;
		const projectDir = join(workDir, "project");
		mkdirSync(projectDir, { recursive: true });
		// Distinct bytes from E1's paper.pdf so E1's successful conversion is not served from
		// the shared cache — this test needs the conversion to actually fail.
		writeFileSync(join(projectDir, "paper.pdf"), variantFixtureBytes("failing variant"));

		const progress: string[] = [];
		const { chunkCount, kb } = await engine.add(projectDir, "Sidecar Fail", (message) => progress.push(message));
		expect(chunkCount).toBeGreaterThan(0);
		expect(progress.some((message) => message.includes("pdf_sidecar_failed"))).toBe(true);

		// Unpdf fallback content is indexed (fixture text layer), still typed as pdf.
		const found = await engine.search("equivalence", { mode: "fast", kb_id: "Sidecar Fail" });
		expect(found.total_count).toBeGreaterThan(0);
		expect(found.results[0]?.file_type).toBe("pdf");

		const metadata = chunkMetadata(knowledgeDir, kb.id);
		expect(metadata.every((chunk) => chunk.converter === undefined)).toBe(true);
	});

	it("E3: PI_KNOWLEDGE_PDF_ENGINE=off is byte-identical to today's unpdf path (sidecar never invoked)", async () => {
		process.env.PI_KNOWLEDGE_PDF_ENGINE = "off";
		configureFakeSidecar();
		process.env.FAKE_SIDECAR_COUNTER = join(workDir, "counter-off.json");
		await engine.initialize(knowledgeDir);
		initialized = true;
		const pdfPath = join(workDir, "off.pdf");
		copyFileSync(FIXTURE_PDF, pdfPath);

		const { chunkCount, kb } = await engine.add(pdfPath, "Sidecar Off");
		expect(chunkCount).toBeGreaterThan(0);
		expect(existsSync(process.env.FAKE_SIDECAR_COUNTER)).toBe(false);

		const found = await engine.search("equivalence", { mode: "fast", kb_id: "Sidecar Off" });
		expect(found.total_count).toBeGreaterThan(0);
		expect(found.results[0]?.file_type).toBe("pdf");

		const metadata = chunkMetadata(knowledgeDir, kb.id);
		expect(metadata.every((chunk) => chunk.converter === undefined)).toBe(true);
	});

	it("E4: update after add hits the conversion cache (zero new sidecar spawns)", async () => {
		process.env.PI_KNOWLEDGE_PDF_ENGINE = "marker";
		configureFakeSidecar();
		const counter = join(workDir, "counter-cache.json");
		process.env.FAKE_SIDECAR_COUNTER = counter;
		await engine.initialize(knowledgeDir);
		initialized = true;
		// Distinct bytes from E1's paper.pdf so this test's add phase performs its own
		// (observable) conversion before the update phase must hit the cache.
		const pdfPath = join(workDir, "cache-probe.pdf");
		writeFileSync(pdfPath, variantFixtureBytes("cache-probe variant"));

		await engine.add(pdfPath, "Sidecar Cache");
		expect(existsSync(counter)).toBe(true);

		// Reset the observation window: the update must not spawn a single conversion.
		rmSync(counter, { force: true });
		const result = await engine.update("Sidecar Cache");
		expect(result.added).toBe(0);
		expect(result.unchanged).toBeGreaterThan(0);
		expect(existsSync(counter)).toBe(false);
	});

	itE5("E5: real marker_single converts the fixture to math-aware markdown", async () => {
		// Isolated knowledge dir so the real conversion cannot be served from a cached fake;
		// cleaned up in finally so the gated path never leaks the temp dir.
		const e5Dir = mkdtempSync(join(tmpdir(), "pk-sidecar-e5-"));
		try {
			process.env.PI_KNOWLEDGE_DIR = e5Dir;
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "marker";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS = "600000";
			const { markdown, converter } = await convertPdf(FIXTURE_PDF, resolvePdfSidecarConfig());
			expect(converter).toBe("marker");
			expect(markdown).toMatch(/\$\$|```math/);
			expect(markdown).toMatch(/^#{1,6}\s/m);
		} finally {
			rmSync(e5Dir, { recursive: true, force: true });
		}
	});
});
