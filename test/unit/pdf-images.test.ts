import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";
import { convertPdf, resolvePdfSidecarConfig } from "../../src/indexer/pdf-sidecar.ts";
import { getDefaultKnowledgeDir } from "../../src/storage/sqlite.ts";

const FAKE_SIDECAR = fileURLToPath(new URL("../fixtures/fake-sidecar.mjs", import.meta.url));
const FIXTURE_PDF = fileURLToPath(new URL("../fixtures/fixture-paper.pdf", import.meta.url));

// Captured at module load (before tests touch env): the embedding model cache follows
// PI_KNOWLEDGE_DIR, so engine tests must pin it to the real knowledge dir's models.
const USER_MODELS_DIR = join(getDefaultKnowledgeDir(), "models");

// Minimal valid 1x1 RGBA PNG (70 bytes), written into tmpdir at runtime so no binary fixture
// is committed. Image bytes are only hashed/copied by the store — validity is realism, not a
// functional requirement.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const IMAGES_ENV_KEYS = [
	"PI_KNOWLEDGE_DIR",
	"PI_KNOWLEDGE_MODEL_CACHE_DIR",
	"PI_KNOWLEDGE_PDF_ENGINE",
	"PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS",
	"PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD",
	"PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD",
	"PI_KNOWLEDGE_PDF_SIDECAR_CMD",
	"PI_KNOWLEDGE_OCR_ENGINE",
	"PI_KNOWLEDGE_OCR_CMD",
	"FAKE_SIDECAR_MODE",
	"FAKE_SIDECAR_COUNTER",
	"FAKE_SIDECAR_ARGV",
	"FAKE_SIDECAR_SLEEP_MS",
	"FAKE_SIDECAR_IMAGES",
];

let tempDirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeTinyPng(dir: string): string {
	const path = join(dir, "tiny.png");
	writeFileSync(path, Buffer.from(TINY_PNG_BASE64, "base64"));
	return path;
}

function writeFakeTesseract(dir: string, text: string, counterPath?: string): string {
	const counterLine = counterPath ? `echo invoked >> "${counterPath}"\n` : "";
	const script = [
		"#!/bin/sh",
		counterLine,
		'if [ "$1" = "--version" ]; then',
		'  echo "tesseract 5.0.0-fake"',
		"  exit 0",
		"fi",
		"# real invocation: <script> <image> <output_dir> — write the recognized text as *.txt",
		`printf '${text}\\n' > "$2/ocr.txt"`,
		"exit 0",
		"",
	].join("\n");
	const path = join(dir, "fake-tesseract.sh");
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return path;
}

function writeFixturePdf(dir: string, name: string, marker: string): string {
	const path = join(dir, name);
	writeFileSync(path, Buffer.concat([readFileSync(FIXTURE_PDF), Buffer.from(`\n% ${marker}\n`)]));
	return path;
}

function configureFakeSidecar(): void {
	process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${FAKE_SIDECAR} {input} {output_dir}`;
}

function listStore(knowledgeDir: string): string[] {
	const storeDir = join(knowledgeDir, "image-store");
	if (!existsSync(storeDir)) return [];
	return readdirSync(storeDir);
}

describe("pdf sidecar images (F5 store/caption, F6 OCR)", () => {
	beforeAll(() => {
		chmodSync(FAKE_SIDECAR, 0o755);
	});

	beforeEach(() => {
		savedEnv = {};
		for (const key of IMAGES_ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		configureFakeSidecar();
	});

	afterEach(() => {
		for (const key of IMAGES_ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	afterAll(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs = [];
	});

	it("I1 (F5): image with alt is stored sha256-named, link rewritten, caption searchable via engine.search", async () => {
		const work = makeTempDir("pk-images-work-");
		const knowledgeDir = makeTempDir("pk-images-kb-");
		process.env.PI_KNOWLEDGE_DIR = knowledgeDir;
		// F5 has no OCR concern; keep the test hermetic even on machines with real tesseract.
		process.env.PI_KNOWLEDGE_OCR_ENGINE = "off";
		process.env.FAKE_SIDECAR_IMAGES = writeTinyPng(work);
		const pdfPath = writeFixturePdf(work, "paper.pdf", "images alt variant");

		const { markdown } = await convertPdf(pdfPath, resolvePdfSidecarConfig());

		const pngBytes = readFileSync(process.env.FAKE_SIDECAR_IMAGES ?? "");
		const expectedHash = createHash("sha256").update(pngBytes).digest("hex");
		const expectedPath = join(knowledgeDir, "image-store", `${expectedHash}.png`);
		expect(existsSync(expectedPath)).toBe(true);
		expect(readFileSync(expectedPath).equals(pngBytes)).toBe(true);
		expect(markdown).toContain(`![Linear actuator force diagram](${expectedPath})`);
		// both refs persisted: the alt-less figure-2 copy exists too and is rewritten in place
		expect(markdown).toContain("![](");
		expect(markdown).not.toContain("](images/");
		expect(markdown).not.toContain("figure-2");

		process.env.PI_KNOWLEDGE_MODEL_CACHE_DIR = USER_MODELS_DIR;
		const engine = new KnowledgeEngine();
		try {
			await engine.initialize(knowledgeDir);
			const { chunkCount } = await engine.add(pdfPath, "Images Alt");
			expect(chunkCount).toBeGreaterThan(0);
			const found = await engine.search("linear actuator force diagram", {
				mode: "fast",
				kb_id: "Images Alt",
			});
			expect(found.total_count).toBeGreaterThan(0);
			expect(found.results[0]?.content).toContain("Linear actuator force diagram");
			expect(found.results[0]?.content).toContain("image-store");
		} finally {
			await engine.dispose();
		}
	});

	it("I2 (F5): missing image files drop their refs without failing the conversion", async () => {
		const work = makeTempDir("pk-images-work-");
		const knowledgeDir = makeTempDir("pk-images-kb-");
		process.env.PI_KNOWLEDGE_DIR = knowledgeDir;
		process.env.PI_KNOWLEDGE_OCR_ENGINE = "off";
		process.env.FAKE_SIDECAR_IMAGES = "missing";
		const pdfPath = writeFixturePdf(work, "paper.pdf", "images missing variant");

		const { markdown } = await convertPdf(pdfPath, resolvePdfSidecarConfig());

		expect(markdown).not.toContain("![");
		expect(markdown).toContain("$$E = mc^2$$"); // conversion otherwise intact
		expect(listStore(knowledgeDir)).toHaveLength(0); // nothing persisted, store not created
	});

	it("I3 (F6): OCR probe miss keeps the alt-less image caption-less without failing", async () => {
		const work = makeTempDir("pk-images-work-");
		const knowledgeDir = makeTempDir("pk-images-kb-");
		process.env.PI_KNOWLEDGE_DIR = knowledgeDir;
		process.env.FAKE_SIDECAR_IMAGES = writeTinyPng(work);
		// Deterministic probe miss regardless of whether the host has real tesseract.
		process.env.PI_KNOWLEDGE_OCR_CMD = "pk-definitely-missing-ocr-binary-xyz {input} {output_dir}";
		const pdfPath = writeFixturePdf(work, "paper.pdf", "images probe miss");

		const { markdown } = await convertPdf(pdfPath, resolvePdfSidecarConfig());

		expect(markdown).toContain("![]("); // alt-less image kept (stored + rewritten)
		expect(markdown).not.toContain("*OCR:*");
		// both figure copies share identical bytes → content-addressing collapses them to one file
		expect(listStore(knowledgeDir)).toHaveLength(1);
	});

	it("I4 (F6): PI_KNOWLEDGE_OCR_ENGINE=off never spawns the OCR command", async () => {
		const work = makeTempDir("pk-images-work-");
		const knowledgeDir = makeTempDir("pk-images-kb-");
		process.env.PI_KNOWLEDGE_DIR = knowledgeDir;
		process.env.FAKE_SIDECAR_IMAGES = writeTinyPng(work);
		const counter = join(work, "ocr-counter");
		const script = writeFakeTesseract(work, "SHOULD NEVER APPEAR", counter);
		process.env.PI_KNOWLEDGE_OCR_ENGINE = "off";
		process.env.PI_KNOWLEDGE_OCR_CMD = `${script} {input} {output_dir}`;
		const pdfPath = writeFixturePdf(work, "paper.pdf", "images ocr off");

		const { markdown } = await convertPdf(pdfPath, resolvePdfSidecarConfig());

		expect(markdown).not.toContain("*OCR:*");
		expect(markdown).not.toContain("SHOULD NEVER APPEAR");
		expect(existsSync(counter)).toBe(false); // no probe, no exec
	});

	it("I5 (F6): PI_KNOWLEDGE_OCR_CMD override lands *OCR:* text right after the alt-less image", async () => {
		const work = makeTempDir("pk-images-work-");
		const knowledgeDir = makeTempDir("pk-images-kb-");
		process.env.PI_KNOWLEDGE_DIR = knowledgeDir;
		process.env.FAKE_SIDECAR_IMAGES = writeTinyPng(work);
		const script = writeFakeTesseract(work, "ENERGY DIAGRAM 42 TESLA");
		process.env.PI_KNOWLEDGE_OCR_CMD = `${script} {input} {output_dir}`;
		const pdfPath = writeFixturePdf(work, "paper.pdf", "images ocr fake binary");

		const { markdown } = await convertPdf(pdfPath, resolvePdfSidecarConfig());

		expect(markdown).toContain("*OCR:* ENERGY DIAGRAM 42 TESLA");
		// exactly one OCR paragraph: the alt+caption image (figure-1) skips OCR
		expect(markdown.match(/\*OCR:\*/g)).toHaveLength(1);
		// the OCR paragraph directly follows the rewritten alt-less image line
		const lines = markdown.split("\n");
		const ocrIndex = lines.findIndex((line) => line.startsWith("*OCR:*"));
		expect(ocrIndex).toBeGreaterThan(0);
		expect(lines[ocrIndex - 1]).toBe("");
		expect(lines[ocrIndex - 2]).toMatch(/^!\[\]\(/);
	});
});
