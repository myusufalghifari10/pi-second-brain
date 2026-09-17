import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	convertPdf,
	detectSidecar,
	type PdfSidecarConfig,
	resolvePdfSidecarConfig,
	SidecarError,
} from "../../src/indexer/pdf-sidecar.ts";

const FAKE_SIDECAR = fileURLToPath(new URL("../fixtures/fake-sidecar.mjs", import.meta.url));
const NODE = process.execPath;

const SIDECAR_ENV_KEYS = [
	"PI_KNOWLEDGE_PDF_ENGINE",
	"PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS",
	"PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD",
	"PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD",
	"PI_KNOWLEDGE_PDF_SIDECAR_CMD",
	"PI_KNOWLEDGE_DIR",
	"FAKE_SIDECAR_MODE",
	"FAKE_SIDECAR_COUNTER",
	"FAKE_SIDECAR_ARGV",
	"FAKE_SIDECAR_SLEEP_MS",
];

let tempDirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pk-sidecar-"));
	tempDirs.push(dir);
	return dir;
}

function counterPath(dir: string): string {
	return join(dir, "counter.json");
}

function readCounter(path: string): { count: number; maxOverlapping: number; current: number } {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return { count: 0, maxOverlapping: 0, current: 0 };
	}
}

function writeFixturePdf(dir: string, name: string, marker: string): string {
	const path = join(dir, name);
	writeFileSync(path, Buffer.from(`%PDF-1.4\n${marker}\n%%EOF\n`, "utf-8"));
	return path;
}

describe("pdf sidecar", () => {
	beforeAll(() => {
		chmodSync(FAKE_SIDECAR, 0o755);
	});

	beforeEach(() => {
		savedEnv = {};
		for (const key of SIDECAR_ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		// Isolate the conversion cache for every test so no run ever touches the real
		// knowledge dir's pdf-cache.
		process.env.PI_KNOWLEDGE_DIR = makeTempDir();
	});

	afterEach(() => {
		for (const key of SIDECAR_ENV_KEYS) {
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

	describe("U1 resolvePdfSidecarConfig", () => {
		it("defaults: auto engine, 120s timeout, marker_single/docling commands, no template", () => {
			const config = resolvePdfSidecarConfig();
			expect(config.engine).toBe("auto");
			expect(config.timeoutMs).toBe(120000);
			expect(config.markerCmd).toBe("marker_single");
			expect(config.doclingCmd).toBe("docling");
			expect(config.cmdTemplate).toBeUndefined();
		});

		it("reads all env overrides", () => {
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "docling";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS = "5000";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD = "/opt/marker";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD = "/opt/docling";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `node fake.mjs {input} {output_dir}`;
			const config = resolvePdfSidecarConfig();
			expect(config.engine).toBe("docling");
			expect(config.timeoutMs).toBe(5000);
			expect(config.markerCmd).toBe("/opt/marker");
			expect(config.doclingCmd).toBe("/opt/docling");
			expect(config.cmdTemplate).toBe("node fake.mjs {input} {output_dir}");
		});

		it("invalid engine behaves as auto and warns once", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				process.env.PI_KNOWLEDGE_PDF_ENGINE = "bogus";
				expect(resolvePdfSidecarConfig().engine).toBe("auto");
				expect(resolvePdfSidecarConfig().engine).toBe("auto");
				expect(warn).toHaveBeenCalledTimes(1);
				expect(warn.mock.calls[0]?.[0]).toContain("PI_KNOWLEDGE_PDF_ENGINE");
			} finally {
				warn.mockRestore();
			}
		});

		it("off is preserved verbatim so the engine can bypass everything", () => {
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "off";
			expect(resolvePdfSidecarConfig().engine).toBe("off");
			expect(detectSidecar(resolvePdfSidecarConfig())).resolves.toBe("none");
		});

		it("invalid timeout behaves as the default", () => {
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS = "not-a-number";
			expect(resolvePdfSidecarConfig().timeoutMs).toBe(120000);
		});
	});

	describe("U2 detectSidecar", () => {
		it("probes the template command via --help and caches the result (no second spawn)", async () => {
			const dir = makeTempDir();
			const counter = counterPath(dir);
			// First template token is probed with --help; point it at the fixture so the
			// counter file observes the probe.
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${FAKE_SIDECAR} {input} {output_dir}`;
			process.env.FAKE_SIDECAR_COUNTER = counter;
			const config = resolvePdfSidecarConfig();

			await expect(detectSidecar(config)).resolves.toBe("marker");
			expect(readCounter(counter).count).toBe(1);

			await expect(detectSidecar(config)).resolves.toBe("marker");
			expect(readCounter(counter).count).toBe(1); // cached — no second probe
		});

		it("missing command resolves to none and never throws", async () => {
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = "pk-definitely-missing-binary-xyz {input} {output_dir}";
			await expect(detectSidecar(resolvePdfSidecarConfig())).resolves.toBe("none");
		});

		it("explicit engine probes only its own command", async () => {
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "marker";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD = "pk-also-missing-binary-xyz";
			await expect(detectSidecar(resolvePdfSidecarConfig())).resolves.toBe("none");
		});
	});

	describe("U3 adapter argv", () => {
		it("marker built-in argv is exact and the tmpdir is cleaned up", async () => {
			const dir = makeTempDir();
			const input = writeFixturePdf(dir, "paper.pdf", "marker argv");
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "marker";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD = FAKE_SIDECAR;
			process.env.FAKE_SIDECAR_COUNTER = counterPath(dir);
			process.env.FAKE_SIDECAR_ARGV = join(dir, "argv.json");

			const { markdown, converter } = await convertPdf(input, resolvePdfSidecarConfig());
			expect(converter).toBe("marker");
			expect(markdown).toContain("$$E = mc^2$$");
			expect(markdown).toContain("## Section One");

			const argv = JSON.parse(readFileSync(process.env.FAKE_SIDECAR_ARGV, "utf-8")) as string[];
			expect(argv).toHaveLength(5);
			expect(argv[0]).toBe(input);
			expect(argv[1]).toBe("--output_dir");
			expect(argv[2]).toContain("pdf-sidecar-");
			expect(argv[3]).toBe("--output_format");
			expect(argv[4]).toBe("markdown");
			expect(existsSync(argv[2])).toBe(false); // tmpdir removed in cleanup
		});

		it("docling built-in argv is exact", async () => {
			const dir = makeTempDir();
			const input = writeFixturePdf(dir, "paper.pdf", "docling argv");
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "docling";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD = FAKE_SIDECAR;
			process.env.FAKE_SIDECAR_COUNTER = counterPath(dir);
			process.env.FAKE_SIDECAR_ARGV = join(dir, "argv.json");

			const { converter } = await convertPdf(input, resolvePdfSidecarConfig());
			expect(converter).toBe("docling");

			const argv = JSON.parse(readFileSync(process.env.FAKE_SIDECAR_ARGV, "utf-8")) as string[];
			expect(argv).toHaveLength(5);
			expect(argv[0]).toBe(input);
			expect(argv[1]).toBe("--to");
			expect(argv[2]).toBe("md");
			expect(argv[3]).toBe("--output");
			expect(argv[4]).toContain("pdf-sidecar-");
		});

		it("PI_KNOWLEDGE_PDF_SIDECAR_CMD template substitution is exact", async () => {
			const dir = makeTempDir();
			const input = writeFixturePdf(dir, "paper.pdf", "template argv");
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "marker";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${FAKE_SIDECAR} {input} {output_dir}`;
			process.env.FAKE_SIDECAR_COUNTER = counterPath(dir);
			process.env.FAKE_SIDECAR_ARGV = join(dir, "argv.json");

			const { markdown, converter } = await convertPdf(input, resolvePdfSidecarConfig());
			expect(converter).toBe("marker");
			expect(markdown).toContain("$$E = mc^2$$");

			const argv = JSON.parse(readFileSync(process.env.FAKE_SIDECAR_ARGV, "utf-8")) as string[];
			expect(argv).toEqual([input, argv[1]]);
			expect(argv[1]).toContain("pdf-sidecar-");
			expect(existsSync(argv[1])).toBe(false);
		});
	});

	describe("U4 conversion cache", () => {
		it("caches by content bytes + engine: hits spawn nothing, new bytes/engine miss", async () => {
			const dir = makeTempDir();
			const kbDir = makeTempDir();
			const counter = counterPath(dir);
			process.env.PI_KNOWLEDGE_DIR = kbDir;
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${FAKE_SIDECAR} {input} {output_dir}`;
			// Inert under the template override, but they make this test's detection-cache key
			// unique so the first convert always probes (deterministic spawn counts).
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD = "pk-inert-marker-u4";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD = "pk-inert-docling-u4";
			process.env.FAKE_SIDECAR_COUNTER = counter;
			const cacheDir = join(kbDir, "pdf-cache");

			const input = writeFixturePdf(dir, "paper.pdf", "cache probe A");
			const config: PdfSidecarConfig = resolvePdfSidecarConfig();

			// First convert: detection probe + conversion spawn, cache written.
			const first = await convertPdf(input, config);
			expect(readCounter(counter).count).toBe(2);
			const cacheFiles = readFileSyncSafe(cacheDir);
			expect(cacheFiles).toHaveLength(2);
			expect(cacheFiles.some((name) => name.endsWith(".md"))).toBe(true);
			expect(cacheFiles.some((name) => name.endsWith(".json"))).toBe(true);

			// Same bytes: no spawn, identical markdown from cache.
			const second = await convertPdf(input, config);
			expect(readCounter(counter).count).toBe(2);
			expect(second.markdown).toBe(first.markdown);
			expect(second.converter).toBe("marker");

			// Different bytes: cache miss, new spawn + new cache entries.
			const other = writeFixturePdf(dir, "other.pdf", "cache probe B");
			await convertPdf(other, config);
			expect(readCounter(counter).count).toBe(3);
			expect(readFileSyncSafe(cacheDir)).toHaveLength(4);

			// Engine bump changes the key even for identical bytes.
			process.env.PI_KNOWLEDGE_PDF_ENGINE = "docling";
			const doclingResult = await convertPdf(input, resolvePdfSidecarConfig());
			expect(doclingResult.converter).toBe("docling");
			expect(readCounter(counter).count).toBe(5); // fresh detection probe + conversion
			expect(readFileSyncSafe(cacheDir)).toHaveLength(6);
		});
	});

	describe("U5 fail-open failures", () => {
		it("non-zero exit", async () => {
			const { failure, outputDir } = await convertWithMode("fail");
			expect(failure).toBe("nonzero_exit");
			expect(existsSync(outputDir)).toBe(false);
		});

		it("missing markdown output", async () => {
			const { failure, outputDir } = await convertWithMode("no_output");
			expect(failure).toBe("missing_output");
			expect(existsSync(outputDir)).toBe(false);
		});

		it("empty output", async () => {
			const { failure, outputDir } = await convertWithMode("empty");
			expect(failure).toBe("empty_output");
			expect(existsSync(outputDir)).toBe(false);
		});

		it("output containing a NUL byte", async () => {
			const { failure, outputDir } = await convertWithMode("nul");
			expect(failure).toBe("invalid_output");
			expect(existsSync(outputDir)).toBe(false);
		});

		it("timeout kills the child and cleans the tmpdir", async () => {
			const dir = makeTempDir();
			const input = writeFixturePdf(dir, "paper.pdf", "timeout probe");
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS = "300";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${NODE} ${FAKE_SIDECAR} {input} {output_dir}`;
			process.env.FAKE_SIDECAR_MODE = "sleep";
			process.env.FAKE_SIDECAR_SLEEP_MS = "30000";
			process.env.FAKE_SIDECAR_ARGV = join(dir, "argv.json");

			const error = await convertPdf(input, resolvePdfSidecarConfig()).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(SidecarError);
			expect((error as SidecarError).failure).toBe("timeout");
			const argv = JSON.parse(readFileSync(process.env.FAKE_SIDECAR_ARGV ?? "", "utf-8")) as string[];
			expect(existsSync(argv[3])).toBe(false);
		});

		async function convertWithMode(mode: string): Promise<{ failure: string; outputDir: string }> {
			const dir = makeTempDir();
			const input = writeFixturePdf(dir, "paper.pdf", `mode ${mode}`);
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${NODE} ${FAKE_SIDECAR} {input} {output_dir}`;
			process.env.FAKE_SIDECAR_MODE = mode;
			process.env.FAKE_SIDECAR_ARGV = join(dir, "argv.json");
			const error = await convertPdf(input, resolvePdfSidecarConfig()).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(SidecarError);
			const argv = JSON.parse(readFileSync(process.env.FAKE_SIDECAR_ARGV ?? "", "utf-8")) as string[];
			return { failure: (error as SidecarError).failure, outputDir: argv[3] };
		}
	});

	describe("U6 conversion mutex", () => {
		it("serializes two concurrent slow conversions (overlap never exceeds 1)", async () => {
			const dir = makeTempDir();
			const counter = counterPath(dir);
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD = `${NODE} ${FAKE_SIDECAR} {input} {output_dir}`;
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD = "pk-inert-marker-u6";
			process.env.PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD = "pk-inert-docling-u6";
			process.env.FAKE_SIDECAR_MODE = "sleep";
			process.env.FAKE_SIDECAR_SLEEP_MS = "600";
			process.env.FAKE_SIDECAR_COUNTER = counter;
			const config = resolvePdfSidecarConfig();

			const a = writeFixturePdf(dir, "a.pdf", "mutex A");
			const b = writeFixturePdf(dir, "b.pdf", "mutex B");
			const [ra, rb] = await Promise.all([convertPdf(a, config), convertPdf(b, config)]);
			expect(ra.markdown).toBe(rb.markdown);

			const state = readCounter(counter);
			expect(state.count).toBe(2);
			expect(state.maxOverlapping).toBe(1);
		});
	});
});

function readFileSyncSafe(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir);
}
