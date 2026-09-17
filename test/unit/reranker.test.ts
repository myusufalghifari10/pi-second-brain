import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
	rerankViaApi: vi.fn(async () => [{ chunkId: "api-chunk", score: 0.8 }]),
}));
const workerMock = vi.hoisted(() => ({
	rerankInModelWorker: vi.fn(async () => [{ chunkId: "worker-chunk", score: 0.7 }]),
}));

vi.mock("../../src/search/reranker-api.ts", () => apiMock);
vi.mock("../../src/model-worker-client.ts", () => workerMock);

describe("reranker dispatch", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		apiMock.rerankViaApi.mockClear();
		workerMock.rerankInModelWorker.mockClear();
	});

	it("uses the API provider without starting the local model worker", async () => {
		vi.stubEnv("PI_KNOWLEDGE_RERANKER", "api:rerank-v1");
		vi.stubEnv("PI_KNOWLEDGE_RERANKER_API_ENDPOINT", "http://127.0.0.1:8080/v1/rerank");
		const { rerank } = await import("../../src/search/reranker.ts");

		const results = await rerank("query", [{ chunkId: "chunk", content: "doc" }], 1);

		expect(results).toEqual([{ chunkId: "api-chunk", score: 0.8 }]);
		expect(apiMock.rerankViaApi).toHaveBeenCalledOnce();
		expect(workerMock.rerankInModelWorker).not.toHaveBeenCalled();
	});

	it("keeps the local worker path as the default", async () => {
		const { rerank } = await import("../../src/search/reranker.ts");

		const results = await rerank("query", [{ chunkId: "chunk", content: "doc" }], 1);

		expect(results).toEqual([{ chunkId: "worker-chunk", score: 0.7 }]);
		expect(workerMock.rerankInModelWorker).toHaveBeenCalledOnce();
		expect(apiMock.rerankViaApi).not.toHaveBeenCalled();
	});
});
