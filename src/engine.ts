import { existsSync, readFileSync, renameSync, rmSync, statSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { type DiagnosticResult, diagnoseKB } from "./diagnostics/health.ts";
import type { EmbeddingConfig } from "./embedding/provider.ts";
import {
	dispose as disposeEmbedding,
	embedDocuments,
	embeddingConfigLabel,
	embeddingSignature,
	embedQueryWithConfig,
	prepareForShutdown as prepareEmbeddingForShutdown,
	resolveEmbeddingConfig,
} from "./embedding/provider.ts";
import { openVectorReader, openVectorWriter } from "./embedding/vectors.ts";
import {
	addSkippedScanEntry,
	analyzeIndexableContent,
	buildChunkEmbeddingText,
	chunkFile,
	chunkIdentityHash,
	createSkippedScanStats,
	isReadableTextFile,
	isSupportedDocumentFile,
	iterateScannableFiles,
	preTokenizeForFTS,
	type ScannableFile,
	type ScanOptions,
	summarizeSkippedScan,
} from "./indexer/chunker.ts";
import { extractQueryFormulas, type NormalizedFormula, normalizeFormula } from "./indexer/formula-normalize.ts";
import { resolveLabelTarget } from "./indexer/label-resolve.ts";
import { convertPdf, detectSidecar, resolvePdfSidecarConfig, SidecarError } from "./indexer/pdf-sidecar.ts";
import { extractSymbols } from "./indexer/symbols.ts";
import { shutdownModelWorker } from "./model-worker-client.ts";
import { searchBM25 } from "./search/bm25.ts";
import { weightedScoreFusion } from "./search/fusion.ts";
import { tokenizeForSearch } from "./search/query.ts";
import {
	DEPENDENCY_BOOST,
	FORMULA_BOOST,
	hasAnyLexicalEvidence,
	hasEnoughLexicalEvidence,
	normalizeFileTypeFilter,
	queryCoverage,
	type RankingDiagnostics,
	scoreChunkForQuery,
} from "./search/ranking.ts";
import { disposeReranker, prepareRerankerForShutdown, rerank } from "./search/reranker.ts";
import {
	resolveSearchTuning,
	type SearchProfile,
	type SearchTuningSummary,
	summarizeSearchTuning,
} from "./search/tuning.ts";
import { searchVectorFile } from "./search/vector.ts";
import {
	type Chunk,
	type ChunkInsert,
	countSymbols,
	createKB,
	deleteChunksByIds,
	deleteFormulasForChunks,
	deleteKB,
	deleteLabelEdgesForChunks,
	deleteSymbolsByKB,
	findExactFormulas,
	findResolvedLabelEdges,
	finishIndexingJob,
	getChunkById,
	getChunkCount,
	getChunksByFile,
	getFileCount,
	getKB,
	getKBByName,
	getSymbolCount,
	insertChunks,
	insertSymbols,
	iterateChunkIdsByKB,
	iterateChunksByKB,
	type KnowledgeBase,
	type KnowledgeSymbol,
	type LabelEdgeInsert,
	listChunksForFormulaBackfill,
	listChunksForLabelBackfill,
	listKBs,
	markFormulaIndexBuilt,
	markLabelGraphBuilt,
	openDatabase,
	type ResolvedLabelEdgeRow,
	replaceFormulasForChunk,
	replaceLabelEdgesForChunk,
	searchFormulasFTS,
	searchSymbols,
	startIndexingJob,
	updateIndexingJob,
	updateKBCounts,
	updateKBEmbeddingMetadata,
	updateKBStatus,
} from "./storage/sqlite.ts";

export type SearchMode =
	| "auto"
	| "fast"
	| "semantic"
	| "hybrid"
	| "deep"
	| "adaptive"
	| "code"
	| "config"
	| "docs"
	| "errors"
	| "decision";

export interface SearchOptions {
	mode?: SearchMode;
	profile?: SearchProfile;
	limit?: number;
	offset?: number;
	kb_id?: string;
	filters?: { file_type?: string; path_pattern?: string };
	diversity?: "off" | "balanced" | "strong";
}

export interface SearchResult {
	content: string;
	file_path: string;
	file_type: string;
	kb_name: string;
	score: number;
	snippet: string;
	start_line: number;
	end_line: number;
	ranking?: RankingDiagnostics;
	provenance?: {
		chunk_id: string;
		chunk_hash: string;
		indexed_at: number;
		source_mtime?: number;
		stale: boolean;
		match_reason: "bm25" | "vector" | "hybrid" | "rerank" | "symbol" | "adaptive" | "formula" | "dependency";
		source_chunk_ids?: string[];
		// Layer 4 label graph (spec §3.5): resolved outgoing label edges of this chunk. Present
		// only when the chunk participates in the dependency walk; absent on the dormant path.
		depends_on?: DependencyEdgeProvenance[];
	};
}

export interface DependencyEdgeProvenance {
	label: string;
	chunk_id: string;
	pinned: boolean;
}

export { CURRENT_EMBEDDING_MODEL } from "./embedding/provider.ts";

export interface SearchResponse {
	results: SearchResult[];
	total_count: number;
	has_more: boolean;
	warnings?: string[];
	mode_used?: SearchMode;
	retry_modes?: SearchMode[];
	suggestions?: string[];
	tuning?: SearchTuningSummary;
}

export type ProgressCallback = (msg: string) => void;

export interface AddOptions {
	include_suggested_text?: boolean;
	include_paths?: string[];
	exclude_paths?: string[];
}

type UpdateableKnowledgeBase = KnowledgeBase & { source_path: string };

interface ImportedChunk {
	content: string;
	file_path: string;
	file_type: string;
	start_line: number;
	end_line: number;
	metadata_json?: string;
}

type KnowledgeSymbolInsert = Parameters<typeof insertSymbols>[2][number];

interface ImportHeader {
	name: string;
	description?: string;
	chunk_count?: number;
}

interface RankedChunk {
	chunk: Chunk;
	kbName: string;
	ranking?: RankingDiagnostics;
	score: number;
	content: string;
	snippet: string;
	startLine: number;
	endLine: number;
	sourceChunkIds: string[];
}

// Ranking provenance for formula/dependency-injected results. RankingDiagnostics is the frozen
// published shape (index.ts prints base/adjusted/coverage from it), so injected provenance rides
// as an extra `injected` property instead of a schema change. Diagnostics contract (non-deep
// paths, which publish rankingByChunkId): for EVERY published result, ranking.adjusted_score
// equals result.score. Boosted retrieved chunks get adjusted_score patched to the boosted score;
// injected chunks carry injected:true with adjusted_score pinned to the injected score — the
// lexical adjustment fields are informational only, since formula/dependency evidence bypasses
// MIN_HYBRID_SCORE and is published unadjusted (ratified). Deep mode intentionally publishes
// rerank-stage diagnostics instead (ranking basis is the rerank score, not rankingByChunkId).
type InjectedRanking = RankingDiagnostics & { injected: true };

function injectedRankingDiagnostics(chunk: Chunk, score: number, queryTokens: Set<string>): InjectedRanking {
	const ranking = scoreChunkForQuery(score, chunk, queryTokens);
	return { ...ranking, adjusted_score: score, injected: true };
}

export interface DoctorIssue {
	severity: "blocking" | "warning" | "info";
	kb_name?: string;
	message: string;
	action: string;
	action_code?: "run_update" | "rebuild_kb" | "wait_for_indexing" | "review_skipped_scope" | "none";
}

export interface DoctorReport {
	health_score: number;
	summary: string;
	issues: DoctorIssue[];
	diagnostics: DiagnosticResult[];
	actions: Array<{
		code: NonNullable<DoctorIssue["action_code"]>;
		kb_name?: string;
		target?: string;
		description: string;
	}>;
}

export interface SymbolSearchOptions {
	kb_id?: string;
	kind?: KnowledgeSymbol["kind"];
	file_pattern?: string;
	limit?: number;
	offset?: number;
	exact?: boolean;
}

export interface SymbolSearchResponse {
	results: Array<{
		name: string;
		kind: KnowledgeSymbol["kind"];
		file_path: string;
		file_type: string;
		kb_name: string;
		start_line: number;
		end_line: number;
		signature?: string;
		container_name?: string;
		text: string;
		indexed_at: number;
	}>;
	total_count: number;
	has_more: boolean;
}

const INDEX_EMBED_BATCH_SIZE = 64;
// Retry hints attached to any empty search response, including the deep-mode early return.
const EMPTY_RESULT_SUGGESTIONS = [
	"Try mode 'fast' for exact symbols or mode 'semantic' for conceptual wording.",
	"Run knowledge_status if the KB should contain this answer.",
];
const VECTOR_REDUNDANCY_WEIGHT = 0.35;
// Layer 3 fuzzy formula leg (spec §3.4.3): top-ranked FTS hit gets 0.8, rank-normalized below.
const FORMULA_FUZZY_TOP_SCORE = 0.8;
const FORMULA_INJECTION_LIMIT = 5;
// Layer 4 label-graph dependency leg (spec §3.5): depth-1 walk consumes at most 2 edges per
// triggering chunk and injects at most 10 candidates per query.
const DEPENDENCY_WALK_EDGES_PER_CHUNK = 2;
const DEPENDENCY_INJECTION_LIMIT = 10;

interface DirectoryScanPlan {
	files: number;
	bytes: number;
	skippedTotal: number;
	skippedSummary: string;
	skipped: ReturnType<typeof createSkippedScanStats>;
}

export interface IndexPlan {
	source_type: "file" | "directory" | "text" | "url";
	scannable_files: number;
	scannable_bytes: number;
	skipped: ReturnType<typeof createSkippedScanStats>;
	summary: string;
}

function isCancellationError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.message === "Cancelled") return true;
	if (error.name === "AbortError") return true;
	// Structured sidecar check only: a crashed adapter's stderr may coincidentally contain the
	// word "abort" (Python tracebacks routinely do) — misclassifying that as a user cancel
	// would skip the fail-open unpdf fallback and mask a real failure as a cancelled job.
	return error instanceof SidecarError && error.failure === "aborted";
}

function tempVectorPath(vectorPath: string): string {
	return `${vectorPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function assertEmbeddingBatchSize(vectors: Float32Array[], expected: number, operation: string): void {
	if (vectors.length !== expected) {
		throw new Error(`Embedding provider returned ${vectors.length} vectors for ${expected} ${operation} chunks`);
	}
}

function retrievalModeFor(
	mode: SearchMode,
): Exclude<SearchMode, "auto" | "code" | "config" | "docs" | "errors" | "decision"> {
	if (mode === "auto") return "hybrid";
	if (mode === "code" || mode === "config" || mode === "errors") return "fast";
	if (mode === "docs" || mode === "decision") return "hybrid";
	return mode;
}

function matchReasonFor(mode: SearchMode): NonNullable<SearchResult["provenance"]>["match_reason"] {
	if (mode === "deep") return "rerank";
	if (mode === "adaptive") return "adaptive";
	if (mode === "semantic") return "vector";
	if (mode === "fast" || mode === "code" || mode === "config" || mode === "errors") return "bm25";
	return "hybrid";
}

function toScanOptions(options: AddOptions = {}): ScanOptions {
	return {
		includeSuggestedText: options.include_suggested_text === true,
		includePaths: options.include_paths,
		excludePaths: options.exclude_paths,
	};
}

function serializeAddOptions(options: AddOptions = {}): string | undefined {
	const normalized: AddOptions = {};
	if (options.include_suggested_text === true) normalized.include_suggested_text = true;
	if (options.include_paths && options.include_paths.length > 0) normalized.include_paths = options.include_paths;
	if (options.exclude_paths && options.exclude_paths.length > 0) normalized.exclude_paths = options.exclude_paths;
	return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : undefined;
}

function parseAddOptions(raw: string | null): AddOptions {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as AddOptions;
		return {
			include_suggested_text: parsed.include_suggested_text === true,
			include_paths: Array.isArray(parsed.include_paths)
				? parsed.include_paths.filter((item) => typeof item === "string")
				: undefined,
			exclude_paths: Array.isArray(parsed.exclude_paths)
				? parsed.exclude_paths.filter((item) => typeof item === "string")
				: undefined,
		};
	} catch {
		return {};
	}
}

function planDirectoryScan(dirPath: string, options: ScanOptions = {}, signal?: AbortSignal): DirectoryScanPlan {
	const skipped = createSkippedScanStats();
	let files = 0;
	let bytes = 0;
	for (const file of iterateScannableFiles(dirPath, skipped, options)) {
		throwIfAborted(signal);
		files++;
		bytes += file.size;
	}
	return {
		files,
		bytes,
		skippedTotal: skipped.total,
		skippedSummary: summarizeSkippedScan(skipped),
		skipped,
	};
}

function sourceMtimeFor(kb: KnowledgeBase | undefined, filePath: string): number | undefined {
	if (!kb?.source_path) return undefined;
	const absPath = kb.source_type === "directory" ? join(kb.source_path, filePath) : kb.source_path;
	try {
		return statSync(absPath).mtimeMs;
	} catch {
		return undefined;
	}
}

export function kbTrustMultiplier(kb: KnowledgeBase): number {
	let multiplier = kb.status === "stale" ? 0.92 : 1;
	if (kb.source_type === "directory" || kb.source_type === "file") multiplier *= 1.04;
	if (kb.source_type === "text" || kb.source_type === "url") multiplier *= 0.98;
	return multiplier;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)} MB`;
	return `${(mb / 1024).toFixed(2)} GB`;
}

function cosineSimilarity(a: Float32Array | undefined, b: Float32Array | undefined): number {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

function tokenizeForSimilarity(text: string): Set<string> {
	return tokenizeForSearch(text);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}

function lineProximity(a: RankedChunk, b: RankedChunk): number {
	if (a.chunk.file_path !== b.chunk.file_path || a.chunk.kb_id !== b.chunk.kb_id) return 0;
	if (a.sourceChunkIds.some((id) => b.sourceChunkIds.includes(id))) return 1;
	const overlap = Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
	if (overlap > 0) return 1;
	const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
	if (gap <= 20) return 0.8;
	if (gap <= 80) return 0.45;
	return 0.2;
}

function normalizeScores(candidates: RankedChunk[]): Map<string, number> {
	const scores = candidates.map((candidate) => candidate.score);
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const normalized = new Map<string, number>();
	for (const candidate of candidates) {
		const value = max === min ? 1 : (candidate.score - min) / (max - min);
		normalized.set(candidate.chunk.id, value);
	}
	return normalized;
}

function diversifyRankedChunks(
	candidates: RankedChunk[],
	diversity: SearchOptions["diversity"],
	vectorsByChunkId: Map<string, Float32Array> = new Map(),
): RankedChunk[] {
	if (diversity === "off" || candidates.length <= 2) return candidates;
	const lambda = diversity === "strong" ? 0.62 : 0.76;
	const normalized = normalizeScores(candidates);
	const tokenSets = new Map(
		candidates.map((candidate) => [candidate.chunk.id, tokenizeForSimilarity(candidate.content)]),
	);
	const selected: RankedChunk[] = [];
	const remaining = [...candidates];

	while (remaining.length > 0) {
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i];
			let redundancy = 0;
			for (const chosen of selected) {
				const lexical = jaccardSimilarity(
					tokenSets.get(candidate.chunk.id) ?? new Set<string>(),
					tokenSets.get(chosen.chunk.id) ?? new Set<string>(),
				);
				const vector = Math.max(
					0,
					cosineSimilarity(vectorsByChunkId.get(candidate.chunk.id), vectorsByChunkId.get(chosen.chunk.id)),
				);
				redundancy = Math.max(
					redundancy,
					Math.max(lexical, lineProximity(candidate, chosen), vector * VECTOR_REDUNDANCY_WEIGHT),
				);
			}
			const relevance = normalized.get(candidate.chunk.id) ?? 0;
			const mmrScore = lambda * relevance - (1 - lambda) * redundancy;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIndex = i;
			}
		}
		selected.push(remaining.splice(bestIndex, 1)[0]);
	}

	return selected;
}

function interleaveByFile(candidates: RankedChunk[], diversity: SearchOptions["diversity"]): RankedChunk[] {
	if (diversity === "off" || candidates.length <= 2) return candidates;
	const buckets = new Map<string, RankedChunk[]>();
	const fileOrder: string[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.chunk.kb_id}:${candidate.chunk.file_path}`;
		if (!buckets.has(key)) {
			buckets.set(key, []);
			fileOrder.push(key);
		}
		buckets.get(key)?.push(candidate);
	}
	if (fileOrder.length <= 1) return candidates;

	const result: RankedChunk[] = [];
	let round = 0;
	while (result.length < candidates.length) {
		let added = false;
		for (const key of fileOrder) {
			const bucket = buckets.get(key);
			const item = bucket?.[round];
			if (!item) continue;
			result.push(item);
			added = true;
		}
		if (!added) break;
		round++;
	}
	return result;
}

function buildQuerySnippet(content: string, query: string, maxLength = 240): string {
	const terms = [...tokenizeForSimilarity(query)].sort((a, b) => b.length - a.length);
	const lower = content.toLowerCase();
	let matchIndex = -1;
	for (const term of terms) {
		matchIndex = lower.indexOf(term.toLowerCase());
		if (matchIndex >= 0) break;
	}
	if (matchIndex < 0) return content.slice(0, maxLength);
	const half = Math.floor(maxLength / 2);
	const start = Math.max(0, matchIndex - half);
	const end = Math.min(content.length, start + maxLength);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < content.length ? "..." : "";
	return `${prefix}${content.slice(start, end)}${suffix}`;
}

interface AdaptiveChunkMetadata {
	symbol?: string;
	symbolKind?: string;
	parentSymbol?: string;
	scope: string[];
	startLine?: number;
	endLine?: number;
}

function metadataString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
		: [];
}

function parseAdaptiveMetadata(chunk: Chunk): AdaptiveChunkMetadata {
	try {
		const parsed = JSON.parse(chunk.metadata_json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { scope: [] };
		const record = parsed as Record<string, unknown>;
		return {
			symbol: metadataString(record, "symbol") ?? metadataString(record, "function_name"),
			symbolKind: metadataString(record, "symbol_kind"),
			parentSymbol: metadataString(record, "parent_symbol"),
			scope: metadataStringArray(record, "scope"),
			startLine: metadataNumber(record, "start_line"),
			endLine: metadataNumber(record, "end_line"),
		};
	} catch {
		return { scope: [] };
	}
}

function hasAdaptiveStructure(metadata: AdaptiveChunkMetadata): boolean {
	return Boolean(metadata.symbol || metadata.symbolKind || metadata.parentSymbol || metadata.scope.length > 0);
}

function parentScope(scope: string[]): string[] {
	return scope.length > 1 ? scope.slice(0, -1) : [];
}

function sameScope(left: string[], right: string[]): boolean {
	return left.length > 0 && left.length === right.length && left.every((item, index) => item === right[index]);
}

function isScopePrefix(parent: string[], child: string[]): boolean {
	return parent.length > 0 && parent.length < child.length && parent.every((item, index) => item === child[index]);
}

function adaptiveRelationBoost(seed: AdaptiveChunkMetadata, candidate: AdaptiveChunkMetadata): number {
	if (!hasAdaptiveStructure(seed) || !hasAdaptiveStructure(candidate)) return 0;
	const seedParentScope = parentScope(seed.scope);
	const candidateParentScope = parentScope(candidate.scope);
	if (sameScope(seedParentScope, candidateParentScope)) return seed.symbol === candidate.symbol ? 0.35 : 1.35;
	if (seed.parentSymbol && seed.parentSymbol === candidate.parentSymbol) {
		return seed.symbol === candidate.symbol ? 0.35 : 1.2;
	}
	if (isScopePrefix(seed.scope, candidate.scope) || isScopePrefix(candidate.scope, seed.scope)) return 0.9;
	return 0;
}

function buildAdaptiveContext(
	seed: Chunk,
	chunks: Chunk[],
	queryTokens: Set<string>,
	options: { maxContextChars: number; neighborTarget: number },
): {
	content: string;
	startLine: number;
	endLine: number;
	sourceChunkIds: string[];
} {
	const seedMetadata = parseAdaptiveMetadata(seed);
	const scored = chunks
		.map((chunk) => {
			const distance =
				chunk.id === seed.id
					? 0
					: Math.min(Math.abs(chunk.start_line - seed.start_line), Math.abs(chunk.end_line - seed.end_line));
			const proximity = 1 / (1 + distance / 20);
			const coverage = queryCoverage(chunk.content, queryTokens);
			const seedBoost = chunk.id === seed.id ? 2 : 0;
			const relationBoost =
				chunk.id === seed.id ? 0 : adaptiveRelationBoost(seedMetadata, parseAdaptiveMetadata(chunk));
			return { chunk, score: seedBoost + relationBoost + proximity + coverage };
		})
		.sort((a, b) => b.score - a.score || a.chunk.start_line - b.chunk.start_line || a.chunk.end_line - b.chunk.end_line)
		.slice(0, options.neighborTarget);
	if (!scored.some((item) => item.chunk.id === seed.id)) scored.push({ chunk: seed, score: Number.MAX_SAFE_INTEGER });

	const selectedIds = new Set(scored.map((item) => item.chunk.id));
	const ordered = chunks
		.filter((chunk) => selectedIds.has(chunk.id))
		.sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
	const parts: string[] = [];
	const sourceChunkIds: string[] = [];
	const includedChunks: Chunk[] = [];
	let totalLength = 0;
	for (const chunk of ordered) {
		if (totalLength >= options.maxContextChars) break;
		const remaining = options.maxContextChars - totalLength;
		const text = chunk.content.slice(0, remaining);
		parts.push(text);
		sourceChunkIds.push(chunk.id);
		includedChunks.push(chunk);
		totalLength += text.length + 2;
	}
	return {
		content: parts.join("\n\n"),
		startLine: Math.min(...includedChunks.map((chunk) => chunk.start_line)),
		endLine: Math.max(...includedChunks.map((chunk) => chunk.end_line)),
		sourceChunkIds,
	};
}

function pushAdaptiveCandidate(candidates: RankedChunk[], candidate: RankedChunk): void {
	const overlappingIndex = candidates.findIndex(
		(existing) =>
			existing.chunk.kb_id === candidate.chunk.kb_id &&
			existing.chunk.file_path === candidate.chunk.file_path &&
			existing.sourceChunkIds.some((id) => candidate.sourceChunkIds.includes(id)),
	);
	if (overlappingIndex < 0) {
		candidates.push(candidate);
		return;
	}
	const existing = candidates[overlappingIndex];
	if (candidate.score > existing.score || candidate.sourceChunkIds.length > existing.sourceChunkIds.length) {
		candidates[overlappingIndex] = candidate;
	}
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const seconds = Math.ceil(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function isExactLookupQuery(query: string): boolean {
	const trimmed = query.trim();
	if (/["'`]/.test(trimmed)) return true;
	if (/[./\\][\w.-]+/.test(trimmed)) return true;
	if (/\b[A-Z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/.test(trimmed)) return true;
	if (/\b[A-Z]{2,}[_-]?[A-Z0-9]*\b/.test(trimmed)) return true;
	if (/\b[a-zA-Z_][\w-]*\.(ts|tsx|js|jsx|go|rs|py|java|md|json|ya?ml|toml)\b/.test(trimmed)) return true;
	if (/\b[A-Z]+-\d+\b/.test(trimmed)) return true;
	return false;
}

function chooseAutoMode(query: string): SearchMode {
	const normalized = query.trim();
	if (isExactLookupQuery(normalized)) return "fast";
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;
	if (wordCount >= 10 || /how|why|explain|concept|architecture|design|流程|架構|概念|為什麼|如何/i.test(normalized)) {
		return "semantic";
	}
	return "hybrid";
}

function fallbackModesFor(mode: SearchMode): SearchMode[] {
	if (mode === "fast") return ["hybrid", "semantic"];
	if (mode === "semantic") return ["hybrid", "adaptive"];
	if (mode === "adaptive") return ["hybrid", "deep"];
	if (mode === "deep") return ["hybrid", "adaptive"];
	return ["fast", "semantic", "adaptive"];
}

function isWeakAutoResponse(
	query: string,
	response: SearchResponse,
	primaryMode: SearchMode,
	attemptMode: SearchMode,
): boolean {
	if (response.results.length === 0) return true;
	if (primaryMode === "fast") {
		const exactNeedle = query
			.trim()
			.replace(/^["'`]|["'`]$/g, "")
			.toLowerCase();
		const hasExactHit = response.results.some(
			(result) =>
				result.file_path.toLowerCase().includes(exactNeedle) || result.content.toLowerCase().includes(exactNeedle),
		);
		if (!hasExactHit && response.results.every((result) => (result.ranking?.coverage ?? 0) < 0.67)) return true;
	}
	if (primaryMode !== "semantic" && attemptMode === "semantic") {
		return response.results.every((result) => (result.ranking?.coverage ?? 0) === 0);
	}
	return false;
}

const URL_FETCH_TIMEOUT_MS = 60_000;
const URL_MAX_BYTES = 10 * 1024 * 1024; // aligns with the chunker MAX_FILE_SIZE cap
const URL_TEXT_CONTENT_TYPES = /^(text\/|application\/xhtml\+xml|application\/json)/i;

async function chunkUrl(source: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof chunkFile>>> {
	// Hard timeout: a stalled server must fail the update instead of hanging the indexing job.
	const timeout = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);
	const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const res = await fetch(source, { signal: composed });
	if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
	const contentType = res.headers.get("content-type") ?? "";
	if (!URL_TEXT_CONTENT_TYPES.test(contentType)) {
		throw new Error(
			`Fetch failed: unsupported content-type "${contentType || "unknown"}" — only text/*, xhtml, and JSON URLs are ingested`,
		);
	}
	// Stream with a hard byte cap: an unbounded res.text() on a large payload OOMs the process.
	const reader = res.body?.getReader();
	let html = "";
	if (reader) {
		const decoder = new TextDecoder();
		let received = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > URL_MAX_BYTES) {
				await reader.cancel().catch(() => {});
				throw new Error(`Fetch failed: response exceeds the ${URL_MAX_BYTES} byte URL ingest cap`);
			}
			html += decoder.decode(value, { stream: true });
		}
		html += decoder.decode();
	} else {
		html = await res.text();
	}
	const text = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&[a-z]+;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return chunkFile(text, source);
}

function normalizeExtractedText(text: string | string[]): string {
	return Array.isArray(text) ? text.join("\n\n") : text;
}

interface ExtractedSourceFile {
	content: string;
	fileType: string;
	/** Set when a PDF was converted to markdown by an external sidecar. */
	sourceFormat?: "pdf";
	/** Sidecar converter that produced the content ("marker" | "docling"); absent for unpdf. */
	converter?: string;
}

function sidecarMetadata(extracted: ExtractedSourceFile): { converter: string } | undefined {
	return extracted.converter ? { converter: extracted.converter } : undefined;
}

// PDFs go through the optional external converter sidecar first (marker/docling, producing
// math-aware markdown); any sidecar failure is fail-open and falls back to unpdf silently,
// recording a pdf_sidecar_failed scan entry when scan stats are available.
async function extractPdfSourceFileContent(
	filePath: string,
	signal?: AbortSignal,
	skipped?: ReturnType<typeof createSkippedScanStats>,
): Promise<ExtractedSourceFile> {
	const config = resolvePdfSidecarConfig();
	if (config.engine !== "off") {
		try {
			const sidecar = await detectSidecar(config);
			if (sidecar !== "none") {
				const { markdown, converter } = await convertPdf(filePath, config, signal);
				return { content: markdown, fileType: "markdown", sourceFormat: "pdf", converter };
			}
		} catch (error) {
			if (signal?.aborted || isCancellationError(error)) throw error;
			if (error instanceof SidecarError) {
				if (skipped) addSkippedScanEntry(skipped, { path: filePath, reason: "pdf_sidecar_failed" });
			} else {
				throw error;
			}
		}
	}
	throwIfAborted(signal);
	// PDF extraction is an optional heavy runtime path; keep parser loading out of extension startup.
	const { extractText } = await import("unpdf");
	throwIfAborted(signal);
	const buf = readFileSync(filePath);
	throwIfAborted(signal);
	const { text } = await extractText(new Uint8Array(buf));
	throwIfAborted(signal);
	return { content: normalizeExtractedText(text), fileType: "pdf" };
}

async function extractSourceFileContent(
	filePath: string,
	signal?: AbortSignal,
	skipped?: ReturnType<typeof createSkippedScanStats>,
): Promise<ExtractedSourceFile> {
	const lowerPath = filePath.toLowerCase();
	if (lowerPath.endsWith(".pdf")) {
		return extractPdfSourceFileContent(filePath, signal, skipped);
	}
	if (lowerPath.endsWith(".docx") || lowerPath.endsWith(".doc")) {
		throwIfAborted(signal);
		// DOCX extraction is an optional heavy runtime path; keep parser loading out of extension startup.
		const mammoth = await import("mammoth");
		throwIfAborted(signal);
		const result = await mammoth.extractRawText({ path: filePath });
		throwIfAborted(signal);
		return { content: result.value, fileType: "docx" };
	}
	if (!isReadableTextFile(filePath)) {
		throw new Error(`File is not readable text and has no supported extractor: ${filePath}`);
	}
	throwIfAborted(signal);
	return { content: readFileSync(filePath, "utf-8"), fileType: "text" };
}

interface ClassifiedSource {
	resolvedSource: string;
	isUrl: boolean;
	isDir: boolean;
	isFile: boolean;
	sourceType: "url" | "directory" | "file" | "text";
}

function looksLikeLocalPath(source: string): boolean {
	const trimmed = source.trim();
	if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return false;
	if (/^(?:https?:)?\/\//.test(trimmed)) return false;
	if (trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.startsWith("~")) return true;
	if (trimmed.includes("/") || trimmed.includes("\\")) return true;
	return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(trimmed);
}

function classifySource(source: string): ClassifiedSource {
	const resolvedSource = resolve(source);
	const isUrl = source.startsWith("http://") || source.startsWith("https://");
	const isDir = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isDirectory();
	const isFile = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isFile();
	if (!isUrl && !isDir && !isFile && looksLikeLocalPath(source)) {
		throw new Error(`Local path does not exist: ${source}. Pass inline text only when the source itself is text.`);
	}
	return {
		resolvedSource,
		isUrl,
		isDir,
		isFile,
		sourceType: isUrl ? "url" : isDir ? "directory" : isFile ? "file" : "text",
	};
}

async function extractScannableFileContent(
	file: ScannableFile,
	signal?: AbortSignal,
	skipped?: ReturnType<typeof createSkippedScanStats>,
): Promise<ExtractedSourceFile> {
	return extractSourceFileContent(file.path, signal, skipped);
}

async function extractScannableFileContentOrSkip(
	file: ScannableFile,
	skipped: ReturnType<typeof createSkippedScanStats>,
	signal?: AbortSignal,
): Promise<ExtractedSourceFile | undefined> {
	try {
		return await extractScannableFileContent(file, signal, skipped);
	} catch (error) {
		if (signal?.aborted || isCancellationError(error)) throw error;
		addSkippedScanEntry(skipped, { path: file.relPath, reason: "extraction_failed", size: file.size });
		return undefined;
	}
}

function persistEmbeddingMetadata(
	db: Database.Database,
	kbId: string,
	config: EmbeddingConfig,
	vectors: Float32Array[],
): number | undefined {
	const firstVector = vectors[0];
	if (!firstVector) return undefined;
	const dimension = firstVector.length;
	updateKBEmbeddingMetadata(db, kbId, embeddingConfigLabel(config), embeddingSignature(config, dimension), dimension);
	return dimension;
}

function embeddingMismatchWarning(kb: KnowledgeBase): string {
	return `"${kb.name}" has incompatible embedding metadata; vector retrieval was skipped and knowledge_update should rebuild it`;
}

function canSearchVectors(kb: KnowledgeBase, config: EmbeddingConfig, queryDimension: number): boolean {
	if (kb.embedding_signature === null || kb.embedding_dimension === null) return false;
	if (kb.embedding_dimension !== queryDimension) return false;
	return kb.embedding_signature === embeddingSignature(config, queryDimension);
}
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Cancelled");
}

function importedChunkToInsert(chunk: ImportedChunk): ChunkInsert {
	const metadataJson = chunk.metadata_json || "{}";
	return {
		content_hash: chunkIdentityHash({
			content: chunk.content,
			filePath: chunk.file_path,
			fileType: chunk.file_type,
			startLine: chunk.start_line,
			endLine: chunk.end_line,
			metadataJson,
		}),
		content: chunk.content,
		content_tokenized: "",
		file_path: chunk.file_path,
		file_type: chunk.file_type,
		start_line: chunk.start_line,
		end_line: chunk.end_line,
		metadata_json: metadataJson,
	};
}

// Layer 3 formula index (spec §3.3 of docs/layer3-formula-retrieval-plan.md): rows are computed
// from chunk metadata already in memory and written PRE-normalized via replaceFormulasForChunk.
// Parse/normalize failures yield no rows — formula features fail open, never the mutation.
function formulaRowsFromMetadataJson(metadataJson: string): Array<{
	ordinal: number;
	raw: string;
	normalized: string;
	tokenCount: number;
}> {
	try {
		const parsed = JSON.parse(metadataJson) as { formulas?: unknown };
		if (!parsed || !Array.isArray(parsed.formulas)) return [];
		const rows: Array<{ ordinal: number; raw: string; normalized: string; tokenCount: number }> = [];
		for (const raw of parsed.formulas) {
			if (typeof raw !== "string") continue;
			const normalized = normalizeFormula(raw);
			if (!normalized) continue;
			rows.push({
				ordinal: rows.length,
				raw: normalized.raw,
				normalized: normalized.normalized,
				tokenCount: normalized.tokenCount,
			});
		}
		return rows;
	} catch {
		return [];
	}
}

function writeFormulaRowsForInsertedChunks(
	db: Database.Database,
	kbId: string,
	chunkIds: string[],
	chunks: ChunkInsert[],
): void {
	for (let i = 0; i < chunks.length; i++) {
		try {
			replaceFormulasForChunk(db, kbId, chunkIds[i], formulaRowsFromMetadataJson(chunks[i].metadata_json));
		} catch {
			// fail-open: formula features stay dormant for this chunk
		}
	}
}

// Layer 4 label graph (spec §3.5): unlike formula rows, label edges are a RELATIONAL view of
// chunk metadata (labels/refs) resolved against the KB's complete file set, so edges are rebuilt
// once per completed mutation instead of per inserted batch — per-batch resolution against a
// half-indexed file set would record nondeterministic resolutions.
function labelGraphInputsFromMetadataJson(metadataJson: string): { labels: string[]; refs: string[] } {
	try {
		const parsed = JSON.parse(metadataJson) as { labels?: unknown; refs?: unknown };
		const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((v): v is string => typeof v === "string") : [];
		const refs = Array.isArray(parsed.refs) ? parsed.refs.filter((v): v is string => typeof v === "string") : [];
		return { labels, refs };
	} catch {
		return { labels: [], refs: [] };
	}
}

// Must mirror label-resolve.ts normalizePath so defining-chunk keys line up with the
// targetPath that resolveLabelTarget returns.
function normalizeLabelGraphPath(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

// Full deterministic rebuild of one KB's label edges from chunk metadata. Chunks with no refs
// get an empty replacement so stale edges are cleared on re-sync. Unresolved edges are recorded
// with resolved_chunk_id/target_content_hash NULL — never guessed.
function rebuildLabelGraphForKB(db: Database.Database, kbId: string): void {
	const kbChunks: Array<{ id: string; kb_id: string; file_path: string; content_hash: string; metadata_json: string }> =
		[];
	const labelFiles = new Map<string, string[]>();
	const definingChunkByFileLabel = new Map<string, { chunkId: string; contentHash: string }>();
	for (const chunk of listChunksForLabelBackfill(db, kbId)) {
		kbChunks.push(chunk);
		const { labels } = labelGraphInputsFromMetadataJson(chunk.metadata_json);
		for (const label of labels) {
			let files = labelFiles.get(label);
			if (!files) {
				files = [];
				labelFiles.set(label, files);
			}
			files.push(chunk.file_path);
			const key = `${normalizeLabelGraphPath(chunk.file_path)}\0${label}`;
			if (!definingChunkByFileLabel.has(key)) {
				definingChunkByFileLabel.set(key, { chunkId: chunk.id, contentHash: chunk.content_hash });
			}
		}
	}
	for (const chunk of kbChunks) {
		const { refs } = labelGraphInputsFromMetadataJson(chunk.metadata_json);
		const rows: LabelEdgeInsert[] = [];
		const seenScopeKeys = new Set<string>();
		for (const ref of refs) {
			const resolution = resolveLabelTarget(chunk.file_path, ref, labelFiles.get(ref) ?? []);
			if (seenScopeKeys.has(resolution.scopeKey)) continue;
			seenScopeKeys.add(resolution.scopeKey);
			let resolvedChunkId: string | null = null;
			let targetContentHash: string | null = null;
			if (resolution.targetPath) {
				const target = definingChunkByFileLabel.get(`${resolution.targetPath}\0${ref}`);
				if (target) {
					resolvedChunkId = target.chunkId;
					targetContentHash = target.contentHash;
				}
			}
			rows.push({ targetLabel: ref, scopeKey: resolution.scopeKey, resolvedChunkId, targetContentHash, kind: "ref" });
		}
		replaceLabelEdgesForChunk(db, kbId, chunk.id, rows);
	}
}

// Groups resolved edges per triggering chunk, keeping the first `capPerTrigger` edges in a
// deterministic (src, label, scope) order — the depth-1 walk cap of spec §3.5.
function edgesGroupedPerTrigger(
	rows: ResolvedLabelEdgeRow[],
	capPerTrigger: number,
): Map<string, ResolvedLabelEdgeRow[]> {
	// Byte-stable codepoint ordering: localeCompare varies across hosts, which could
	// change which edges survive the cap (S3 determinism requires host independence).
	const byCodepoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
	const sorted = [...rows].sort(
		(a, b) =>
			byCodepoint(a.src_chunk_id, b.src_chunk_id) ||
			byCodepoint(a.target_label, b.target_label) ||
			byCodepoint(a.scope_key, b.scope_key),
	);
	const grouped = new Map<string, ResolvedLabelEdgeRow[]>();
	for (const row of sorted) {
		const edges = grouped.get(row.src_chunk_id);
		if (edges) {
			if (edges.length < capPerTrigger) edges.push(row);
			continue;
		}
		grouped.set(row.src_chunk_id, [row]);
	}
	return grouped;
}

// FTS query for the fuzzy formula leg: quoted OR-joined canonical tokens, following the
// bm25.ts quoted-term discipline (raw user text is never passed as FTS syntax).
// searchFormulasFTS re-validates the shape and reduces anything else to a safe phrase.
function buildFormulaFtsQuery(formulas: NormalizedFormula[]): string {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const formula of formulas) {
		for (const token of formula.tokens) {
			if (token.includes('"') || seen.has(token)) continue;
			seen.add(token);
			terms.push(`"${token}"`);
		}
	}
	return terms.join(" OR ");
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
	if (stream.write(`${line}\n`)) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
		};
		const onDrain = (): void => {
			cleanup();
			resolve();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		stream.once("drain", onDrain);
		stream.once("error", onError);
	});
}

async function finishWriteStream(stream: WriteStream): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			stream.off("finish", onFinish);
			stream.off("error", onError);
		};
		const onFinish = (): void => {
			cleanup();
			resolve();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		stream.once("finish", onFinish);
		stream.once("error", onError);
		stream.end();
	});
}

export class KnowledgeEngine {
	private db: Database.Database | null = null;
	private knowledgeDir: string = "";
	private activeUpdates = new Map<string, Promise<{ added: number; removed: number; unchanged: number }>>();
	private activeMutations = new Map<string, Promise<unknown>>();
	// Layer 3 in-process backfill guard (complements knowledge_bases.formula_index_built).
	private formulaIndexesEnsured = new Set<string>();
	// Layer 4 in-process label-graph guard (complements knowledge_bases.label_graph_built).
	private labelGraphsEnsured = new Set<string>();
	private disposing = false;

	private runExclusive<T>(keys: string | string[], description: string, operation: () => Promise<T> | T): Promise<T> {
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		const mutationKeys = Array.isArray(keys) ? keys : [keys];
		for (const key of mutationKeys) {
			if (this.activeMutations.has(key)) throw new Error(`${description} is already running`);
		}
		const run = Promise.resolve()
			.then(operation)
			.finally(() => {
				for (const key of mutationKeys) {
					if (this.activeMutations.get(key) === run) this.activeMutations.delete(key);
				}
			});
		for (const key of mutationKeys) this.activeMutations.set(key, run);
		return run;
	}

	async initialize(knowledgeDir: string): Promise<void> {
		this.knowledgeDir = knowledgeDir;
		this.db = openDatabase(knowledgeDir);
		this.disposing = false;
	}

	private vectorPathFor(kbId: string): string {
		return join(this.knowledgeDir, "vectors", `${kbId}.bin`);
	}

	private deleteVectorFile(kbId: string): void {
		rmSync(this.vectorPathFor(kbId), { force: true });
	}

	// Layer 3 backfill (spec §3.3): runs once per kb per process, guarded persistently by
	// knowledge_bases.formula_index_built and in-process by formulaIndexesEnsured. Never throws:
	// on failure formula features stay dormant for the rest of the process, all else unchanged.
	private ensureFormulaIndexesBuilt(kbIds: string[]): void {
		if (!this.db) return;
		for (const kbId of kbIds) {
			if (this.formulaIndexesEnsured.has(kbId)) continue;
			this.formulaIndexesEnsured.add(kbId);
			try {
				const kb = getKB(this.db, kbId);
				if (!kb || kb.formula_index_built === 1) continue;
				for (const chunk of listChunksForFormulaBackfill(this.db, kbId)) {
					const rows = formulaRowsFromMetadataJson(chunk.metadata_json);
					if (rows.length === 0) continue;
					replaceFormulasForChunk(this.db, kbId, chunk.id, rows);
				}
				markFormulaIndexBuilt(this.db, kbId);
			} catch {
				// fail-open: retrying is intentionally skipped for this process
			}
		}
	}

	// Layer 4 backfill (spec §3.5): verbatim L3 guard pattern — persistent flag + in-process Set
	// + fail-open. Zero-latex KBs rebuild to zero edges and stay dormant. Called at the END of a
	// successful add (label edges need the complete KB file set, unlike per-chunk formula rows).
	private ensureLabelGraphsBuilt(kbIds: string[]): void {
		if (!this.db) return;
		for (const kbId of kbIds) {
			if (this.labelGraphsEnsured.has(kbId)) continue;
			this.labelGraphsEnsured.add(kbId);
			try {
				const kb = getKB(this.db, kbId);
				if (!kb || kb.label_graph_built === 1) continue;
				rebuildLabelGraphForKB(this.db, kbId);
				markLabelGraphBuilt(this.db, kbId);
			} catch {
				// fail-open: retrying is intentionally skipped for this process
			}
		}
	}

	plan(source: string, options: AddOptions = {}, signal?: AbortSignal): IndexPlan {
		throwIfAborted(signal);
		const { resolvedSource, isDir, isFile, sourceType } = classifySource(source);
		if (isDir) {
			const plan = planDirectoryScan(resolvedSource, toScanOptions(options), signal);
			return {
				source_type: "directory",
				scannable_files: plan.files,
				scannable_bytes: plan.bytes,
				skipped: plan.skipped,
				summary: `Directory plan: ${plan.files} scannable files, ${formatBytes(plan.bytes)} scannable text, skipped ${plan.skippedTotal} (${plan.skippedSummary})`,
			};
		}
		if (isFile) {
			const skipped = createSkippedScanStats();
			const supportedDocument = isSupportedDocumentFile(resolvedSource);
			if (!supportedDocument && !isReadableTextFile(resolvedSource)) {
				skipped.total = 1;
				skipped.by_reason.binary = 1;
				skipped.samples.push({ path: resolvedSource, reason: "binary" });
				return {
					source_type: "file",
					scannable_files: 0,
					scannable_bytes: 0,
					skipped,
					summary: "File plan: 0 scannable files; file is unsupported binary/non-text",
				};
			}
			const size = statSync(resolvedSource).size;
			return {
				source_type: "file",
				scannable_files: 1,
				scannable_bytes: size,
				skipped,
				summary: `File plan: 1 scannable file, ${formatBytes(size)} source size`,
			};
		}
		const skipped = createSkippedScanStats();
		return {
			source_type: sourceType,
			scannable_files: 1,
			scannable_bytes: Buffer.byteLength(source),
			skipped,
			summary: `${sourceType === "url" ? "URL" : "Inline text"} plan: 1 source`,
		};
	}

	async add(
		source: string,
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		options: AddOptions = {},
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		throwIfAborted(signal);
		return this.runExclusive(["global:mutation", `kb-name:${name}`], `Mutation for "${name}"`, () =>
			this.addUnlocked(source, name, onProgress, signal, options),
		);
	}

	private async addUnlocked(
		source: string,
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		options: AddOptions = {},
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const db = this.db;
		const { resolvedSource, isUrl, isDir, isFile, sourceType } = classifySource(source);
		const scanOptions = toScanOptions(options);

		const existingKB = getKBByName(db, name);
		if (existingKB) {
			throw new Error(
				`Knowledge base "${name}" already exists. Use knowledge_update to refresh it, or knowledge_remove before adding a replacement.`,
			);
		}

		const embeddingConfig = resolveEmbeddingConfig();
		let vectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		let tempVectorFile: string | undefined;
		// createKB/status/job run inside the try so a DB-level throw can never leak a KB row
		// stuck in "indexing" with no vector file and no cleanup path (the catch deleteKBs it
		// via the getKBByName re-read below).
		try {
			const kb = createKB(db, {
				name,
				source_path: isDir || isFile ? resolvedSource : isUrl ? source : undefined,
				source_type: sourceType,
				source_options: serializeAddOptions(options),
				embedding_model: embeddingConfigLabel(embeddingConfig),
			});
			updateKBStatus(db, kb.id, "indexing");
			startIndexingJob(db, kb.id, "add", `Starting indexing for "${name}"`);
			// Layer 3 (spec §3.3): the formula flag is stamped only AFTER all rows are written (end of
			// the success path, beside the label graph) — an interrupted add leaves flag=0 so the
			// first math query backfills/repairs instead of being disabled forever.

			const vectorPath = this.vectorPathFor(kb.id);
			tempVectorFile = tempVectorPath(vectorPath);
			const writer = openVectorWriter(tempVectorFile);
			vectorWriter = writer;
			let chunkCount = 0;
			let fileCount = 0;
			const pendingChunks: Awaited<ReturnType<typeof chunkFile>> = [];
			const startedAt = Date.now();
			let latestSkippedTotal = 0;
			let latestSkippedSummary = "none";

			const reportProgress = (
				phase: string,
				processedFiles?: number,
				totalFiles?: number,
				skippedTotal = latestSkippedTotal,
			): void => {
				latestSkippedTotal = skippedTotal;
				const elapsed = Date.now() - startedAt;
				const chunkRate = chunkCount / Math.max(1, elapsed / 1000);
				let suffix = `${chunkCount} chunks, ${chunkRate.toFixed(1)} chunks/s, elapsed ${formatDuration(elapsed)}`;
				if (processedFiles !== undefined && totalFiles !== undefined && totalFiles > 0) {
					const rate = processedFiles / Math.max(1, elapsed / 1000);
					const remainingFiles = Math.max(0, totalFiles - processedFiles);
					const etaMs = rate > 0 ? (remainingFiles / rate) * 1000 : 0;
					suffix = `${processedFiles}/${totalFiles} files, ${suffix}, file ETA ${formatDuration(etaMs)}`;
				} else if (processedFiles !== undefined) {
					suffix = `${processedFiles} files scanned, ${suffix}`;
				}
				if (skippedTotal > 0) suffix = `${suffix}, skipped ${skippedTotal}`;
				const message = `${phase}: ${suffix}`;
				updateIndexingJob(db, kb.id, {
					phase,
					message,
					processed_files: processedFiles,
					processed_chunks: chunkCount,
					total_files: totalFiles,
					skipped_total: skippedTotal,
					added_chunks: chunkCount,
				});
				onProgress?.(message);
			};

			const flushPending = async (processedFiles?: number, totalFiles?: number): Promise<void> => {
				if (pendingChunks.length === 0) return;
				if (signal?.aborted) throw new Error("Cancelled");
				const batch = pendingChunks.splice(0, INDEX_EMBED_BATCH_SIZE);
				reportProgress(`Embedding batch of ${batch.length}`, processedFiles, totalFiles);
				const vectors = await embedDocuments(
					batch.map((chunk) => buildChunkEmbeddingText(chunk)),
					signal,
				);
				if (signal?.aborted) throw new Error("Cancelled");
				assertEmbeddingBatchSize(vectors, batch.length, "add");
				persistEmbeddingMetadata(db, kb.id, embeddingConfig, vectors);
				const insertedIds = insertChunks(db, kb.id, batch);
				writeFormulaRowsForInsertedChunks(db, kb.id, insertedIds, batch);
				writer.append(vectors);
				chunkCount += batch.length;
				updateKBCounts(db, kb.id, chunkCount, fileCount);
				reportProgress("Stored batch", processedFiles, totalFiles);
			};

			const addChunks = async (
				chunks: Awaited<ReturnType<typeof chunkFile>>,
				processedFiles?: number,
				totalFiles?: number,
			): Promise<void> => {
				pendingChunks.push(...chunks);
				while (pendingChunks.length >= INDEX_EMBED_BATCH_SIZE) {
					await flushPending(processedFiles, totalFiles);
				}
			};
			const addSymbols = (content: string, filePath: string, fileType: string): void => {
				insertSymbols(db, kb.id, extractSymbols(content, filePath, fileType));
			};
			const analyzeAndAddSymbols = async (
				content: string,
				filePath: string,
				fileType: string,
				extraMetadata?: { converter: string },
			): Promise<Omit<ChunkInsert, "kb_id">[]> => {
				const analysis = await analyzeIndexableContent(content, filePath, fileType, extraMetadata);
				insertSymbols(db, kb.id, analysis.symbols);
				return analysis.chunks;
			};

			if (isUrl) {
				const message = `Fetching ${source}...`;
				updateIndexingJob(this.db, kb.id, { phase: "fetching", message });
				onProgress?.(message);
				const chunks = await chunkUrl(source, signal);
				fileCount = 1;
				addSymbols(chunks.map((chunk) => chunk.content).join("\n\n"), source, "html");
				await addChunks(chunks);
			} else if (isFile) {
				const extracted = await extractSourceFileContent(resolvedSource, signal);
				fileCount = 1;
				const chunks = await analyzeAndAddSymbols(
					extracted.content,
					resolvedSource,
					extracted.fileType,
					sidecarMetadata(extracted),
				);
				await addChunks(chunks);
			} else if (isDir) {
				const plan = planDirectoryScan(resolvedSource, scanOptions, signal);
				const planningMessage = `Planned directory scan: ${plan.files} files, ${formatBytes(
					plan.bytes,
				)} scannable text, skipped ${plan.skippedTotal} (${plan.skippedSummary})`;
				updateIndexingJob(this.db, kb.id, {
					phase: "planning",
					message: planningMessage,
					total_files: plan.files,
					skipped_total: plan.skippedTotal,
				});
				onProgress?.(planningMessage);
				const scanningMessage = `Scanning ${resolvedSource}...`;
				updateIndexingJob(this.db, kb.id, {
					phase: "scanning",
					message: scanningMessage,
					total_files: plan.files,
					skipped_total: plan.skippedTotal,
				});
				onProgress?.(scanningMessage);
				const skipped = createSkippedScanStats();
				let processedFiles = 0;
				for (const file of iterateScannableFiles(resolvedSource, skipped, scanOptions)) {
					if (signal?.aborted) throw new Error("Cancelled");
					const extracted = await extractScannableFileContentOrSkip(file, skipped, signal);
					if (!extracted) {
						latestSkippedTotal = skipped.total;
						continue;
					}
					const chunks = await analyzeAndAddSymbols(
						extracted.content,
						file.relPath,
						extracted.fileType,
						sidecarMetadata(extracted),
					);
					processedFiles++;
					latestSkippedTotal = skipped.total;
					if (chunks.length > 0) fileCount++;
					await addChunks(chunks, processedFiles, plan.files);
					if (processedFiles % 25 === 0) reportProgress("Chunking", processedFiles, plan.files, skipped.total);
				}
				latestSkippedTotal = skipped.total;
				latestSkippedSummary = summarizeSkippedScan(skipped);
				const finalizingMessage = `Scanned ${processedFiles} files, skipped ${skipped.total} (${latestSkippedSummary}), finalizing...`;
				updateIndexingJob(this.db, kb.id, {
					phase: "finalizing",
					message: finalizingMessage,
					processed_files: processedFiles,
					processed_chunks: chunkCount,
					total_files: plan.files,
					skipped_total: skipped.total,
					added_chunks: chunkCount,
				});
				onProgress?.(finalizingMessage);
			} else {
				fileCount = 1;
				const chunks = await analyzeAndAddSymbols(source, "inline-text", "text");
				await addChunks(chunks);
			}

			await flushPending();
			vectorWriter.close();
			vectorWriter = undefined;
			renameSync(tempVectorFile, vectorPath);
			tempVectorFile = undefined;

			const savedFileCount = isDir ? getFileCount(this.db, kb.id) : fileCount;
			updateKBCounts(this.db, kb.id, chunkCount, savedFileCount);
			updateKBStatus(this.db, kb.id, "ready");

			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after add: ${kb.id}`);
			const skippedReadySuffix =
				latestSkippedTotal > 0 ? `, skipped ${latestSkippedTotal} (${latestSkippedSummary})` : "";
			const readyMessage = `Ready: ${chunkCount} chunks from ${savedFileCount} files in ${formatDuration(
				Date.now() - startedAt,
			)}${skippedReadySuffix}`;
			updateIndexingJob(this.db, kb.id, {
				phase: "ready",
				message: readyMessage,
				processed_files: savedFileCount,
				processed_chunks: chunkCount,
				skipped_total: latestSkippedTotal,
				added_chunks: chunkCount,
			});
			// Layer 3 (spec §3.3) + Layer 4 (spec §3.5): the KB's complete file set exists — stamp
			// the formula index built (rows were written per batch above) and build the label graph.
			markFormulaIndexBuilt(this.db, kb.id);
			this.ensureLabelGraphsBuilt([kb.id]);
			finishIndexingJob(this.db, kb.id, "succeeded", readyMessage);
			onProgress?.(readyMessage);
			return { kb: savedKB, chunkCount };
		} catch (e) {
			try {
				vectorWriter?.close();
			} catch {
				// close() writes via writeSync — a disk-full throw here must not abort the
				// rollback (rm + deleteKB) or mask the original error.
			}
			if (tempVectorFile) rmSync(tempVectorFile, { force: true });
			// createKB/status/job are inside the try now: re-read the KB by name so a failure at
			// any point after creation still cleans up the partial row (and a failure BEFORE
			// creation cleans up nothing).
			const created = this.db ? getKBByName(this.db, name) : undefined;
			if (this.db && created) {
				finishIndexingJob(
					this.db,
					created.id,
					isCancellationError(e) ? "cancelled" : "failed",
					isCancellationError(e) ? "Indexing cancelled." : "Indexing failed.",
					e instanceof Error ? e.message : String(e),
				);
				deleteKB(this.db, created.id);
				this.deleteVectorFile(created.id);
			}
			throw e;
		}
	}

	async update(
		nameOrId: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
	): Promise<{ added: number; removed: number; unchanged: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		throwIfAborted(signal);
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		if (!kb.source_path || (kb.source_type !== "url" && !existsSync(kb.source_path))) {
			throw new Error(`Source path not available or missing: ${kb.source_path}`);
		}
		const updateableKB: UpdateableKnowledgeBase = { ...kb, source_path: kb.source_path };

		const activeUpdate = this.activeUpdates.get(updateableKB.id);
		if (activeUpdate) {
			// Overlapping same-KB updates must FAIL LOUDLY, not coalesce. A coalesced caller used to
			// receive the in-flight update's promise whose file scan predates its own trigger — the
			// watcher then treated the stale result as "change indexed" and lost it permanently.
			// Rejecting keeps every consumer honest: the watcher retries after the in-flight run
			// settles, and a human caller gets a truthful error instead of borrowed counters.
			throw new Error(`An update for "${updateableKB.name}" is already running; retry after it finishes.`);
		}

		const updateRun = this.runExclusive(
			["global:mutation", `kb:${updateableKB.id}`],
			`Mutation for "${updateableKB.name}"`,
			() => this.runUpdate(updateableKB, onProgress, signal),
		).finally(() => {
			if (this.activeUpdates.get(updateableKB.id) === updateRun) this.activeUpdates.delete(updateableKB.id);
		});
		this.activeUpdates.set(updateableKB.id, updateRun);
		return updateRun;
	}

	private async runUpdate(
		kb: UpdateableKnowledgeBase,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
	): Promise<{ added: number; removed: number; unchanged: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		// Resolve embedding config and source options BEFORE mutating any persistent state: a throw
		// here (broken PI_KNOWLEDGE_EMBEDDING value, unreadable stored options) must not leave a
		// permanently "running" indexing job or an "indexing" kb behind — the catch block below
		// only sees failures raised after updateKBStatus/startIndexingJob have run.
		const scanOptions = toScanOptions(parseAddOptions(kb.source_options));
		const embeddingConfig = resolveEmbeddingConfig();
		const embeddingModel = embeddingConfigLabel(embeddingConfig);
		const currentSignature =
			kb.embedding_dimension === null ? undefined : embeddingSignature(embeddingConfig, kb.embedding_dimension);
		let canReuseExistingVectors =
			kb.embedding_signature !== null && kb.embedding_dimension !== null && kb.embedding_signature === currentSignature;
		let replacementVectorPath: string | undefined;
		let addedVectorPath: string | undefined;
		let addedVectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		const insertedChunkIds: string[] = [];
		const stagedSymbols: KnowledgeSymbolInsert[] = [];

		updateKBStatus(this.db, kb.id, "indexing");
		startIndexingJob(this.db, kb.id, "update", `Starting update for "${kb.name}"`);

		try {
			const vectorPath = this.vectorPathFor(kb.id);
			addedVectorPath = tempVectorPath(`${vectorPath}.added`);
			addedVectorWriter = openVectorWriter(addedVectorPath);
			let latestSkippedTotal = 0;
			let latestSkippedSummary = "none";
			const existingHashes = new Map<string, Array<{ id: string; vectorIndex: number }>>();
			let existingIndex = 0;
			for (const chunk of iterateChunksByKB(this.db, kb.id)) {
				const entries = existingHashes.get(chunk.content_hash) ?? [];
				entries.push({ id: chunk.id, vectorIndex: existingIndex });
				existingHashes.set(chunk.content_hash, entries);
				existingIndex++;
			}
			if (canReuseExistingVectors) {
				const oldVectorReader = openVectorReader(vectorPath);
				try {
					if (
						!oldVectorReader ||
						oldVectorReader.count !== existingIndex ||
						oldVectorReader.dim !== kb.embedding_dimension
					) {
						canReuseExistingVectors = false;
						const vectorCount = oldVectorReader?.count ?? 0;
						const vectorDimension = oldVectorReader?.dim ?? 0;
						const message = `Stored vector file for "${kb.name}" is incomplete or incompatible (${vectorCount} vectors/${vectorDimension}d for ${existingIndex} chunks/${kb.embedding_dimension}d); rebuilding all vectors`;
						updateIndexingJob(this.db, kb.id, { phase: "embedding", message });
						onProgress?.(message);
					}
				} finally {
					oldVectorReader?.close();
				}
			}
			const reusableHashes = canReuseExistingVectors
				? existingHashes
				: new Map<string, Array<{ id: string; vectorIndex: number }>>();
			if (!canReuseExistingVectors) {
				const message = `Embedding metadata changed or missing for "${kb.name}"; rebuilding all vectors`;
				updateIndexingJob(this.db, kb.id, { phase: "embedding", message });
				onProgress?.(message);
			}

			const oldVectorIndexByHash = new Map<string, number[]>();
			const newVectorIndexByHash = new Map<string, number[]>();
			const pendingChunks: Awaited<ReturnType<typeof chunkFile>> = [];
			let addedVectorCount = 0;
			let addedCount = 0;
			let unchanged = 0;
			let scannedFiles = 0;
			let scannedChunks = 0;
			let plannedTotalFiles: number | undefined;
			let finalEmbeddingDimension: number | undefined;
			const startedAt = Date.now();

			const flushPending = async (): Promise<void> => {
				if (!this.db || !addedVectorWriter || pendingChunks.length === 0) return;
				if (signal?.aborted) throw new Error("Cancelled");
				const batch = pendingChunks.splice(0, INDEX_EMBED_BATCH_SIZE);
				const elapsed = Date.now() - startedAt;
				const message = `Embedding update batch: ${addedCount} new chunks stored, ${scannedFiles} files scanned, elapsed ${formatDuration(
					elapsed,
				)}`;
				updateIndexingJob(this.db, kb.id, {
					phase: "embedding",
					message,
					processed_files: scannedFiles,
					processed_chunks: scannedChunks,
					total_files: plannedTotalFiles,
					added_chunks: addedCount,
					unchanged_chunks: unchanged,
				});
				onProgress?.(message);
				const newVectors = await embedDocuments(
					batch.map((c) => buildChunkEmbeddingText(c)),
					signal,
				);
				if (signal?.aborted) throw new Error("Cancelled");
				assertEmbeddingBatchSize(newVectors, batch.length, "update");
				addedVectorWriter.append(newVectors);
				for (let i = 0; i < batch.length; i++) {
					const indexes = newVectorIndexByHash.get(batch[i].content_hash) ?? [];
					indexes.push(addedVectorCount + i);
					newVectorIndexByHash.set(batch[i].content_hash, indexes);
				}
				addedVectorCount += newVectors.length;
				const insertedIds = insertChunks(this.db, kb.id, batch);
				insertedChunkIds.push(...insertedIds);
				writeFormulaRowsForInsertedChunks(this.db, kb.id, insertedIds, batch);
				addedCount += batch.length;
				updateKBCounts(this.db, kb.id, getChunkCount(this.db, kb.id), getFileCount(this.db, kb.id));
				const storedMessage = `Stored update batch: +${addedCount} chunks, =${unchanged} unchanged`;
				updateIndexingJob(this.db, kb.id, {
					phase: "storing",
					message: storedMessage,
					processed_files: scannedFiles,
					processed_chunks: scannedChunks,
					total_files: plannedTotalFiles,
					added_chunks: addedCount,
					unchanged_chunks: unchanged,
				});
				onProgress?.(storedMessage);
			};

			const processChunks = async (chunks: Awaited<ReturnType<typeof chunkFile>>): Promise<void> => {
				for (const chunk of chunks) {
					scannedChunks++;
					const existing = reusableHashes.get(chunk.content_hash);
					if (existing && existing.length > 0) {
						const retained = existing.shift();
						if (retained) {
							const indexes = oldVectorIndexByHash.get(chunk.content_hash) ?? [];
							indexes.push(retained.vectorIndex);
							oldVectorIndexByHash.set(chunk.content_hash, indexes);
						}
						unchanged++;
						continue;
					}
					pendingChunks.push(chunk);
					if (pendingChunks.length >= INDEX_EMBED_BATCH_SIZE) await flushPending();
				}
			};

			updateIndexingJob(this.db, kb.id, { phase: "scanning", message: "Scanning source..." });
			onProgress?.("Scanning source...");
			if (kb.source_type === "url") {
				const message = `Fetching ${kb.source_path}...`;
				updateIndexingJob(this.db, kb.id, { phase: "fetching", message });
				onProgress?.(message);
				scannedFiles = 1;
				const chunks = await chunkUrl(kb.source_path, signal);
				stagedSymbols.push(
					...extractSymbols(chunks.map((chunk) => chunk.content).join("\n\n"), kb.source_path, "html"),
				);
				await processChunks(chunks);
			} else if (statSync(kb.source_path).isDirectory()) {
				const plan = planDirectoryScan(kb.source_path, scanOptions, signal);
				plannedTotalFiles = plan.files;
				const planningMessage = `Planned directory scan: ${plan.files} files, ${formatBytes(
					plan.bytes,
				)} scannable text, skipped ${plan.skippedTotal} (${plan.skippedSummary})`;
				updateIndexingJob(this.db, kb.id, {
					phase: "planning",
					message: planningMessage,
					total_files: plan.files,
					skipped_total: plan.skippedTotal,
				});
				onProgress?.(planningMessage);
				const skipped = createSkippedScanStats();
				for (const file of iterateScannableFiles(kb.source_path, skipped, scanOptions)) {
					if (signal?.aborted) throw new Error("Cancelled");
					const extracted = await extractScannableFileContentOrSkip(file, skipped, signal);
					if (!extracted) continue;
					const analysis = await analyzeIndexableContent(
						extracted.content,
						file.relPath,
						extracted.fileType,
						sidecarMetadata(extracted),
					);
					scannedFiles++;
					stagedSymbols.push(...analysis.symbols);
					await processChunks(analysis.chunks);
					if (scannedFiles % 25 === 0) {
						const message = `Scanned ${scannedFiles} files, ${scannedChunks} chunks, skipped ${skipped.total}, +${addedCount} =${unchanged}`;
						updateIndexingJob(this.db, kb.id, {
							phase: "scanning",
							message,
							processed_files: scannedFiles,
							processed_chunks: scannedChunks,
							total_files: plan.files,
							skipped_total: skipped.total,
							added_chunks: addedCount,
							unchanged_chunks: unchanged,
						});
						onProgress?.(message);
					}
				}
				latestSkippedTotal = skipped.total;
				latestSkippedSummary = summarizeSkippedScan(skipped);
				const message = `Scanned ${scannedFiles} files, skipped ${skipped.total} (${latestSkippedSummary}), reconciling deletes...`;
				updateIndexingJob(this.db, kb.id, {
					phase: "reconciling",
					message,
					processed_files: scannedFiles,
					processed_chunks: scannedChunks,
					total_files: plan.files,
					skipped_total: skipped.total,
					added_chunks: addedCount,
					unchanged_chunks: unchanged,
				});
				onProgress?.(message);
			} else {
				const extracted = await extractSourceFileContent(kb.source_path, signal);
				scannedFiles = 1;
				const analysis = await analyzeIndexableContent(
					extracted.content,
					kb.source_path,
					extracted.fileType,
					sidecarMetadata(extracted),
				);
				stagedSymbols.push(...analysis.symbols);
				await processChunks(analysis.chunks);
			}
			await flushPending();
			addedVectorWriter.close();
			addedVectorWriter = undefined;

			// Data-safety guard: a directory scan that yielded zero readable files against a
			// non-empty KB is far more likely a broken mount, chmod'd-away directory, or offline
			// network drive (existsSync stays true for all of them) than an intentional full
			// deletion. Abort non-cancellably and keep the index intact — intentional emptying
			// should go through knowledge_remove.
			if (kb.source_type === "directory" && scannedFiles === 0 && kb.chunk_count > 0) {
				throw new Error(
					`Update aborted: source directory "${kb.source_path}" yielded no readable files while the KB holds ${kb.chunk_count} chunks. Refusing to wipe the index — if emptying it is intentional, remove the KB instead.`,
				);
			}

			const idsToRemove: string[] = [];
			for (const entries of existingHashes.values()) {
				idsToRemove.push(...entries.map((entry) => entry.id));
			}
			const idsToRemoveSet = new Set(idsToRemove);
			const changesMessage = `Changes: +${addedCount} -${idsToRemove.length} =${unchanged}`;
			updateIndexingJob(this.db, kb.id, {
				phase: "reconciling",
				message: changesMessage,
				processed_files: scannedFiles,
				processed_chunks: scannedChunks,
				added_chunks: addedCount,
				removed_chunks: idsToRemove.length,
				unchanged_chunks: unchanged,
			});
			onProgress?.(changesMessage);

			replacementVectorPath = tempVectorPath(vectorPath);
			const vectorWriter = openVectorWriter(replacementVectorPath);
			const oldVectorReader = openVectorReader(vectorPath);
			const newVectorReader = openVectorReader(addedVectorPath);
			let finalChunkCount = 0;
			const takeVectorIndex = (indexesByHash: Map<string, number[]>, hash: string): number | undefined => {
				const indexes = indexesByHash.get(hash);
				return indexes?.shift();
			};
			const repairMissingVector = async (chunk: Chunk): Promise<Float32Array> => {
				const message = `Re-embedding chunk with missing stored vector: ${chunk.id}`;
				if (!this.db) throw new Error("Engine not initialized");
				updateIndexingJob(this.db, kb.id, {
					phase: "embedding",
					message,
					processed_files: scannedFiles,
					processed_chunks: finalChunkCount,
					added_chunks: addedCount,
					removed_chunks: idsToRemove.length,
					unchanged_chunks: unchanged,
				});
				onProgress?.(message);
				const repairedVectors = await embedDocuments([buildChunkEmbeddingText(chunk)], signal);
				if (signal?.aborted) throw new Error("Cancelled");
				assertEmbeddingBatchSize(repairedVectors, 1, "repair");
				const [repairedVector] = repairedVectors;
				if (!repairedVector) throw new Error(`Embedding provider returned no repaired vector for chunk: ${chunk.id}`);
				return repairedVector;
			};
			try {
				for (const chunk of iterateChunksByKB(this.db, kb.id)) {
					if (signal?.aborted) throw new Error("Cancelled");
					if (idsToRemoveSet.has(chunk.id)) continue;
					const oldVectorIndex = takeVectorIndex(oldVectorIndexByHash, chunk.content_hash);
					const newVectorIndex = takeVectorIndex(newVectorIndexByHash, chunk.content_hash);
					let vector =
						oldVectorReader && oldVectorIndex !== undefined
							? oldVectorReader.read(oldVectorIndex)
							: newVectorReader && newVectorIndex !== undefined
								? newVectorReader.read(newVectorIndex)
								: undefined;
					if (!vector) vector = await repairMissingVector(chunk);
					finalEmbeddingDimension ??= vector.length;
					vectorWriter.append([vector]);
					finalChunkCount++;
					if (finalChunkCount % 1_000 === 0) {
						const message = `Rebuilding vector file: ${finalChunkCount} chunks written`;
						updateIndexingJob(this.db, kb.id, {
							phase: "rebuilding_vectors",
							message,
							processed_files: scannedFiles,
							processed_chunks: finalChunkCount,
							added_chunks: addedCount,
							removed_chunks: idsToRemove.length,
							unchanged_chunks: unchanged,
						});
						onProgress?.(message);
					}
				}
			} finally {
				oldVectorReader?.close();
				newVectorReader?.close();
				vectorWriter.close();
			}
			renameSync(replacementVectorPath, vectorPath);
			replacementVectorPath = undefined;
			if (addedVectorPath) rmSync(addedVectorPath, { force: true });
			addedVectorPath = undefined;
			if (idsToRemove.length > 0) {
				deleteFormulasForChunks(this.db, idsToRemove);
				deleteLabelEdgesForChunks(this.db, idsToRemove);
				deleteChunksByIds(this.db, idsToRemove);
			}
			deleteSymbolsByKB(this.db, kb.id);
			insertSymbols(this.db, kb.id, stagedSymbols);
			// Layer 4 (spec §3.5): re-sync label edges against the final chunk set. Unconditional
			// (not flag-guarded) because updates can change refs of previously built KBs. Fail-open.
			try {
				rebuildLabelGraphForKB(this.db, kb.id);
			} catch {
				// fail-open: stale label edges are tolerated until the next successful mutation
			}

			updateKBEmbeddingMetadata(
				this.db,
				kb.id,
				embeddingModel,
				finalEmbeddingDimension === undefined ? null : embeddingSignature(embeddingConfig, finalEmbeddingDimension),
				finalEmbeddingDimension ?? null,
			);
			updateKBCounts(this.db, kb.id, finalChunkCount, getFileCount(this.db, kb.id));
			updateKBStatus(this.db, kb.id, "ready");
			const skippedReadySuffix =
				latestSkippedTotal > 0 ? `, skipped ${latestSkippedTotal} (${latestSkippedSummary})` : "";
			const readyMessage = `Ready: +${addedCount} -${idsToRemove.length} =${unchanged}${skippedReadySuffix}`;
			updateIndexingJob(this.db, kb.id, {
				phase: "ready",
				message: readyMessage,
				processed_files: scannedFiles,
				processed_chunks: finalChunkCount,
				added_chunks: addedCount,
				removed_chunks: idsToRemove.length,
				unchanged_chunks: unchanged,
			});
			finishIndexingJob(this.db, kb.id, "succeeded", readyMessage);
			onProgress?.(readyMessage);

			return { added: addedCount, removed: idsToRemove.length, unchanged };
		} catch (e) {
			try {
				addedVectorWriter?.close();
			} catch {
				// preserve the original error and let the rollback below complete
			}
			if (replacementVectorPath) rmSync(replacementVectorPath, { force: true });
			if (addedVectorPath) rmSync(addedVectorPath, { force: true });
			if (insertedChunkIds.length > 0) {
				deleteFormulasForChunks(this.db, insertedChunkIds);
				deleteLabelEdgesForChunks(this.db, insertedChunkIds);
				deleteChunksByIds(this.db, insertedChunkIds);
				updateKBCounts(this.db, kb.id, getChunkCount(this.db, kb.id), getFileCount(this.db, kb.id));
			}
			updateKBStatus(this.db, kb.id, isCancellationError(e) ? kb.status : "error");
			finishIndexingJob(
				this.db,
				kb.id,
				isCancellationError(e) ? "cancelled" : "failed",
				isCancellationError(e) ? "Update cancelled." : "Update failed.",
				e instanceof Error ? e.message : String(e),
			);
			throw e;
		}
	}

	async search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const requestedMode: SearchMode = options.mode ?? "hybrid";
		if (requestedMode === "auto") {
			const primaryMode = chooseAutoMode(query);
			const attempts = [primaryMode, ...fallbackModesFor(primaryMode)];
			const tried: SearchMode[] = [];
			const warnings: string[] = [];
			let lastTuning: SearchTuningSummary | undefined;
			for (const mode of attempts) {
				if (tried.includes(mode)) continue;
				tried.push(mode);
				throwIfAborted(signal);
				const response = await this.search(query, { ...options, mode }, signal);
				lastTuning = response.tuning;
				if (response.warnings) warnings.push(...response.warnings);
				if (!isWeakAutoResponse(query, response, primaryMode, mode)) {
					return {
						...response,
						warnings: warnings.length > 0 ? [...new Set(warnings)] : response.warnings,
						mode_used: mode,
						retry_modes: tried.slice(0, -1),
						suggestions: response.suggestions,
					};
				}
				if (tried.length >= 3) break;
			}
			return {
				results: [],
				total_count: 0,
				has_more: false,
				warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined,
				mode_used: tried.at(-1),
				retry_modes: tried.slice(0, -1),
				tuning: lastTuning,
				suggestions: [
					"No results after auto mode fallback. Check knowledge_status, try a more exact term, or rebuild the KB if indexing rules changed.",
				],
			};
		}
		const db = this.db;
		const { mode = "hybrid", kb_id, filters, diversity = "balanced" } = options;
		const rawOffset = options.offset ?? 0;
		const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
		const resolvedMode = retrievalModeFor(mode);
		const retrievalMode = resolvedMode === "adaptive" ? "hybrid" : resolvedMode;
		const queryTokens = tokenizeForSimilarity(query);
		const normalizedFileType = normalizeFileTypeFilter(filters?.file_type);
		// Layer 3 (spec §3.4.1): extracted before any other fusion work; zero formulas keeps the
		// whole path — and the results — byte-identical to pre-L3.
		const queryFormulas = extractQueryFormulas(query);

		const warnings: string[] = [];
		const selectedKB = kb_id ? (getKB(db, kb_id) ?? getKBByName(db, kb_id)) : undefined;
		if (kb_id && !selectedKB) throw new Error(`Knowledge base not found: ${kb_id}`);
		const availableKBs = kb_id ? ([selectedKB].filter(Boolean) as KnowledgeBase[]) : listKBs(db);
		const kbs = availableKBs.filter((kb) => kb.status === "ready" || kb.status === "stale");
		const kbById = new Map(kbs.map((kb) => [kb.id, kb]));
		for (const kb of availableKBs) {
			if (kb.status !== "ready" && kb.status !== "stale") {
				warnings.push(`"${kb.name}" is ${kb.status}; search skipped until indexing is ready`);
			}
		}
		const tuning = resolveSearchTuning({
			query,
			mode,
			profile: options.profile,
			kbSourceTypes: kbs.map((kb) => kb.source_type),
		});
		const limit =
			typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
				? Math.trunc(options.limit)
				: tuning.defaultLimit;
		const candidateLimit = Math.max(tuning.candidateMin, offset + limit * tuning.candidateMultiplier);
		const tuningSummary = summarizeSearchTuning(tuning, limit, candidateLimit);
		if (kbs.length === 0) {
			return {
				results: [],
				total_count: 0,
				has_more: false,
				suggestions: EMPTY_RESULT_SUGGESTIONS,
				warnings: warnings.length > 0 ? warnings : undefined,
				mode_used: mode,
				tuning: tuningSummary,
			};
		}

		const allResults: { chunkId: string; score: number }[] = [];
		const vectorsByChunkId = new Map<string, Float32Array>();

		// The query embedding depends only on the query, never on the KB: compute it lazily once
		// and share the promise across every semantic/hybrid leg, so a workspace with K ready KBs
		// performs one embedding roundtrip per search instead of K identical ones.
		let queryEmbeddingPromise: Promise<{ vector: Float32Array; config: EmbeddingConfig }> | undefined;
		const getQueryEmbedding = (): Promise<{ vector: Float32Array; config: EmbeddingConfig }> => {
			if (!queryEmbeddingPromise) queryEmbeddingPromise = embedQueryWithConfig(query, signal);
			return queryEmbeddingPromise;
		};

		for (const kb of kbs) {
			throwIfAborted(signal);
			if (kb.chunk_count === 0) continue;
			const vectorPath = this.vectorPathFor(kb.id);

			if (retrievalMode === "fast") {
				allResults.push(
					...searchBM25(db, query, candidateLimit, kb.id, { allowOrFallback: false }).map((result) => ({
						...result,
						score: result.score * kbTrustMultiplier(kb),
					})),
				);
			} else if (retrievalMode === "semantic") {
				const { vector: queryVec, config: queryEmbeddingConfig } = await getQueryEmbedding();
				throwIfAborted(signal);
				if (!canSearchVectors(kb, queryEmbeddingConfig, queryVec.length)) {
					warnings.push(embeddingMismatchWarning(kb));
					continue;
				}
				const vectorResults = searchVectorFile(
					queryVec,
					vectorPath,
					iterateChunkIdsByKB(db, kb.id),
					candidateLimit,
					signal,
				);
				allResults.push(
					...vectorResults.results.map((result) => ({ ...result, score: result.score * kbTrustMultiplier(kb) })),
				);
				for (const [chunkId, vector] of vectorResults.vectorsByChunkId) vectorsByChunkId.set(chunkId, vector);
			} else {
				const bm25Results = searchBM25(db, query, candidateLimit, kb.id);
				if (bm25Results.length === 0) continue;

				let vecResults: { chunkId: string; score: number }[] = [];
				const { vector: queryVec, config: queryEmbeddingConfig } = await getQueryEmbedding();
				throwIfAborted(signal);
				if (canSearchVectors(kb, queryEmbeddingConfig, queryVec.length)) {
					const vectorResults = searchVectorFile(
						queryVec,
						vectorPath,
						iterateChunkIdsByKB(db, kb.id),
						candidateLimit,
						signal,
					);
					vecResults = vectorResults.results;
					for (const [chunkId, vector] of vectorResults.vectorsByChunkId) vectorsByChunkId.set(chunkId, vector);
				} else {
					warnings.push(embeddingMismatchWarning(kb));
				}
				const fused = weightedScoreFusion(bm25Results, vecResults);
				allResults.push(...fused.map((result) => ({ ...result, score: result.score * kbTrustMultiplier(kb) })));
			}
		}

		// Deduplicate and sort
		const seen = new Set<string>();
		const unique = allResults.filter((r) => {
			if (seen.has(r.chunkId)) return false;
			seen.add(r.chunkId);
			return true;
		});
		const rankingByChunkId = new Map<string, RankingDiagnostics>();
		for (const result of unique) {
			throwIfAborted(signal);
			const chunk = getChunkById(db, result.chunkId);
			if (chunk) {
				const ranking = scoreChunkForQuery(result.score, chunk, queryTokens);
				rankingByChunkId.set(result.chunkId, ranking);
				result.score = ranking.adjusted_score;
			}
		}
		// Layer 3 formula fusion (spec §3.4): post-merge, pre-threshold. Candidate collection is
		// per kb (exact 1.0; fuzzy 0.8 * rank-normalized), the boost leg raises already-retrieved
		// results by FORMULA_BOOST * formulaScore, and absent candidates are injected further below.
		const formulaScores = new Map<string, number>();
		const formulaInjectedChunkIds = new Set<string>();
		if (queryFormulas.formulas.length > 0) {
			this.ensureFormulaIndexesBuilt(kbs.map((kb) => kb.id));
			for (const kb of kbs) {
				for (const row of findExactFormulas(
					db,
					kb.id,
					queryFormulas.formulas.map((f) => f.normalized),
				)) {
					formulaScores.set(row.chunk_id, Math.max(formulaScores.get(row.chunk_id) ?? 0, 1));
				}
				const ftsRows = searchFormulasFTS(db, kb.id, buildFormulaFtsQuery(queryFormulas.formulas), 50);
				const topRank = ftsRows.length; // ranks are dense 1..N in best-first order
				for (const row of ftsRows) {
					const ftsScore = (FORMULA_FUZZY_TOP_SCORE * (topRank - row.rank + 1)) / topRank;
					formulaScores.set(row.chunk_id, Math.max(formulaScores.get(row.chunk_id) ?? 0, ftsScore));
				}
			}
			for (const result of unique) {
				const formulaScore = formulaScores.get(result.chunkId);
				if (formulaScore === undefined) continue;
				result.score += FORMULA_BOOST * formulaScore;
				// Diagnostics contract: adjusted_score tracks the final published score.
				const ranking = rankingByChunkId.get(result.chunkId);
				if (ranking) ranking.adjusted_score = result.score;
			}
		}
		// Layer 4 label-graph dependency fusion (spec §3.5): post-merge, pre-threshold, beside the
		// formula leg. Retrieved chunks carrying resolved outgoing edges walk depth 1: targets that
		// are already retrieved gain a flat DEPENDENCY_BOOST (self-references excluded); absent
		// targets are injected after the formula injection leg below; depends_on provenance records
		// every walked edge. Zero resolved edges ⇒ zero work — dormant-path results stay
		// byte-identical to pre-L4.
		const dependsOnByChunkId = new Map<string, DependencyEdgeProvenance[]>();
		const dependencyInjectedChunkIds = new Set<string>();
		let dependencyEdgesActive = false;
		let edgesPerTrigger = new Map<string, ResolvedLabelEdgeRow[]>();
		this.ensureLabelGraphsBuilt(kbs.map((kb) => kb.id));
		// kb-scoped lookup per kb (idx_label_edges_kb_src); concatenation is safe because
		// edgesGroupedPerTrigger re-sorts the full row set deterministically.
		const triggerChunkIds = unique.map((result) => result.chunkId);
		const labelEdgeRows = kbs.flatMap((kb) => findResolvedLabelEdges(db, triggerChunkIds, kb.id));
		if (labelEdgeRows.length > 0) {
			dependencyEdgesActive = true;
			edgesPerTrigger = edgesGroupedPerTrigger(labelEdgeRows, DEPENDENCY_WALK_EDGES_PER_CHUNK);
			const uniqueByChunkId = new Map(unique.map((result) => [result.chunkId, result]));
			const boostedTargets = new Set<string>();
			for (const result of unique) {
				const edges = edgesPerTrigger.get(result.chunkId);
				if (!edges) continue;
				const dependsOn: DependencyEdgeProvenance[] = [];
				for (const edge of edges) {
					const target = getChunkById(db, edge.resolved_chunk_id);
					if (!target || !kbById.has(target.kb_id)) continue;
					dependsOn.push({
						label: edge.target_label,
						chunk_id: edge.resolved_chunk_id,
						pinned: edge.target_content_hash === target.content_hash,
					});
					const targetResult = uniqueByChunkId.get(edge.resolved_chunk_id);
					if (targetResult && targetResult !== result && !boostedTargets.has(edge.resolved_chunk_id)) {
						boostedTargets.add(edge.resolved_chunk_id);
						targetResult.score += DEPENDENCY_BOOST;
						// Diagnostics contract: adjusted_score tracks the final published score.
						const targetRanking = rankingByChunkId.get(edge.resolved_chunk_id);
						if (targetRanking) targetRanking.adjusted_score = targetResult.score;
					}
				}
				if (dependsOn.length > 0) dependsOnByChunkId.set(result.chunkId, dependsOn);
			}
		}
		let scored = unique;
		if (retrievalMode === "fast") {
			scored = unique.filter((result) => {
				const chunk = getChunkById(db, result.chunkId);
				if (!chunk) return false;
				return hasAnyLexicalEvidence(buildChunkEmbeddingText(chunk), queryTokens);
			});
		} else if (retrievalMode !== "semantic") {
			scored = unique.filter((result) => {
				const chunk = getChunkById(db, result.chunkId);
				if (!chunk) return false;
				return result.score >= tuning.minHybridScore && hasEnoughLexicalEvidence(chunk, queryTokens);
			});
		}
		scored.sort((a, b) => b.score - a.score);

		// Apply metadata filters post-retrieval
		let filtered = scored;
		if (normalizedFileType || filters?.path_pattern) {
			filtered = scored.filter((r) => {
				const chunk = getChunkById(db, r.chunkId);
				if (!chunk) return false;
				if (normalizedFileType && chunk.file_type !== normalizedFileType) return false;
				if (filters?.path_pattern && !chunk.file_path.includes(filters.path_pattern)) return false;
				return true;
			});
		}

		// Layer 3 injection leg (spec §3.4.5): formula candidates absent from the retrieved set
		// become real results with match_reason "formula" — filter-first, then capped, sorted by
		// formula score desc, respecting kb scope and metadata filters, and bypassing
		// MIN_HYBRID_SCORE (ratified: formula evidence is not a lexical-prose score). Injected
		// scores carry the same kbTrustMultiplier as every retrieved leg so cross-kb comparison
		// stays consistent.
		if (queryFormulas.formulas.length > 0 && formulaScores.size > 0) {
			const retrievedIds = new Set(unique.map((result) => result.chunkId));
			const candidates = [...formulaScores.entries()]
				.filter(([chunkId]) => !retrievedIds.has(chunkId))
				.sort((a, b) => b[1] - a[1]);
			// Cap counts candidates that pass kb scope + metadata filters, so top-5 filter misses
			// cannot starve filter-passing matches at lower ranks.
			let injectedCount = 0;
			for (const [chunkId, formulaScore] of candidates) {
				if (injectedCount >= FORMULA_INJECTION_LIMIT) break;
				const chunk = getChunkById(db, chunkId);
				const kb = chunk ? kbById.get(chunk.kb_id) : undefined;
				if (!chunk || !kb) continue;
				if (normalizedFileType && chunk.file_type !== normalizedFileType) continue;
				if (filters?.path_pattern && !chunk.file_path.includes(filters.path_pattern)) continue;
				formulaInjectedChunkIds.add(chunkId);
				const injectedScore = formulaScore * kbTrustMultiplier(kb);
				filtered.push({ chunkId, score: injectedScore });
				rankingByChunkId.set(chunkId, injectedRankingDiagnostics(chunk, injectedScore, queryTokens));
				injectedCount += 1;
			}
			if (formulaInjectedChunkIds.size > 0) filtered.sort((a, b) => b.score - a.score);
		}

		// Layer 4 dependency injection leg (spec §3.5): referenced chunks absent from the retrieved
		// set become real results with match_reason "dependency" — filter-first, then capped (10
		// injections per query), base score exactly DEPENDENCY_BOOST before the kb trust multiplier,
		// bypassing MIN_HYBRID_SCORE (same ratified rationale as formula evidence). Chunks injected
		// by the formula leg also trigger the walk ("retrieved/injected", spec §3.5); their
		// depends_on provenance is recorded here since the pre-threshold pass cannot see them yet.
		if (dependencyEdgesActive && formulaInjectedChunkIds.size > 0) {
			const injectedTriggerChunkIds = [...formulaInjectedChunkIds];
			const injectedTriggerEdges = edgesGroupedPerTrigger(
				kbs.flatMap((kb) => findResolvedLabelEdges(db, injectedTriggerChunkIds, kb.id)),
				DEPENDENCY_WALK_EDGES_PER_CHUNK,
			);
			for (const [triggerId, edges] of injectedTriggerEdges) {
				const dependsOn: DependencyEdgeProvenance[] = [];
				for (const edge of edges) {
					const target = getChunkById(db, edge.resolved_chunk_id);
					if (!target || !kbById.has(target.kb_id)) continue;
					dependsOn.push({
						label: edge.target_label,
						chunk_id: edge.resolved_chunk_id,
						pinned: edge.target_content_hash === target.content_hash,
					});
				}
				if (dependsOn.length > 0) dependsOnByChunkId.set(triggerId, dependsOn);
			}
		}
		if (dependencyEdgesActive) {
			const retrievedIds = new Set(unique.map((result) => result.chunkId));
			const candidates: string[] = [];
			const queued = new Set<string>();
			for (const result of unique) {
				for (const edge of edgesPerTrigger.get(result.chunkId) ?? []) {
					if (edge.resolved_chunk_id === result.chunkId) continue;
					if (retrievedIds.has(edge.resolved_chunk_id) || queued.has(edge.resolved_chunk_id)) continue;
					queued.add(edge.resolved_chunk_id);
					candidates.push(edge.resolved_chunk_id);
				}
			}
			// Cap counts candidates that pass kb scope + metadata filters, so top-10 filter misses
			// cannot starve filter-passing matches at lower ranks (formula-leg discipline).
			let injectedCount = 0;
			for (const chunkId of candidates) {
				if (injectedCount >= DEPENDENCY_INJECTION_LIMIT) break;
				// A chunk already injected by the formula leg must not be injected again here —
				// duplicate rows with conflicting match_reason would otherwise reach the results.
				if (formulaInjectedChunkIds.has(chunkId)) continue;
				const chunk = getChunkById(db, chunkId);
				const kb = chunk ? kbById.get(chunk.kb_id) : undefined;
				if (!chunk || !kb) continue;
				if (normalizedFileType && chunk.file_type !== normalizedFileType) continue;
				if (filters?.path_pattern && !chunk.file_path.includes(filters.path_pattern)) continue;
				dependencyInjectedChunkIds.add(chunkId);
				const injectedScore = DEPENDENCY_BOOST * kbTrustMultiplier(kb);
				filtered.push({ chunkId, score: injectedScore });
				rankingByChunkId.set(chunkId, injectedRankingDiagnostics(chunk, injectedScore, queryTokens));
				injectedCount += 1;
			}
			if (dependencyInjectedChunkIds.size > 0) filtered.sort((a, b) => b.score - a.score);
		}

		if (mode === "deep" && filtered.length > 0) {
			const candidates = filtered
				.slice(0, tuning.deepRerankCandidates)
				.map((r) => {
					const chunk = getChunkById(db, r.chunkId);
					return chunk ? { chunkId: r.chunkId, content: chunk.content } : null;
				})
				.filter(Boolean) as Array<{ chunkId: string; content: string }>;
			const reranked = await rerank(
				query,
				candidates,
				Math.max(limit * tuning.deepRerankTopKMultiplier, limit),
				signal,
			);
			const ranked: RankedChunk[] = [];
			for (const r of reranked) {
				throwIfAborted(signal);
				const chunk = getChunkById(db, r.chunkId);
				if (!chunk) continue;
				const kbObj = getKB(db, chunk.kb_id);
				ranked.push({
					chunk,
					kbName: kbObj?.name ?? "unknown",
					ranking: scoreChunkForQuery(r.score, chunk, queryTokens),
					score: r.score,
					content: chunk.content,
					snippet: buildQuerySnippet(chunk.content, query, tuning.snippetMaxLength),
					startLine: chunk.start_line,
					endLine: chunk.end_line,
					sourceChunkIds: [chunk.id],
				});
			}
			const diversified = interleaveByFile(diversifyRankedChunks(ranked, diversity, vectorsByChunkId), diversity);
			const page = diversified.slice(offset, offset + limit);
			const results = page.map((r) => {
				const kb = kbById.get(r.chunk.kb_id);
				const sourceMtime = sourceMtimeFor(kb, r.chunk.file_path);
				const dependsOn = dependsOnByChunkId.get(r.chunk.id);
				return {
					content: r.content,
					file_path: r.chunk.file_path,
					file_type: r.chunk.file_type,
					kb_name: r.kbName,
					score: r.score,
					ranking: r.ranking,
					snippet: r.snippet,
					start_line: r.startLine,
					end_line: r.endLine,
					provenance: {
						chunk_id: r.chunk.id,
						chunk_hash: r.chunk.content_hash,
						indexed_at: r.chunk.indexed_at,
						source_mtime: sourceMtime,
						stale: sourceMtime !== undefined ? sourceMtime > r.chunk.indexed_at : kb?.status === "stale",
						match_reason: formulaInjectedChunkIds.has(r.chunk.id)
							? "formula"
							: dependencyInjectedChunkIds.has(r.chunk.id)
								? "dependency"
								: matchReasonFor(mode),
						source_chunk_ids: r.sourceChunkIds,
						...(dependsOn ? { depends_on: dependsOn } : {}),
					},
				};
			});
			return {
				results,
				total_count: diversified.length,
				has_more: offset + limit < diversified.length,
				warnings: warnings.length > 0 ? warnings : undefined,
				mode_used: mode,
				tuning: tuningSummary,
				suggestions: results.length === 0 ? EMPTY_RESULT_SUGGESTIONS : undefined,
			};
		}

		const ranked: RankedChunk[] = [];
		for (const r of filtered) {
			throwIfAborted(signal);
			const chunk = getChunkById(db, r.chunkId);
			if (!chunk) continue;
			const kb = getKB(db, chunk.kb_id);

			if (mode === "adaptive") {
				const contextChunks = getChunksByFile(
					db,
					chunk.kb_id,
					chunk.file_path,
					Math.max(1, chunk.start_line - tuning.adaptiveContextLines),
					chunk.end_line + tuning.adaptiveContextLines,
				);
				const context = buildAdaptiveContext(chunk, contextChunks.length > 0 ? contextChunks : [chunk], queryTokens, {
					maxContextChars: tuning.adaptiveMaxContextChars,
					neighborTarget: tuning.adaptiveNeighborTarget,
				});
				pushAdaptiveCandidate(ranked, {
					chunk,
					kbName: kb?.name ?? "unknown",
					ranking: rankingByChunkId.get(r.chunkId),
					score: r.score,
					content: context.content,
					snippet: buildQuerySnippet(context.content, query, tuning.snippetMaxLength),
					startLine: context.startLine,
					endLine: context.endLine,
					sourceChunkIds: context.sourceChunkIds,
				});
			} else {
				ranked.push({
					chunk,
					kbName: kb?.name ?? "unknown",
					ranking: rankingByChunkId.get(r.chunkId),
					score: r.score,
					content: chunk.content,
					snippet: buildQuerySnippet(chunk.content, query, tuning.snippetMaxLength),
					startLine: chunk.start_line,
					endLine: chunk.end_line,
					sourceChunkIds: [chunk.id],
				});
			}
		}

		const diversified = interleaveByFile(diversifyRankedChunks(ranked, diversity, vectorsByChunkId), diversity);
		const total = diversified.length;
		const page = diversified.slice(offset, offset + limit);
		const results: SearchResult[] = page.map((r) => ({
			content: r.content,
			file_path: r.chunk.file_path,
			file_type: r.chunk.file_type,
			kb_name: r.kbName,
			score: r.score,
			ranking: r.ranking,
			snippet: r.snippet,
			start_line: r.startLine,
			end_line: r.endLine,
			provenance: (() => {
				const kb = kbById.get(r.chunk.kb_id);
				const sourceMtime = sourceMtimeFor(kb, r.chunk.file_path);
				const dependsOn = dependsOnByChunkId.get(r.chunk.id);
				return {
					chunk_id: r.chunk.id,
					chunk_hash: r.chunk.content_hash,
					indexed_at: r.chunk.indexed_at,
					source_mtime: sourceMtime,
					stale: sourceMtime !== undefined ? sourceMtime > r.chunk.indexed_at : kb?.status === "stale",
					match_reason: formulaInjectedChunkIds.has(r.chunk.id)
						? "formula"
						: dependencyInjectedChunkIds.has(r.chunk.id)
							? "dependency"
							: matchReasonFor(mode),
					source_chunk_ids: r.sourceChunkIds,
					...(dependsOn ? { depends_on: dependsOn } : {}),
				};
			})(),
		}));

		return {
			results,
			total_count: total,
			has_more: offset + limit < total,
			warnings: warnings.length > 0 ? warnings : undefined,
			mode_used: mode,
			tuning: tuningSummary,
			suggestions: results.length === 0 ? EMPTY_RESULT_SUGGESTIONS : undefined,
		};
	}

	remove(nameOrId: string): boolean {
		if (!this.db) return false;
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		if (this.activeMutations.size > 0) throw new Error("A knowledge-base mutation is already running");
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) return false;
		// Vector file first: if its deletion throws (EACCES/EBUSY), the KB row survives and the
		// caller's watcher stays consistent with the still-existing KB. Row-first would leave a
		// deleted row with a live watcher on partial failure.
		this.deleteVectorFile(kb.id);
		deleteKB(this.db, kb.id);
		return true;
	}

	list(signal?: AbortSignal): KnowledgeBase[] {
		if (!this.db) return [];
		throwIfAborted(signal);
		return listKBs(this.db);
	}

	clear(): void {
		if (!this.db) return;
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		if (this.activeMutations.size > 0) throw new Error("A knowledge-base mutation is already running");
		for (const kb of listKBs(this.db)) {
			// Same ordering rationale as remove(): vector file before row.
			this.deleteVectorFile(kb.id);
			deleteKB(this.db, kb.id);
		}
	}

	diagnose(signal?: AbortSignal): DiagnosticResult[] {
		if (!this.db) return [];
		throwIfAborted(signal);
		const db = this.db;
		return listKBs(db).map((kb) => {
			throwIfAborted(signal);
			return diagnoseKB(db, kb, signal);
		});
	}

	symbolSearch(query: string, options: SymbolSearchOptions = {}, signal?: AbortSignal): SymbolSearchResponse {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const db = this.db;
		const selectedKB = options.kb_id ? (getKB(db, options.kb_id) ?? getKBByName(db, options.kb_id)) : undefined;
		if (options.kb_id && !selectedKB) throw new Error(`Knowledge base not found: ${options.kb_id}`);
		const limit = Math.max(1, Math.min(200, options.limit ?? 20));
		const offset = Math.max(0, options.offset ?? 0);
		const symbolOptions = {
			kbId: selectedKB?.id,
			kind: options.kind,
			filePattern: options.file_pattern,
			exact: options.exact,
		};
		const symbols = searchSymbols(db, query, {
			...symbolOptions,
			limit: limit + 1,
			offset,
		});
		throwIfAborted(signal);
		const page = symbols.slice(0, limit);
		const total = countSymbols(db, query, symbolOptions);
		throwIfAborted(signal);
		return {
			results: page.map((symbol) => {
				const kb = getKB(db, symbol.kb_id);
				return {
					name: symbol.name,
					kind: symbol.kind,
					file_path: symbol.file_path,
					file_type: symbol.file_type,
					kb_name: kb?.name ?? "unknown",
					start_line: symbol.start_line,
					end_line: symbol.end_line,
					signature: symbol.signature ?? undefined,
					container_name: symbol.container_name ?? undefined,
					text: symbol.text,
					indexed_at: symbol.indexed_at,
				};
			}),
			total_count: total,
			has_more: offset + page.length < total,
		};
	}

	doctor(signal?: AbortSignal): DoctorReport {
		throwIfAborted(signal);
		const diagnostics = this.diagnose(signal);
		const issues: DoctorIssue[] = [];
		const kbs = this.list();
		if (kbs.length === 0) {
			issues.push({
				severity: "blocking",
				message: "No knowledge bases are indexed.",
				action: "Run knowledge_add for the project root or relevant source/docs directory.",
				action_code: "rebuild_kb",
			});
		}

		for (const diagnostic of diagnostics) {
			throwIfAborted(signal);
			if (diagnostic.stuck_indexing) {
				const phase = diagnostic.job ? ` during ${diagnostic.job.phase}` : "";
				issues.push({
					severity: "blocking",
					kb_name: diagnostic.kb_name,
					message: `Indexing appears stuck${phase} for ${formatDuration(diagnostic.last_progress_age_ms)}.`,
					action:
						"Check knowledge_status for the last progress message. If no Pi process is actively indexing it, remove and rebuild this KB.",
					action_code: "wait_for_indexing",
				});
			}
			if (diagnostic.status === "error") {
				issues.push({
					severity: "blocking",
					kb_name: diagnostic.kb_name,
					message: "Knowledge base is in error state and is skipped by search.",
					action: "Run knowledge_remove and knowledge_add to rebuild it from the source.",
					action_code: "rebuild_kb",
				});
			}
			if (diagnostic.coverage_percent < 80) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `Coverage is ${diagnostic.coverage_percent}% (${diagnostic.indexed_files}/${diagnostic.total_source_files} files).`,
					action: "Review skipped files and source path. Rebuild if index-time rules changed.",
					action_code: "review_skipped_scope",
				});
			}
			if (diagnostic.stale_files.length > 0) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `${diagnostic.stale_files.length} files changed after indexing.`,
					action: "Run knowledge_update for this KB.",
					action_code: "run_update",
				});
			}
			if (diagnostic.orphan_files.length > 0) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `${diagnostic.orphan_files.length} indexed files no longer exist in the source.`,
					action: "Run knowledge_update or rebuild the KB.",
					action_code: "run_update",
				});
			}
			if (diagnostic.skipped_files.total > 0) {
				issues.push({
					severity: "info",
					kb_name: diagnostic.kb_name,
					message: `${diagnostic.skipped_files.total} files were skipped while scanning (${Object.entries(
						diagnostic.skipped_files.by_reason,
					)
						.filter(([, count]) => count > 0)
						.map(([reason, count]) => `${reason}: ${count}`)
						.join(", ")}).`,
					action:
						"Use skipped samples to confirm exclusions are expected. Adjust source path or ignore rules if needed.",
					action_code: "review_skipped_scope",
				});
			}
		}

		if (this.db) {
			for (const kb of kbs) {
				throwIfAborted(signal);
				if (kb.status === "ready" && kb.chunk_count > 0 && getSymbolCount(this.db, kb.id) === 0) {
					issues.push({
						severity: "info",
						kb_name: kb.name,
						message: "No lightweight symbols are indexed for this KB.",
						action: "Run knowledge_update to rebuild symbol/config/heading lookup metadata.",
						action_code: "run_update",
					});
				}
			}
		}

		const penalty = issues.reduce((score, issue) => {
			if (issue.severity === "blocking") return score + 35;
			if (issue.severity === "warning") return score + 12;
			return score + 2;
		}, 0);
		const healthScore = Math.max(0, Math.min(100, 100 - penalty));
		const blocking = issues.filter((issue) => issue.severity === "blocking").length;
		const warnings = issues.filter((issue) => issue.severity === "warning").length;
		const summary =
			issues.length === 0
				? "Knowledge system is healthy."
				: `${blocking} blocking, ${warnings} warning, ${issues.length - blocking - warnings} info issues.`;

		return {
			health_score: healthScore,
			summary,
			issues,
			diagnostics,
			actions: issues.map((issue) => ({
				code: issue.action_code ?? "none",
				kb_name: issue.kb_name,
				target: issue.kb_name,
				description: issue.action,
			})),
		};
	}

	async exportKB(
		nameOrId: string,
		outputPath: string,
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
	): Promise<number> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		return this.runExclusive(["global:mutation", `kb:${kb.id}`], `Operation for "${kb.name}"`, () =>
			this.exportKBUnlocked(kb, outputPath, signal, onProgress),
		);
	}

	private async exportKBUnlocked(
		kb: KnowledgeBase,
		outputPath: string,
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
	): Promise<number> {
		if (!this.db) throw new Error("Engine not initialized");
		const { createWriteStream } = await import("node:fs");
		const tempOutputPath = tempVectorPath(outputPath);
		const stream = createWriteStream(tempOutputPath, { encoding: "utf-8" });
		// A cancelled export can destroy the stream and unlink the temp file while the async open
		// is still in flight; that late ENOENT would surface as an unhandled 'error' event.
		// Capture it — real write/finish errors are already surfaced via writeLine/finishWriteStream.
		let lateStreamError: Error | undefined;
		stream.on("error", (error: Error) => {
			lateStreamError ??= error;
		});
		let count = 0;
		const header = JSON.stringify({
			name: kb.name,
			description: kb.description,
			source_type: "text",
			chunk_count: kb.chunk_count,
		});
		try {
			await writeLine(stream, header);
			for (const chunk of iterateChunksByKB(this.db, kb.id)) {
				throwIfAborted(signal);
				await writeLine(
					stream,
					JSON.stringify({
						content: chunk.content,
						file_path: chunk.file_path,
						file_type: chunk.file_type,
						start_line: chunk.start_line,
						end_line: chunk.end_line,
						metadata_json: chunk.metadata_json,
					}),
				);
				count++;
				if (count % INDEX_EMBED_BATCH_SIZE === 0) onProgress?.(`Exported ${count}/${kb.chunk_count} chunks...`);
			}
			await finishWriteStream(stream);
			throwIfAborted(signal);
			renameSync(tempOutputPath, outputPath);
			onProgress?.(`Exported ${count}/${kb.chunk_count} chunks.`);
			return count;
		} catch (error) {
			stream.destroy();
			rmSync(tempOutputPath, { force: true });
			throw error;
		}
	}

	async importKB(
		inputPath: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		return this.runExclusive("global:mutation", "Knowledge-base import", () =>
			this.importKBUnlocked(inputPath, onProgress, signal),
		);
	}

	private async importKBUnlocked(
		inputPath: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const { createReadStream } = await import("node:fs");
		const { createInterface } = await import("node:readline");
		const stream = createReadStream(inputPath, { encoding: "utf-8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		const embeddingConfig = resolveEmbeddingConfig();
		let header: ImportHeader | undefined;
		let kb: KnowledgeBase | undefined;
		let vectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		let tempVectorFile: string | undefined;
		let inserted = 0;
		let lineNumber = 0;
		const pendingChunks: ChunkInsert[] = [];
		const pendingSymbols: ReturnType<typeof extractSymbols> = [];

		const flushPending = async (): Promise<void> => {
			if (!this.db || !kb || !vectorWriter || pendingChunks.length === 0) return;
			throwIfAborted(signal);
			const batch = pendingChunks.splice(0, INDEX_EMBED_BATCH_SIZE);
			const symbols = pendingSymbols.splice(0);
			const total = header?.chunk_count;
			const message = `Embedding import batch: ${inserted}/${total ?? "unknown"} chunks stored`;
			updateIndexingJob(this.db, kb.id, {
				phase: "embedding",
				message,
				processed_chunks: inserted,
				total_files: total,
				added_chunks: inserted,
			});
			onProgress?.(message);
			const vectors = await embedDocuments(
				batch.map((chunk) => buildChunkEmbeddingText(chunk)),
				signal,
			);
			throwIfAborted(signal);
			assertEmbeddingBatchSize(vectors, batch.length, "import");
			persistEmbeddingMetadata(this.db, kb.id, embeddingConfig, vectors);
			const insertedIds = insertChunks(this.db, kb.id, batch);
			writeFormulaRowsForInsertedChunks(this.db, kb.id, insertedIds, batch);
			insertSymbols(this.db, kb.id, symbols);
			vectorWriter.append(vectors);
			inserted += batch.length;
			updateKBCounts(this.db, kb.id, inserted, getFileCount(this.db, kb.id));
			updateIndexingJob(this.db, kb.id, {
				phase: "storing",
				message: `Stored import batch: ${inserted}/${total ?? "unknown"} chunks`,
				processed_chunks: inserted,
				total_files: total,
				added_chunks: inserted,
			});
		};

		try {
			for await (const rawLine of lines) {
				throwIfAborted(signal);
				lineNumber++;
				const line = rawLine.trim();
				if (!line) continue;
				if (!header) {
					header = JSON.parse(line) as ImportHeader;
					if (!header.name) throw new Error("Import header is missing a knowledge base name");
					const existingKB = getKBByName(this.db, header.name);
					if (existingKB) {
						throw new Error(
							`Knowledge base "${header.name}" already exists. Use knowledge_update to refresh it, or knowledge_remove before importing a replacement.`,
						);
					}
					kb = createKB(this.db, {
						name: header.name,
						description: header.description,
						source_type: "text",
						embedding_model: embeddingConfigLabel(embeddingConfig),
					});
					updateKBStatus(this.db, kb.id, "indexing");
					startIndexingJob(this.db, kb.id, "import", `Starting import for "${header.name}"`);
					const importMessage = `Importing ${header.chunk_count ?? "unknown"} chunks...`;
					updateIndexingJob(this.db, kb.id, {
						phase: "importing",
						message: importMessage,
						total_files: header.chunk_count,
					});
					onProgress?.(importMessage);
					const vectorPath = this.vectorPathFor(kb.id);
					tempVectorFile = tempVectorPath(vectorPath);
					vectorWriter = openVectorWriter(tempVectorFile);
					continue;
				}
				const imported = JSON.parse(line) as ImportedChunk;
				const chunk = importedChunkToInsert(imported);
				chunk.content_tokenized = preTokenizeForFTS(buildChunkEmbeddingText(chunk));
				pendingChunks.push(chunk);
				pendingSymbols.push(...extractSymbols(imported.content, imported.file_path, imported.file_type));
				if (pendingChunks.length >= INDEX_EMBED_BATCH_SIZE) await flushPending();
			}
			if (!header) throw new Error("Empty import file");
			if (!kb || !vectorWriter || !tempVectorFile) throw new Error("Import did not create a knowledge base");
			await flushPending();
			vectorWriter.close();
			vectorWriter = undefined;
			renameSync(tempVectorFile, this.vectorPathFor(kb.id));
			tempVectorFile = undefined;
			updateKBCounts(this.db, kb.id, inserted, getFileCount(this.db, kb.id));
			updateKBStatus(this.db, kb.id, "ready");
			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after import: ${kb.id}`);
			// Layer 4 (spec §3.5): build the label graph from the fully imported chunk set. Fail-open.
			try {
				rebuildLabelGraphForKB(this.db, kb.id);
				markLabelGraphBuilt(this.db, kb.id);
			} catch {
				// fail-open: retrying is intentionally skipped for this process
			}
			// Formula rows were written per inserted batch; stamp the index built so the first
			// math query skips a redundant full-KB backfill (parity with the add path stamp).
			markFormulaIndexBuilt(this.db, kb.id);
			// A cleanly line-truncated file parses fine but silently imports partial data; the
			// declared chunk_count is the only integrity signal — honor it (the catch rolls the
			// partial KB back).
			if (typeof header.chunk_count === "number" && inserted < header.chunk_count) {
				throw new Error(
					`Import file is incomplete: declared ${header.chunk_count} chunks but only ${inserted} were present`,
				);
			}
			finishIndexingJob(this.db, kb.id, "succeeded", `Ready: imported ${inserted} chunks`);
			return { kb: savedKB, chunkCount: inserted };
		} catch (error) {
			try {
				lines.close();
			} catch {
				// preserve the original error and let the rollback below complete
			}
			stream.destroy();
			try {
				vectorWriter?.close();
			} catch {
				// preserve the original error and let the rollback below complete
			}
			if (tempVectorFile) rmSync(tempVectorFile, { force: true });
			if (this.db && kb) {
				finishIndexingJob(
					this.db,
					kb.id,
					isCancellationError(error) ? "cancelled" : "failed",
					isCancellationError(error) ? "Import cancelled." : `Import failed near line ${lineNumber}.`,
					error instanceof Error ? error.message : String(error),
				);
				deleteKB(this.db, kb.id);
				this.deleteVectorFile(kb.id);
			}
			throw error;
		}
	}

	async dispose(options: { disposeModels?: boolean } = {}): Promise<void> {
		this.disposing = true;
		const activeUpdates = [...this.activeUpdates.values()];
		if (activeUpdates.length > 0) await Promise.allSettled(activeUpdates);
		const activeMutations = [...this.activeMutations.values()];
		if (activeMutations.length > 0) await Promise.allSettled(activeMutations);
		const disposeModels = options.disposeModels ?? true;
		if (disposeModels) {
			await disposeEmbedding();
			await disposeReranker();
			shutdownModelWorker();
		} else {
			await prepareEmbeddingForShutdown();
			await prepareRerankerForShutdown();
		}
		this.db?.close();
		this.db = null;
	}
}
