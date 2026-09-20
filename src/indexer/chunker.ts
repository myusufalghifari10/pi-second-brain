import { createHash } from "node:crypto";
import { closeSync, type Dirent, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ignore from "ignore";
import type { ChunkInsert, KnowledgeSymbolInsert } from "../storage/sqlite.ts";
import {
	canonicalizeMathText,
	extractDisplayFormulas,
	extractTexLabels,
	extractTexRefs,
	extractWikiLinks,
	MAX_MATH_BLOCK_CHARS,
	parseFrontmatter,
	type Segment,
	splitOversizedProtected,
	splitProtectedSegments,
} from "./math-text.ts";
import { extractSymbols } from "./symbols.ts";
import { rewriteUnitTokens } from "./units.ts";

type ChunkMetadataValue = string | number | boolean | string[] | number[] | boolean[] | null | undefined;
type ChunkMetadata = Record<string, ChunkMetadataValue>;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Byte cap for one ingestion read — shared with the engine's single-file read path. */
export const MAX_SOURCE_FILE_SIZE = MAX_FILE_SIZE;

const DOCUMENT_EXTENSIONS: Record<string, true> = { ".doc": true, ".docx": true, ".pdf": true };

const BINARY_EXTENSIONS: Record<string, true> = {
	".7z": true,
	".a": true,
	".avi": true,
	".bin": true,
	".bmp": true,
	".bz2": true,
	".dat": true,
	".db": true,
	".dll": true,
	".dylib": true,
	".eot": true,
	".exe": true,
	".gif": true,
	".gz": true,
	".ico": true,
	".jpg": true,
	".jpeg": true,
	".lib": true,
	".lock": true,
	".mov": true,
	".mp3": true,
	".mp4": true,
	".node": true,
	".o": true,
	".otf": true,
	".ppt": true,
	".rar": true,
	".so": true,
	".sqlite": true,
	".svg": true,
	".tar": true,
	".ttf": true,
	".wasm": true,
	".wav": true,
	".webm": true,
	".webp": true,
	".woff": true,
	".woff2": true,
	".xls": true,
	".xlsx": true,
	".zip": true,
};

const DEFAULT_SUGGESTED_EXCLUDE = [
	"node_modules",
	".git",
	"dist",
	"build",
	"bin",
	"obj",
	"out",
	"target",
	"coverage",
	".next",
	".cache",
	".playwright",
	".browser",
	".browsers",
	"__pycache__",
	"*.app",
	"*.asar",
	"*.asar.unpacked",
	"*.pak",
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"*.crt",
	"*.cert",
	"*secret*",
	"*secrets*",
	"*credential*",
	"*credentials*",
	"docs/*eval-report*.md",
	"docs/*evaluation-report*.md",
	"docs/*knowledge-base*report*.md",
	"*knowledge-base-evaluation-report*.md",
	"*knowledge*.jsonl",
	"*.min.js",
	"*.min.css",
	"*.map",
	"*.lock",
	"package-lock.json",
	"playwright-report",
	"test-results",
	"browser-cache",
	"ms-playwright",
	".DS_Store",
	"Thumbs.db",
	"*.pyc",
	"*.class",
];

export interface ScanOptions {
	includeSuggestedText?: boolean;
	includePaths?: string[];
	excludePaths?: string[];
}

export interface ScannedFile {
	path: string; // absolute path
	relPath: string; // relative to root
	content: string;
	fileType: string;
}

export interface ScannableFile {
	path: string; // absolute path
	relPath: string; // relative to root
	fileType: string;
	size: number;
}

export interface SkippedScanEntry {
	path: string;
	reason:
		| "suggested_excluded"
		| "oversized"
		| "binary"
		| "unreadable"
		| "inaccessible"
		| "extraction_failed"
		| "pdf_sidecar_failed";
	size?: number;
}

export interface ScanResult {
	files: ScannedFile[];
	skipped: {
		total: number;
		by_reason: Record<SkippedScanEntry["reason"], number>;
		samples: SkippedScanEntry[];
	};
}

const MAX_SKIPPED_SAMPLES = 25;

export function createSkippedScanStats(): ScanResult["skipped"] {
	return {
		total: 0,
		by_reason: {
			suggested_excluded: 0,
			oversized: 0,
			binary: 0,
			unreadable: 0,
			inaccessible: 0,
			extraction_failed: 0,
			pdf_sidecar_failed: 0,
		},
		samples: [],
	};
}

function addSkipped(skipped: ScanResult["skipped"], entry: SkippedScanEntry): void {
	skipped.total++;
	skipped.by_reason[entry.reason]++;
	if (skipped.samples.length < MAX_SKIPPED_SAMPLES) skipped.samples.push(entry);
}

export function addSkippedScanEntry(skipped: ScanResult["skipped"], entry: SkippedScanEntry): void {
	addSkipped(skipped, entry);
}

export function summarizeSkippedScan(skipped: ScanResult["skipped"]): string {
	return (
		Object.entries(skipped.by_reason)
			.filter(([, count]) => count > 0)
			.map(([reason, count]) => `${reason}: ${count}`)
			.join(", ") || "none"
	);
}

function detectFileType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".mjs": "javascript",
		".py": "python",
		".go": "go",
		".rs": "rust",
		".java": "java",
		".c": "c",
		".cpp": "cpp",
		".cc": "cpp",
		".cxx": "cpp",
		".h": "text",
		".hpp": "cpp",
		".hh": "cpp",
		".hxx": "cpp",
		".qml": "qml",
		".md": "markdown",
		".mdx": "markdown",
		".json": "json",
		".yaml": "yaml",
		".yml": "yaml",
		".toml": "toml",
		".html": "html",
		".css": "css",
		".scss": "css",
		".sh": "bash",
		".bash": "bash",
		".zsh": "shell",
		".sql": "sql",
		".graphql": "graphql",
		".pdf": "pdf",
		".doc": "docx",
		".docx": "docx",
		".txt": "text",
		".csv": "text",
		".log": "text",
		".tex": "latex",
		".ltx": "latex",
		".latex": "latex",
	};
	return map[ext] ?? "text";
}

export function isSupportedDocumentFile(filePath: string): boolean {
	return DOCUMENT_EXTENSIONS[extname(filePath).toLowerCase()] === true;
}

function isBinaryFile(filePath: string): boolean {
	if (isSupportedDocumentFile(filePath)) return false;
	if (BINARY_EXTENSIONS[extname(filePath).toLowerCase()] === true) return true;
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const sample = Buffer.alloc(512);
		const bytesRead = readSync(fd, sample, 0, sample.length, 0);
		if (bytesRead === 0) return false;
		return sample.subarray(0, bytesRead).includes(0x00);
	} catch {
		return true;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function buildIgnoreMatcher(dirPath: string): ReturnType<typeof ignore> {
	const ig = ignore();
	ig.add(DEFAULT_SUGGESTED_EXCLUDE);

	const gitignorePath = join(dirPath, ".gitignore");
	if (existsSync(gitignorePath)) {
		try {
			ig.add(readFileSync(gitignorePath, "utf-8"));
		} catch {
			// .gitignore vanished between existsSync and read (git checkout/clean race): proceed
			// with the defaults only instead of throwing inside an unguarded scan path.
		}
	}

	return ig;
}

function normalizeScanPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeScanPaths(paths: string[] | undefined): string[] {
	return (paths ?? []).map(normalizeScanPath).filter(Boolean);
}

function pathMatches(relPath: string, patterns: string[]): boolean {
	const normalized = normalizeScanPath(relPath);
	return patterns.some((pattern) => normalized === pattern || normalized.startsWith(`${pattern}/`));
}

function directoryCouldContainIncludedPath(relPath: string, includePaths: string[]): boolean {
	const normalized = normalizeScanPath(relPath);
	return includePaths.some((includePath) => includePath.startsWith(`${normalized}/`));
}

export function* iterateScannableFiles(
	dirPath: string,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
): Generator<ScannableFile> {
	const ig = buildIgnoreMatcher(dirPath);
	const includePaths = normalizeScanPaths(options.includePaths);
	const excludePaths = normalizeScanPaths(options.excludePaths);
	const includeSuggestedText = options.includeSuggestedText === true;

	function* walk(dir: string): Generator<ScannableFile> {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			addSkipped(skipped, { path: relative(dirPath, dir).split(sep).join("/") || ".", reason: "inaccessible" });
			return;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relPath = relative(dirPath, fullPath).split(sep).join("/");
			const explicitlyIncluded = pathMatches(relPath, includePaths);

			if (pathMatches(relPath, excludePaths)) {
				addSkipped(skipped, { path: relPath, reason: "suggested_excluded" });
				continue;
			}

			if (ig.ignores(relPath) && !includeSuggestedText && !explicitlyIncluded) {
				if (entry.isDirectory() && directoryCouldContainIncludedPath(relPath, includePaths)) {
					yield* walk(fullPath);
					continue;
				}
				addSkipped(skipped, { path: relPath, reason: "suggested_excluded" });
				continue;
			}

			if (entry.isDirectory()) {
				if (ig.ignores(`${relPath}/`) && !includeSuggestedText && !explicitlyIncluded) {
					if (directoryCouldContainIncludedPath(relPath, includePaths)) {
						yield* walk(fullPath);
						continue;
					}
					addSkipped(skipped, { path: `${relPath}/`, reason: "suggested_excluded" });
					continue;
				}
				yield* walk(fullPath);
			} else if (entry.isFile()) {
				let size = 0;
				try {
					size = statSync(fullPath).size;
				} catch {
					addSkipped(skipped, { path: relPath, reason: "unreadable" });
					continue;
				}
				if (size > MAX_FILE_SIZE) {
					addSkipped(skipped, { path: relPath, reason: "oversized", size });
					continue;
				}
				if (isBinaryFile(fullPath)) {
					addSkipped(skipped, { path: relPath, reason: "binary", size });
					continue;
				}

				yield { path: fullPath, relPath, fileType: detectFileType(fullPath), size };
			}
		}
	}

	yield* walk(dirPath);
}

export function* iterateScannedFiles(
	dirPath: string,
	skipped: ScanResult["skipped"] = createSkippedScanStats(),
	options: ScanOptions = {},
): Generator<ScannedFile> {
	for (const file of iterateScannableFiles(dirPath, skipped, options)) {
		try {
			const content = readFileSync(file.path, "utf-8");
			yield { ...file, content };
		} catch {
			addSkipped(skipped, { path: file.relPath, reason: "unreadable", size: file.size });
		}
	}
}

export function walkDir(dirPath: string, options: ScanOptions = {}): ScannedFile[] {
	return walkDirDetailed(dirPath, options).files;
}

export function walkDirDetailed(dirPath: string, options: ScanOptions = {}): ScanResult {
	const results: ScannedFile[] = [];
	const skipped = createSkippedScanStats();
	for (const file of iterateScannedFiles(dirPath, skipped, options)) results.push(file);
	return { files: results, skipped };
}

export function isReadableTextFile(filePath: string): boolean {
	return !isBinaryFile(filePath);
}

// --- Chunking ---

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}

const MARKDOWN_TARGET_TOKENS = 450;
const TEXT_TARGET_TOKENS = 550;
const MAX_TEXT_CHUNK_CHARS = 6_000;

export function preTokenizeForFTS(content: string): string {
	// Canonicalization MUST run after the existing chain (canonicalize-last): running it
	// first would let the letter-digit split shred freshly minted composite tokens
	// (pow2 → "pow 2", with "2" dropped by the length filter).
	return rewriteUnitTokens(
		canonicalizeMathText(
			content
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
				.replace(/([a-zA-Z])(\d)/g, "$1 $2")
				.replace(/(\d)([a-zA-Z])/g, "$1 $2")
				.replace(/([\u4e00-\u9fff\u3400-\u4dbf])/g, " $1 ")
				.replace(/\s+/g, " ")
				.trim(),
		),
	);
}

export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function chunkIdentityHash(opts: {
	content: string;
	filePath: string;
	fileType: string;
	startLine: number;
	endLine: number;
	metadataJson: string;
}): string {
	return contentHash(
		[opts.filePath, opts.fileType, String(opts.startLine), String(opts.endLine), opts.metadataJson, opts.content].join(
			"\0",
		),
	);
}

function normalizeHeading(heading: string): string {
	return heading.replace(/^#{1,6}\s+/, "").trim();
}

// Hard guard for the added metadata prefix (Title through Formulas): candidate lines are
// appended whole — never truncated mid-line — until the next line would push the combined
// added length past 1500 chars; that line and every later candidate line is dropped.
const CONTEXT_PREFIX_MAX_CHARS = 1500;

function buildContextPrefix(filePath: string, fileType: string, metadata: ChunkMetadata): string {
	const parts = [`File: ${filePath}`, `Type: ${fileType}`];
	const heading = typeof metadata.heading === "string" ? metadata.heading : "";
	const breadcrumb = typeof metadata.breadcrumb === "string" ? metadata.breadcrumb : "";
	const language = typeof metadata.language === "string" ? metadata.language : "";
	const symbol =
		typeof metadata.symbol === "string"
			? metadata.symbol
			: typeof metadata.function_name === "string"
				? metadata.function_name
				: "";
	const symbolKind = typeof metadata.symbol_kind === "string" ? metadata.symbol_kind : "";
	const parentSymbol = typeof metadata.parent_symbol === "string" ? metadata.parent_symbol : "";
	const signature = typeof metadata.signature === "string" ? metadata.signature : "";
	const scope = Array.isArray(metadata.scope) ? metadata.scope.filter((item) => typeof item === "string") : [];
	if (breadcrumb) parts.push(`Section: ${breadcrumb}`);
	else if (heading) parts.push(`Section: ${normalizeHeading(heading)}`);
	if (language) parts.push(`Language: ${language}`);
	if (scope.length > 0) parts.push(`Scope: ${scope.join(" > ")}`);
	else if (parentSymbol) parts.push(`Parent: ${parentSymbol}`);
	if (symbolKind) parts.push(`Kind: ${symbolKind}`);
	if (symbol) parts.push(`Symbol: ${symbol}`);
	if (signature) parts.push(`Signature: ${signature}`);
	const title = typeof metadata.title === "string" ? metadata.title : "";
	const tags = stringList(metadata.tags);
	const aliases = stringList(metadata.aliases);
	const links = stringList(metadata.links);
	const labels = stringList(metadata.labels);
	const formulaLine = renderFormulasPrefix(stringList(metadata.formulas));
	const metadataLines: string[] = [];
	if (title) metadataLines.push(`Title: ${title}`);
	if (tags.length > 0) metadataLines.push(`Tags: ${tags.join(", ")}`);
	if (aliases.length > 0) metadataLines.push(`Aliases: ${aliases.join(", ")}`);
	if (links.length > 0) metadataLines.push(`Links: ${links.join(", ")}`);
	if (labels.length > 0) metadataLines.push(`Labels: ${labels.join(", ")}`);
	if (formulaLine) metadataLines.push(`Formulas: ${formulaLine}`);
	const converter = typeof metadata.converter === "string" ? metadata.converter : "";
	if (converter) metadataLines.push(`Converter: ${converter}`);
	let guardedChars = 0;
	for (const line of metadataLines) {
		if (guardedChars + line.length > CONTEXT_PREFIX_MAX_CHARS) break;
		parts.push(line);
		guardedChars += line.length;
	}
	return parts.join("\n");
}

function stringList(value: ChunkMetadataValue): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Formulas: whitespace-collapsed, " | "-joined, each ≤300 chars, max 5 in the prefix.
// The combined length of all added prefix lines (this one included) is capped by
// CONTEXT_PREFIX_MAX_CHARS in buildContextPrefix, which drops whole lines once exceeded.
function renderFormulasPrefix(formulas: string[]): string {
	const rendered: string[] = [];
	let total = 0;
	for (const formula of formulas) {
		if (rendered.length >= 5 || total >= 1500) break;
		const piece = formula.replace(/\s+/g, " ").trim().slice(0, 300);
		if (!piece) continue;
		rendered.push(piece);
		total += piece.length;
	}
	return rendered.join(" | ");
}

export function buildChunkEmbeddingText(
	chunk: Pick<ChunkInsert, "content" | "file_path" | "file_type" | "metadata_json">,
): string {
	let metadata: ChunkMetadata = {};
	try {
		metadata = JSON.parse(chunk.metadata_json) as ChunkMetadata;
	} catch {
		metadata = {};
	}
	return `${buildContextPrefix(chunk.file_path, chunk.file_type, metadata)}\n\n${chunk.content}`;
}

function makeChunk(
	content: string,
	filePath: string,
	fileType: string,
	startLine: number,
	endLine: number,
	metadata: ChunkMetadata = {},
): Omit<ChunkInsert, "kb_id"> {
	const metadata_json = JSON.stringify(metadata);
	const chunk = {
		content_hash: chunkIdentityHash({ content, filePath, fileType, startLine, endLine, metadataJson: metadata_json }),
		content,
		content_tokenized: "",
		file_path: filePath,
		file_type: fileType,
		start_line: startLine,
		end_line: endLine,
		metadata_json,
	};
	return { ...chunk, content_tokenized: preTokenizeForFTS(buildChunkEmbeddingText(chunk)) };
}

interface ChunkBlock {
	text: string;
	startLine: number;
	endLine: number;
	segment?: Segment; // present for protected atomic blocks
}

function paragraphBlocks(text: string, startLine: number): ChunkBlock[] {
	const blocks: ChunkBlock[] = [];
	const lines = text.split("\n");
	let runStart = 0;
	const pushRun = (endExcl: number) => {
		const paraText = lines.slice(runStart, endExcl).join("\n");
		if (paraText.trim().length > 0) {
			blocks.push({ text: paraText, startLine: startLine + runStart, endLine: startLine + endExcl - 1 });
		}
	};
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === "") {
			if (i > runStart) pushRun(i);
			runStart = i + 1;
		}
	}
	if (runStart < lines.length) pushRun(lines.length);
	return blocks;
}

function markdownBlocks(text: string, startLine: number): ChunkBlock[] {
	const offset = startLine - 1;
	const blocks: ChunkBlock[] = [];
	for (const segment of splitProtectedSegments(text, "markdown")) {
		if (segment.kind === "text") {
			blocks.push(...paragraphBlocks(segment.text, segment.startLine + offset));
		} else {
			blocks.push({
				text: segment.text,
				startLine: segment.startLine + offset,
				endLine: segment.endLine + offset,
				segment,
			});
		}
	}
	return blocks;
}

function pushOversizedText(
	text: string,
	start: number,
	formulas: string[],
	pushChunk: (text: string, startLine: number, endLine: number, formulas: string[]) => void,
): void {
	let offset = 0;
	let sliceStart = start;
	while (offset < text.length) {
		// Advance by the RAW slice's line count: trim() can remove trailing blank lines and
		// undercount consumed lines, drifting every later chunk's start/end lines earlier.
		const rawSlice = text.slice(offset, offset + MAX_TEXT_CHUNK_CHARS);
		const slice = rawSlice.trim();
		const sliceLines = rawSlice.split("\n").length;
		if (slice.length >= 50) {
			pushChunk(slice, sliceStart, sliceStart + sliceLines - 1, formulas);
		}
		sliceStart += sliceLines;
		offset += MAX_TEXT_CHUNK_CHARS;
	}
}

// Shared buffer assembly for section blocks: text paragraphs respect the soft token
// target; protected segments are atomic — always appended, flushing the buffer first
// when they would exceed the target. Oversized protected segments are pre-split at
// structural boundaries; oversized text paragraphs are char-sliced.
function assembleChunkBlocks(
	blocks: ChunkBlock[],
	pushChunk: (text: string, startLine: number, endLine: number, formulas: string[]) => void,
	targetTokens: number,
	defaultEndLine: number,
): void {
	let buffer: ChunkBlock[] = [];
	let bufferStart = blocks[0]?.startLine ?? defaultEndLine;
	let bufferFormulas: string[] = [];

	const flushBuffer = () => {
		if (buffer.length === 0) return;
		pushChunk(buffer.map((block) => block.text).join("\n\n"), bufferStart, defaultEndLine, bufferFormulas);
		buffer = [];
		bufferFormulas = [];
	};

	const appendAtomic = (block: ChunkBlock) => {
		const next = [...buffer.map((b) => b.text), block.text].join("\n\n");
		if (estimateTokens(next) > targetTokens && buffer.length > 0) flushBuffer();
		if (buffer.length === 0) bufferStart = block.startLine;
		buffer.push(block);
		if (block.segment?.kind === "math") bufferFormulas.push(...extractDisplayFormulas([block.segment]));
	};

	for (const block of blocks) {
		if (block.segment) {
			if (block.text.length > MAX_MATH_BLOCK_CHARS) {
				for (const piece of splitOversizedProtected(block.segment, MAX_MATH_BLOCK_CHARS)) {
					appendAtomic({ text: piece.text, startLine: piece.startLine, endLine: piece.endLine, segment: piece });
				}
			} else {
				appendAtomic(block);
			}
			continue;
		}
		if (block.text.length > MAX_TEXT_CHUNK_CHARS) {
			const oversizedText = buffer.length > 0 ? [...buffer.map((b) => b.text), block.text].join("\n\n") : block.text;
			// Empty buffer → the oversized block's OWN start line is the provenance anchor; the
			// section-end default would report lines beyond the sliced chunks' real location.
			const oversizedStart = buffer.length > 0 ? bufferStart : block.startLine;
			pushOversizedText(oversizedText, oversizedStart, bufferFormulas, pushChunk);
			buffer = [];
			bufferFormulas = [];
			// Re-anchor to the oversized block's start (not the section end): the first NORMAL
			// block after it flushes with this bufferStart unless it re-anchors first.
			bufferStart = block.startLine;
			continue;
		}
		const next = [...buffer.map((b) => b.text), block.text].join("\n\n");
		if (estimateTokens(next) > targetTokens && buffer.length > 0) {
			flushBuffer();
			bufferStart = block.startLine;
		}
		// Mirror appendAtomic's empty-buffer guard: a normal block that opens a fresh buffer
		// carries its own start line (otherwise the post-oversized anchor above would leak
		// into this chunk's provenance).
		if (buffer.length === 0) bufferStart = block.startLine;
		buffer.push(block);
	}

	flushBuffer();
}

// Fenced code blocks (``` or ~~~) protect their lines from markdown heading scanning:
// a `# comment` inside an open fence must not split the section nor enter headingStack.
const MD_FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const MD_BACKTICK_CLOSE_RE = /^\s*`{3,}\s*$/;
const DISPLAY_MATH_CLOSE_RE = /\$\$|\\\]/;
const MD_TILDE_CLOSE_RE = /^\s*~{3,}\s*$/;

export function chunkMarkdown(
	content: string,
	filePath: string,
	fileType: string = "markdown",
	extraMetadata: ChunkMetadata = {},
): Omit<ChunkInsert, "kb_id">[] {
	const frontmatter = parseFrontmatter(content);
	const body =
		frontmatter.bodyStartLine > 1
			? content
					.split("\n")
					.slice(frontmatter.bodyStartLine - 1)
					.join("\n")
			: content;
	const lineBase = frontmatter.bodyStartLine - 1;
	const links = extractWikiLinks(body);
	const lines = body.split("\n");
	const chunks: Omit<ChunkInsert, "kb_id">[] = [];
	const headingStack: string[] = [];
	let sectionLines: string[] = [];
	let sectionStart = 1;
	let currentHeading = "";

	function currentBreadcrumb(): string {
		return headingStack.map(normalizeHeading).filter(Boolean).join(" > ");
	}

	function pushMarkdownChunk(text: string, start: number, end: number, formulas: string[]): void {
		if (text.trim().length < 50) return;
		const metadata: ChunkMetadata = { heading: currentHeading, breadcrumb: currentBreadcrumb() };
		if (frontmatter.title) metadata.title = frontmatter.title;
		if (frontmatter.tags.length > 0) metadata.tags = frontmatter.tags;
		if (frontmatter.aliases.length > 0) metadata.aliases = frontmatter.aliases;
		if (links.length > 0) metadata.links = links;
		if (formulas.length > 0) metadata.formulas = formulas;
		for (const [key, value] of Object.entries(extraMetadata)) {
			if (value !== undefined) metadata[key] = value;
		}
		chunks.push(makeChunk(text.trim(), filePath, fileType, start + lineBase, end + lineBase, metadata));
	}

	function flush(endLine: number): void {
		const text = sectionLines.join("\n").trim();
		if (text.length < 50) return;

		// Reconstruct the heading→content gap from the real section lines: trim() collapses all
		// leading blanks to a hard-coded 2-line layout, drifting every mid-section start_line by
		// (1 − k) for k blank lines. k = 0 keeps the merge-safe single-blank layout.
		const leadingBlanks = sectionLines.findIndex((l) => l.trim() !== "");
		const gap = Math.max(1, leadingBlanks === -1 ? 1 : leadingBlanks);
		const fullText = currentHeading ? `${currentHeading}\n${"\n".repeat(gap)}${text}` : text;
		const blocks = markdownBlocks(fullText, sectionStart);
		assembleChunkBlocks(blocks, pushMarkdownChunk, MARKDOWN_TARGET_TOKENS, endLine);
	}

	let openFence: "`" | "~" | undefined;
	let openDisplayMath = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (openDisplayMath) {
			if (DISPLAY_MATH_CLOSE_RE.test(line)) openDisplayMath = false;
			sectionLines.push(line);
			continue;
		}
		if (openFence !== undefined) {
			const closeRe = openFence === "`" ? MD_BACKTICK_CLOSE_RE : MD_TILDE_CLOSE_RE;
			if (closeRe.test(line)) openFence = undefined;
			sectionLines.push(line);
			continue;
		}
		const fenceOpen = MD_FENCE_OPEN_RE.exec(line);
		if (fenceOpen) {
			openFence = fenceOpen[1]?.startsWith("`") ? "`" : "~";
			sectionLines.push(line);
			continue;
		}
		// Display math is a protected atomic unit: a `#`-leading line inside a `$$ … $$` block or
		// `\[ … \]` must not split the section (same bug class as fenced code). Open ONLY on a
		// line-leading delimiter (aligned with the segmenter's DISPLAY_OPEN_RE in math-text.ts)
		// that is unterminated on its own line, so prose mentioning `$$` or inline `\[` cannot
		// latch math state and swallow every later heading.
		if (/^\s*\$\$/.test(line) && (line.match(/\$\$/g) ?? []).length % 2 === 1) {
			openDisplayMath = true;
			sectionLines.push(line);
			continue;
		}
		if (/^\s*\\\[/.test(line) && !line.includes("\\]")) {
			openDisplayMath = true;
			sectionLines.push(line);
			continue;
		}
		const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

		if (headingMatch && sectionLines.length > 0) {
			flush(i);
			sectionLines = [];
			sectionStart = i + 1;
		}

		if (headingMatch) {
			const level = headingMatch[1].length;
			headingStack.splice(level - 1);
			headingStack[level - 1] = line;
			currentHeading = line;
		} else {
			sectionLines.push(line);
		}
	}

	if (sectionLines.length > 0) {
		flush(lines.length);
	}

	return chunks;
}

export function chunkText(content: string, filePath: string): Omit<ChunkInsert, "kb_id">[] {
	const fileType = detectFileType(filePath);
	const chunks: Omit<ChunkInsert, "kb_id">[] = [];
	let buffer: string[] = [];
	let bufferTokens = 0;
	let bufferFormulas: string[] = [];
	let lineOffset = 1;

	function flush(): void {
		const text = buffer.join("\n\n").trim();
		if (text.length < 50) return;
		const metadata: ChunkMetadata = {};
		if (bufferFormulas.length > 0) metadata.formulas = bufferFormulas;
		chunks.push(makeChunk(text, filePath, fileType, lineOffset, lineOffset + text.split("\n").length - 1, metadata));
		lineOffset += text.split("\n").length + 1;
	}

	function pushOversizedParagraph(para: string, formulas: string[]): void {
		let offset = 0;
		while (offset < para.length) {
			// Advance by the RAW slice's line count (mirror of pushOversizedText): trim() can
			// remove leading/trailing blank lines and undercount consumed lines, drifting every
			// later chunk's start/end lines earlier.
			const rawSlice = para.slice(offset, offset + MAX_TEXT_CHUNK_CHARS);
			const slice = rawSlice.trim();
			if (slice.length >= 50) {
				const metadata: ChunkMetadata = {};
				if (formulas.length > 0) metadata.formulas = formulas;
				chunks.push(
					makeChunk(slice, filePath, fileType, lineOffset, lineOffset + rawSlice.split("\n").length - 1, metadata),
				);
			}
			lineOffset += rawSlice.split("\n").length;
			offset += MAX_TEXT_CHUNK_CHARS;
		}
	}

	function resetBuffer(): void {
		flush();
		buffer = [];
		bufferTokens = 0;
		bufferFormulas = [];
	}

	function appendAtomic(text: string, segment: Segment): void {
		const paraTokens = estimateTokens(text);
		if (bufferTokens + paraTokens > TEXT_TARGET_TOKENS && buffer.length > 0) resetBuffer();
		buffer.push(text);
		bufferTokens += paraTokens;
		if (segment.kind === "math") bufferFormulas.push(...extractDisplayFormulas([segment]));
	}

	for (const segment of splitProtectedSegments(content, "text")) {
		if (segment.kind === "text") {
			for (const para of segment.text.split(/\n\n+/)) {
				const paraTokens = estimateTokens(para);
				if (para.length > MAX_TEXT_CHUNK_CHARS) {
					if (buffer.length > 0) resetBuffer();
					pushOversizedParagraph(para, bufferFormulas);
					continue;
				}
				if (bufferTokens + paraTokens > TEXT_TARGET_TOKENS && buffer.length > 0) resetBuffer();
				buffer.push(para);
				bufferTokens += paraTokens;
			}
			continue;
		}
		if (segment.text.length > MAX_MATH_BLOCK_CHARS) {
			for (const piece of splitOversizedProtected(segment, MAX_MATH_BLOCK_CHARS)) {
				appendAtomic(piece.text, piece);
			}
			continue;
		}
		appendAtomic(segment.text, segment);
	}

	if (buffer.length > 0) flush();
	return chunks;
}

const LATEX_SECTION_LEVELS: Record<string, number> = { chapter: 1, section: 2, subsection: 3, subsubsection: 4 };
const LATEX_SECTION_RE = /^\\(chapter|section|subsection|subsubsection)\*?\s*\{(.+)\}\s*$/;

interface LatexSection {
	title: string;
	breadcrumb: string;
	blocks: ChunkBlock[];
}

function pushLatexChunkFactory(
	section: LatexSection,
	filePath: string,
	labels: string[],
	refs: string[],
	chunks: Omit<ChunkInsert, "kb_id">[],
) {
	return (text: string, start: number, end: number, formulas: string[]): void => {
		if (text.trim().length < 50) return;
		const metadata: ChunkMetadata = { heading: section.title, breadcrumb: section.breadcrumb };
		if (labels.length > 0) metadata.labels = labels;
		if (refs.length > 0) metadata.refs = refs;
		if (formulas.length > 0) metadata.formulas = formulas;
		chunks.push(makeChunk(text.trim(), filePath, "latex", start, end, metadata));
	};
}

export function chunkLaTeX(content: string, filePath: string): Omit<ChunkInsert, "kb_id">[] {
	const sections: LatexSection[] = [];
	const headingStack: string[] = [];
	let current: LatexSection = { title: "Preamble", breadcrumb: "Preamble", blocks: [] };
	sections.push(current);

	for (const segment of splitProtectedSegments(content, "latex")) {
		if (segment.kind !== "text") {
			current.blocks.push({ text: segment.text, startLine: segment.startLine, endLine: segment.endLine, segment });
			continue;
		}
		const lines = segment.text.split("\n");
		let runStart = 0;
		const pushRun = (endExcl: number) => {
			const text = lines.slice(runStart, endExcl).join("\n");
			if (text.trim().length > 0) {
				current.blocks.push({
					text,
					startLine: segment.startLine + runStart,
					endLine: segment.startLine + endExcl - 1,
				});
			}
		};
		for (let i = 0; i < lines.length; i++) {
			const match = LATEX_SECTION_RE.exec(lines[i].trim());
			if (!match) continue;
			if (i > runStart) pushRun(i);
			const level = LATEX_SECTION_LEVELS[match[1]];
			headingStack.splice(level - 1);
			headingStack[level - 1] = match[2].trim();
			current = {
				title: match[2].trim(),
				breadcrumb: headingStack.filter(Boolean).join(" > "),
				blocks: [],
			};
			sections.push(current);
			current.blocks.push({ text: lines[i], startLine: segment.startLine + i, endLine: segment.startLine + i });
			runStart = i + 1;
		}
		if (runStart < lines.length) pushRun(lines.length);
	}

	const chunks: Omit<ChunkInsert, "kb_id">[] = [];
	for (const section of sections) {
		const sectionText = section.blocks.map((block) => block.text).join("\n\n");
		const labels = extractTexLabels(sectionText);
		const refs = extractTexRefs(sectionText);
		const pushChunk = pushLatexChunkFactory(section, filePath, labels, refs, chunks);
		const lastLine = section.blocks.at(-1)?.endLine ?? 1;
		assembleChunkBlocks(section.blocks, pushChunk, MARKDOWN_TARGET_TOKENS, lastLine);
	}

	// Fallback: if file has content but no chunks, keep as single chunk (matches chunkFile fallback).
	if (chunks.length === 0 && content.trim().length > 10) {
		chunks.push(makeChunk(content.trim(), filePath, "latex", 1, content.split("\n").length));
	}

	return chunks;
}

export function isCodeFileType(fileType: string): boolean {
	return ["typescript", "javascript", "python", "go", "rust", "java", "bash", "c", "cpp", "qml"].includes(fileType);
}

export async function analyzeIndexableContent(
	content: string,
	filePath: string,
	fileType = detectFileType(filePath),
	extraMetadata?: ChunkMetadata,
): Promise<{
	chunks: Omit<ChunkInsert, "kb_id">[];
	symbols: KnowledgeSymbolInsert[];
}> {
	const detectedFileType = detectFileType(filePath);
	const analysisFileType = isCodeFileType(detectedFileType) ? detectedFileType : fileType;
	if (isCodeFileType(analysisFileType)) {
		try {
			const { analyzeCodeWithAST } = await import("./chunkers/code-ast.ts");
			const analysis = await analyzeCodeWithAST(content, filePath, analysisFileType);
			const chunks = analysis.chunks.length > 0 ? analysis.chunks : await chunkFile(content, filePath);
			const symbols = dedupeSymbols([...analysis.symbols, ...extractSymbols(content, filePath, analysisFileType)]);
			return { chunks, symbols };
		} catch {
			/* fallback below */
		}
	}
	// Only forward the override when it names a routing type (markdown/latex) that differs
	// from extension detection: extractor labels like "text" (for .md files) must not demote
	// a detected markdown file to the plain-text chunker.
	const overridesRouting =
		(analysisFileType === "markdown" || analysisFileType === "latex") && analysisFileType !== detectedFileType;
	return {
		chunks: await chunkFile(
			content,
			filePath,
			overridesRouting ? { fileTypeOverride: analysisFileType, extraMetadata } : { extraMetadata },
		),
		symbols: extractSymbols(content, filePath, analysisFileType),
	};
}

function dedupeSymbols(symbols: KnowledgeSymbolInsert[]): KnowledgeSymbolInsert[] {
	const seen = new Set<string>();
	const deduped: KnowledgeSymbolInsert[] = [];
	for (const symbol of symbols) {
		const key = [
			symbol.kind,
			symbol.name,
			symbol.file_path,
			String(symbol.start_line),
			symbol.container_name ?? "",
		].join("\0");
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(symbol);
	}
	return deduped;
}

export async function chunkFile(
	content: string,
	filePath: string,
	options?: { fileTypeOverride?: string; extraMetadata?: ChunkMetadata },
): Promise<Omit<ChunkInsert, "kb_id">[]> {
	const detectedFileType = detectFileType(filePath);
	// Route on the override only when it names a routing type (markdown/latex) that differs from
	// extension detection: a sidecar-converted PDF arrives as markdown but must keep its detected
	// "pdf" file type, and non-routing extractor labels ("text", "pdf") must never demote routing.
	const overrideIsRouting = options?.fileTypeOverride === "markdown" || options?.fileTypeOverride === "latex";
	const override =
		options?.fileTypeOverride && overrideIsRouting && options.fileTypeOverride !== detectedFileType
			? options.fileTypeOverride
			: undefined;
	const fileType = override ?? detectedFileType;
	let chunks: Omit<ChunkInsert, "kb_id">[] = [];

	if (fileType === "markdown") {
		chunks = chunkMarkdown(content, filePath, detectedFileType, options?.extraMetadata);
	} else if (fileType === "latex") {
		chunks = chunkLaTeX(content, filePath);
	} else if (isCodeFileType(detectedFileType)) {
		try {
			const { chunkWithAST } = await import("./chunkers/code-ast.ts");
			chunks = await chunkWithAST(content, filePath, detectedFileType);
		} catch {
			/* fallback below */
		}
	}

	if (chunks.length === 0) chunks = chunkText(content, filePath);

	// Fallback: if file has content but no chunks (too short for splitting), keep as single chunk
	if (chunks.length === 0 && content.trim().length > 10) {
		chunks = [makeChunk(content.trim(), filePath, detectedFileType, 1, content.split("\n").length)];
	}

	return chunks;
}
