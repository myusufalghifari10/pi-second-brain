import type { RerankCandidate } from "./reranker.ts";
import type { ApiRerankerConfig } from "./reranker-config.ts";

export interface ApiRerankResult {
	chunkId: string;
	score: number;
}

function valueAtPath(value: unknown, path: string): unknown {
	let current = value;
	for (const segment of path.split(".")) {
		if (segment.length === 0) continue;
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function createAbortSignal(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(signal?.reason);
	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`Reranker API timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromParent);
		},
	};
}

function mapApiResult(result: unknown, candidates: RerankCandidate[], config: ApiRerankerConfig): ApiRerankResult {
	const index = valueAtPath(result, config.indexField);
	const score = valueAtPath(result, config.scoreField);
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= candidates.length) {
		throw new Error("Invalid reranker API response: result index is out of range");
	}
	if (typeof score !== "number" || !Number.isFinite(score)) {
		throw new Error("Invalid reranker API response: result score is not a number");
	}
	return { chunkId: candidates[index].chunkId, score };
}

function requestBody(query: string, candidates: RerankCandidate[], topK: number, config: ApiRerankerConfig): string {
	const texts = candidates.map((candidate) =>
		candidate.content.length > config.maxDocumentChars
			? candidate.content.slice(0, config.maxDocumentChars)
			: candidate.content,
	);
	if (config.format === "tei") return JSON.stringify({ query, texts });
	const documents =
		config.format === "custom-json" ? texts.map((text, index) => ({ id: candidates[index].chunkId, text })) : texts;
	return JSON.stringify({
		model: config.model,
		query,
		documents,
		top_n: topK,
		return_documents: false,
	});
}

export async function rerankViaApi(
	query: string,
	candidates: RerankCandidate[],
	topK: number,
	config: ApiRerankerConfig,
	signal?: AbortSignal,
): Promise<ApiRerankResult[]> {
	const abort = createAbortSignal(config.timeoutMs, signal);
	try {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
		const response = await fetch(config.endpoint, {
			method: "POST",
			headers,
			body: requestBody(query, candidates, topK, config),
			signal: abort.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`Reranker API error: ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`);
		}
		const data = (await response.json()) as unknown;
		const results = valueAtPath(data, config.resultsPath);
		if (!Array.isArray(results)) throw new Error("Invalid reranker API response: results field is not an array");
		const ranked = results.map((result) => mapApiResult(result, candidates, config));
		if (config.scoreDirection === "asc") ranked.sort((a, b) => a.score - b.score);
		else ranked.sort((a, b) => b.score - a.score);
		return ranked.slice(0, topK);
	} catch (error) {
		if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new Error("Cancelled");
		throw error;
	} finally {
		abort.cleanup();
	}
}
