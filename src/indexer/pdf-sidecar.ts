// Optional external PDF converter sidecar (marker primary, docling alternative).
//
// Contract (docs/layer2-pdf-sidecar-plan.md §3): every failure is fail-open — the module
// throws typed `SidecarError`s and the caller falls back to the built-in unpdf extraction.
// No npm dependencies: sidecars are user-installed external binaries invoked as subprocesses
// via execFile (argv array, never a shell, so crafted PDF paths cannot inject commands).
// Module state is lazy: nothing here runs at extension startup; detection is probed at most
// once per command identity per process and conversions are cached by content hash.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getDefaultKnowledgeDir } from "../storage/sqlite.ts";

export type PdfSidecarEngineSetting = "auto" | "marker" | "docling" | "off";
export type SidecarConverter = "marker" | "docling";

export type SidecarFailureCause =
	| "engine_off"
	| "engine_unavailable"
	| "aborted"
	| "spawn_failed"
	| "timeout"
	| "output_overflow"
	| "nonzero_exit"
	| "missing_output"
	| "empty_output"
	| "invalid_output";

export class SidecarError extends Error {
	readonly failure: SidecarFailureCause;

	constructor(failure: SidecarFailureCause, message: string) {
		super(message);
		this.name = "SidecarError";
		this.failure = failure;
	}
}

export interface PdfSidecarConfig {
	engine: PdfSidecarEngineSetting;
	timeoutMs: number;
	markerCmd: string;
	doclingCmd: string;
	cmdTemplate?: string;
}

const DEFAULT_TIMEOUT_MS = 120000;
const DETECT_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BUFFER_BYTES = 8 * 1024 * 1024;
const MIN_MARKDOWN_CHARS = 50;

// Bumped whenever adapter argv construction or output parsing changes, so stale cached
// conversions are never reused across arg-shape changes.
const ADAPTER_VERSION = "v1-marker-single-docling-md-1";

const execFileAsync = promisify(execFile);

let warnedInvalidEngine = false;
let warnedInvalidTimeout = false;

export function resolvePdfSidecarConfig(): PdfSidecarConfig {
	const engineRaw = process.env.PI_KNOWLEDGE_PDF_ENGINE?.trim().toLowerCase();
	let engine: PdfSidecarEngineSetting = "auto";
	if (engineRaw) {
		if (engineRaw === "auto" || engineRaw === "marker" || engineRaw === "docling" || engineRaw === "off") {
			engine = engineRaw;
		} else if (!warnedInvalidEngine) {
			warnedInvalidEngine = true;
			console.warn(
				`pi-knowledge: invalid PI_KNOWLEDGE_PDF_ENGINE "${engineRaw}"; behaving as "auto" (expected auto|marker|docling|off)`,
			);
		}
	}

	let timeoutMs = DEFAULT_TIMEOUT_MS;
	const timeoutRaw = process.env.PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS?.trim();
	if (timeoutRaw) {
		const parsed = Number(timeoutRaw);
		if (Number.isFinite(parsed) && parsed > 0) {
			timeoutMs = parsed;
		} else if (!warnedInvalidTimeout) {
			warnedInvalidTimeout = true;
			console.warn(
				`pi-knowledge: invalid PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS "${timeoutRaw}"; using ${DEFAULT_TIMEOUT_MS}ms`,
			);
		}
	}

	const markerCmd = process.env.PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD?.trim() || "marker_single";
	const doclingCmd = process.env.PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD?.trim() || "docling";
	const cmdTemplate = process.env.PI_KNOWLEDGE_PDF_SIDECAR_CMD?.trim() || undefined;

	return { engine, timeoutMs, markerCmd, doclingCmd, cmdTemplate };
}

// §3.2 detection: probe `<cmd> --help` with a 10s budget; ENOENT/non-zero/timeout ⇒ not
// available. Detection never throws. Results are cached per command identity for the
// process lifetime, so heavy CLI startups run at most once per distinct command.
const detectionCache = new Map<string, SidecarConverter | "none">();

function templateFirstToken(config: PdfSidecarConfig): string | undefined {
	return config.cmdTemplate?.split(/\s+/).filter(Boolean)[0];
}

function commandFor(converter: SidecarConverter, config: PdfSidecarConfig): string {
	const firstToken = templateFirstToken(config);
	if (firstToken) return firstToken;
	return converter === "marker" ? config.markerCmd : config.doclingCmd;
}

function detectionCacheKey(config: PdfSidecarConfig): string {
	return [config.engine, config.markerCmd, config.doclingCmd, templateFirstToken(config) ?? ""].join("\0");
}

async function probeAvailable(cmd: string): Promise<boolean> {
	try {
		await execFileAsync(cmd, ["--help"], { timeout: DETECT_TIMEOUT_MS, windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

export async function detectSidecar(config: PdfSidecarConfig): Promise<SidecarConverter | "none"> {
	if (config.engine === "off") return "none";
	const key = detectionCacheKey(config);
	const cached = detectionCache.get(key);
	if (cached) return cached;

	const candidates: SidecarConverter[] = config.engine === "auto" ? ["marker", "docling"] : [config.engine];
	let result: SidecarConverter | "none" = "none";
	for (const candidate of candidates) {
		if (await probeAvailable(commandFor(candidate, config))) {
			result = candidate;
			break;
		}
	}
	detectionCache.set(key, result);
	return result;
}

// §3.3 cache: content-addressed under `<knowledge-dir>/pdf-cache/`, shared across KBs and
// never deleted by knowledge_remove. Reset hatch: `rm -rf <knowledge-dir>/pdf-cache`.
// Growth is unbounded by design (one small .md per distinct PDF).
interface CacheMeta {
	engine: string;
	converter: string;
	convertedAt: string;
	sourceBytes: number;
}

function cacheKeyFor(pdfBytes: Buffer, engine: string): string {
	const contentHash = createHash("sha256").update(pdfBytes).digest("hex");
	return createHash("sha256").update(`${contentHash}\0${engine}\0${ADAPTER_VERSION}`).digest("hex");
}

function readCache(key: string): string | undefined {
	try {
		const metaPath = join(getDefaultKnowledgeDir(), "pdf-cache", `${key}.json`);
		const mdPath = join(getDefaultKnowledgeDir(), "pdf-cache", `${key}.md`);
		if (!existsSync(metaPath) || !existsSync(mdPath)) return undefined;
		const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Partial<CacheMeta> | null;
		if (!meta || typeof meta.engine !== "string" || (meta.converter !== "marker" && meta.converter !== "docling")) {
			return undefined;
		}
		// Re-validate the cached markdown exactly like fresh adapter output (readAdapterOutput):
		// strict UTF-8, no NUL byte, non-trivial length. Anything else is a cache miss so the
		// stale pair is ignored and reconversion rewrites it.
		const markdown = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(mdPath));
		if (markdown.includes("\0")) return undefined;
		if (markdown.trim().length < MIN_MARKDOWN_CHARS) return undefined;
		return markdown;
	} catch {
		return undefined; // corrupt/missing cache entries are cache misses, never errors
	}
}

function writeCache(key: string, markdown: string, meta: CacheMeta): void {
	// Cache writes are best-effort: an unwritable cache dir must not fail an otherwise
	// successful conversion. Temp files land in the same cache dir and are renamed into
	// place md-first, json-last — a valid <key>.json is the commit marker, so an interrupted
	// write never presents a committed half-pair, and no temp files remain after success.
	const tempPaths: string[] = [];
	try {
		const dir = join(getDefaultKnowledgeDir(), "pdf-cache");
		mkdirSync(dir, { recursive: true });
		const suffix = randomUUID();
		const mdTemp = join(dir, `${key}.${suffix}.md.tmp`);
		const metaTemp = join(dir, `${key}.${suffix}.json.tmp`);
		tempPaths.push(mdTemp, metaTemp);
		writeFileSync(mdTemp, markdown);
		writeFileSync(metaTemp, JSON.stringify(meta));
		renameSync(mdTemp, join(dir, `${key}.md`));
		renameSync(metaTemp, join(dir, `${key}.json`));
	} catch {
		/* ignore */
	} finally {
		for (const tempPath of tempPaths) rmSync(tempPath, { force: true });
	}
}

// §3.4 concurrency: sidecars are RAM/GPU-heavy, so conversions are serialized through a
// module-level mutex. The engine's scanning loop is sequential already; the mutex is defense
// against overlapping callers, not orchestration.
let mutexTail: Promise<unknown> = Promise.resolve();

export async function convertPdf(
	filePath: string,
	config: PdfSidecarConfig,
	signal?: AbortSignal,
): Promise<{ markdown: string; converter: SidecarConverter }> {
	const run = () => runConversion(filePath, config, signal);
	const attempted = mutexTail.then(run, run);
	mutexTail = attempted.catch(() => undefined);
	return attempted;
}

async function runConversion(
	filePath: string,
	config: PdfSidecarConfig,
	signal?: AbortSignal,
): Promise<{ markdown: string; converter: SidecarConverter }> {
	if (signal?.aborted) throw new SidecarError("aborted", `PDF conversion aborted before start: ${basename(filePath)}`);
	const converter = await detectSidecar(config);
	if (converter === "none") {
		throw new SidecarError(
			"engine_unavailable",
			`No PDF sidecar available (engine=${config.engine}): ${basename(filePath)}`,
		);
	}
	const pdfBytes = readFileSync(filePath);
	const key = cacheKeyFor(pdfBytes, converter);
	const cached = readCache(key);
	if (cached !== undefined) return { markdown: cached, converter };

	const markdown = await runAdapter(filePath, converter, config, signal);
	writeCache(key, markdown, {
		engine: config.engine,
		converter,
		convertedAt: new Date().toISOString(),
		sourceBytes: pdfBytes.length,
	});
	return { markdown, converter };
}

interface AdapterArgv {
	file: string;
	args: string[];
	outputDir: string;
}

function buildAdapterArgv(
	filePath: string,
	outputDir: string,
	config: PdfSidecarConfig,
	converter: SidecarConverter,
): AdapterArgv {
	if (config.cmdTemplate) {
		const parts = config.cmdTemplate
			.split(/\s+/)
			.filter(Boolean)
			.map((part) => part.replaceAll("{input}", filePath).replaceAll("{output_dir}", outputDir));
		const [file, ...args] = parts;
		if (!file) throw new SidecarError("spawn_failed", "PI_KNOWLEDGE_PDF_SIDECAR_CMD is empty after trimming");
		return { file, args, outputDir };
	}
	if (converter === "marker") {
		return {
			file: config.markerCmd,
			args: [filePath, "--output_dir", outputDir, "--output_format", "markdown"],
			outputDir,
		};
	}
	return { file: config.doclingCmd, args: [filePath, "--to", "md", "--output", outputDir], outputDir };
}

async function runAdapter(
	filePath: string,
	converter: SidecarConverter,
	config: PdfSidecarConfig,
	signal?: AbortSignal,
): Promise<string> {
	const outputDir = mkdtempSync(join(tmpdir(), "pdf-sidecar-"));
	try {
		const argv = buildAdapterArgv(filePath, outputDir, config, converter);
		try {
			await execFileAsync(argv.file, argv.args, {
				timeout: config.timeoutMs,
				signal,
				maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
				windowsHide: true,
			});
		} catch (error) {
			throw classifyExecFailure(error, filePath, signal);
		}
		return readAdapterOutput(argv.outputDir, filePath, converter);
	} finally {
		rmSync(outputDir, { recursive: true, force: true });
	}
}

function execFailureInfo(error: unknown): {
	code: string | undefined;
	killed: boolean;
	stderrTail: string;
	abortError: boolean;
} {
	const err = error as { code?: unknown; killed?: unknown; stderr?: unknown; name?: unknown };
	const stderr = err.stderr;
	const stderrText =
		typeof stderr === "string"
			? stderr
			: typeof Buffer !== "undefined" && Buffer.isBuffer(stderr)
				? stderr.toString("utf-8")
				: "";
	const abortError = err.name === "AbortError";
	return {
		code: typeof err.code === "string" ? err.code : undefined,
		killed: err.killed === true,
		stderrTail: stderrText.slice(-500),
		abortError,
	};
}

function classifyExecFailure(error: unknown, filePath: string, signal?: AbortSignal): SidecarError {
	const info = execFailureInfo(error);
	const label = basename(filePath);
	if (signal?.aborted || info.abortError) {
		return new SidecarError("aborted", `PDF sidecar conversion aborted: ${label}`);
	}
	if (info.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
		return new SidecarError(
			"output_overflow",
			`PDF sidecar exceeded ${MAX_OUTPUT_BUFFER_BYTES}-byte output buffer: ${label}`,
		);
	}
	if (info.killed) {
		return new SidecarError("timeout", `PDF sidecar conversion timed out: ${label} ${info.stderrTail}`.trim());
	}
	if (info.code === "ENOENT" || info.code === "EACCES") {
		return new SidecarError("spawn_failed", `PDF sidecar command could not be spawned (${info.code}): ${label}`);
	}
	const exitCode = info.code ?? "unknown";
	return new SidecarError(
		"nonzero_exit",
		`PDF sidecar exited with code ${exitCode}: ${label} ${info.stderrTail}`.trim(),
	);
}

function readAdapterOutput(outputDir: string, filePath: string, converter: SidecarConverter): string {
	let mdPath: string;
	if (converter === "docling") {
		mdPath = join(outputDir, `${basename(filePath).replace(/\.[^.]+$/, "")}.md`);
	} else {
		// marker (and the argv-template escape hatch) write a markdown file next to an
		// optional images subdir; read the single largest *.md and ignore everything else.
		const candidates = readdirSync(outputDir)
			.filter((name) => name.toLowerCase().endsWith(".md"))
			.map((name) => join(outputDir, name));
		if (candidates.length === 0) {
			throw new SidecarError("missing_output", `PDF sidecar wrote no markdown output: ${basename(filePath)}`);
		}
		mdPath = candidates.reduce((largest, current) =>
			statSync(current).size > statSync(largest).size ? current : largest,
		);
	}

	let markdown: string;
	try {
		const bytes = readFileSync(mdPath);
		markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new SidecarError(
			"missing_output",
			`PDF sidecar markdown output is missing or unreadable: ${basename(filePath)}`,
		);
	}
	if (markdown.includes("\0")) {
		throw new SidecarError("invalid_output", `PDF sidecar markdown output contains a NUL byte: ${basename(filePath)}`);
	}
	if (markdown.trim().length < MIN_MARKDOWN_CHARS) {
		throw new SidecarError("empty_output", `PDF sidecar markdown output is effectively empty: ${basename(filePath)}`);
	}
	return markdown;
}
