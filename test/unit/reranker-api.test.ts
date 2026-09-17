import { beforeEach, describe, expect, it, vi } from "vitest";
import { rerankViaApi } from "../../src/search/reranker-api.ts";
import type { ApiRerankerConfig } from "../../src/search/reranker-config.ts";

const baseConfig: ApiRerankerConfig = {
	provider: "api",
	model: "rerank-v1",
	endpoint: "http://127.0.0.1:8080/v1/rerank",
	apiKey: "test-key",
	format: "cohere",
	timeoutMs: 30_000,
	maxDocumentChars: 16,
	resultsPath: "results",
	indexField: "index",
	scoreField: "relevance_score",
	scoreDirection: "desc",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });
}

describe("API reranker", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("sends Cohere/Jina-compatible rerank requests and maps result indexes back to chunk ids", async () => {
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse({
				results: [
					{ index: 1, relevance_score: 0.98 },
					{ index: 0, relevance_score: 0.12 },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const results = await rerankViaApi(
			"query",
			[
				{ chunkId: "chunk-a", content: "first document content" },
				{ chunkId: "chunk-b", content: "second document content" },
			],
			1,
			baseConfig,
		);

		expect(results).toEqual([{ chunkId: "chunk-b", score: 0.98 }]);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:8080/v1/rerank");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({ "Content-Type": "application/json", Authorization: "Bearer test-key" });
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "rerank-v1",
			query: "query",
			documents: ["first document c", "second document "],
			top_n: 1,
			return_documents: false,
		});
	});

	it("sends TEI rerank requests and maps root array scores", async () => {
		const fetchMock = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
			jsonResponse([
				{ index: 0, score: 0.12 },
				{ index: 1, score: 0.98 },
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		const results = await rerankViaApi(
			"query",
			[
				{ chunkId: "chunk-a", content: "first document content" },
				{ chunkId: "chunk-b", content: "second document content" },
			],
			1,
			{
				...baseConfig,
				apiKey: undefined,
				format: "tei",
				resultsPath: "",
				scoreField: "score",
			},
		);

		expect(results).toEqual([{ chunkId: "chunk-b", score: 0.98 }]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:8080/v1/rerank");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(String(init?.body))).toEqual({
			query: "query",
			texts: ["first document c", "second document "],
		});
	});

	it("supports custom JSON result paths and ascending scores", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					data: {
						rankings: [
							{ document_index: 0, score: 0.2 },
							{ document_index: 1, score: 0.1 },
						],
					},
				}),
			),
		);

		const results = await rerankViaApi(
			"query",
			[
				{ chunkId: "chunk-a", content: "alpha" },
				{ chunkId: "chunk-b", content: "beta" },
			],
			2,
			{
				...baseConfig,
				format: "custom-json",
				resultsPath: "data.rankings",
				indexField: "document_index",
				scoreField: "score",
				scoreDirection: "asc",
			},
		);

		expect(results).toEqual([
			{ chunkId: "chunk-b", score: 0.1 },
			{ chunkId: "chunk-a", score: 0.2 },
		]);
	});

	it("surfaces HTTP failures without falling back to the local worker", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("bad key", { status: 401 })),
		);

		await expect(rerankViaApi("query", [{ chunkId: "chunk", content: "doc" }], 1, baseConfig)).rejects.toThrow(
			"Reranker API error: 401 bad key",
		);
	});

	it("normalizes aborts to Cancelled", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("The operation was aborted.", "AbortError");
			}),
		);

		await expect(rerankViaApi("query", [{ chunkId: "chunk", content: "doc" }], 1, baseConfig)).rejects.toThrow(
			"Cancelled",
		);
	});

	it("rejects malformed result indexes", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ results: [{ index: 3, relevance_score: 0.9 }] })),
		);

		await expect(rerankViaApi("query", [{ chunkId: "chunk", content: "doc" }], 1, baseConfig)).rejects.toThrow(
			"Invalid reranker API response: result index is out of range",
		);
	});
});
