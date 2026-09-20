import { describe, expect, it, vi } from "vitest";
import { rerankWithSingleRawLogit, scorePairLogits, scoreSingleRawLogit } from "../../src/search/reranker-logits.ts";

describe("raw-logit reranker scoring", () => {
	it("returns the only logit as the rerank score", () => {
		expect(scoreSingleRawLogit({ data: Float32Array.from([7.25]) }, "Xenova/bge-reranker-base")).toBeCloseTo(7.25);
	});

	it("rejects multi-logit classifiers instead of guessing a score label", () => {
		expect(() => scoreSingleRawLogit({ data: Float32Array.from([-3, 4]) }, "example/two-label-reranker")).toThrow(
			"Raw-logit reranker expected a single-logit sequence classifier for example/two-label-reranker, got 2 logits",
		);
	});

	it("rejects non-finite scores", () => {
		expect(() => scoreSingleRawLogit({ data: [Number.NaN] }, "example/reranker")).toThrow(
			"Raw-logit reranker returned a non-finite score for example/reranker",
		);
	});

	it("tokenizes query/document pairs before returning the raw model score", async () => {
		const tokenizer = vi.fn(() => ({ input_ids: [1, 2, 3], attention_mask: [1, 1, 1] }));
		const model = vi.fn(async () => ({ logits: { data: Float32Array.from([9.5]) } }));

		await expect(
			rerankWithSingleRawLogit({ text: "query", text_pair: "document" }, tokenizer, model, "Xenova/bge-reranker-base"),
		).resolves.toEqual([{ score: 9.5 }]);
		expect(tokenizer).toHaveBeenCalledWith("query", {
			text_pair: "document",
			padding: true,
			truncation: true,
		});
		expect(model).toHaveBeenCalledWith({ input_ids: [1, 2, 3], attention_mask: [1, 1, 1] });
	});
});

describe("pair scoring for the default reranker path", () => {
	it("maps a single relevance logit through sigmoid (cross-encoder convention)", () => {
		expect(scorePairLogits({ data: Float32Array.from([0]) }, "Xenova/ms-marco-MiniLM-L-4-v2")).toBe(0.5);
		expect(scorePairLogits({ data: Float32Array.from([2]) }, "Xenova/ms-marco-MiniLM-L-4-v2")).toBeCloseTo(0.8808, 4);
		expect(scorePairLogits({ data: Float32Array.from([-3]) }, "Xenova/ms-marco-MiniLM-L-4-v2")).toBeLessThan(0.05);
	});

	it("falls back to softmax-max for genuine multi-class classifiers (pipeline semantics)", () => {
		// softmax([1,3]): exps = [e^-2, 1], max prob = 1/(1+e^-2)
		expect(scorePairLogits({ data: Float32Array.from([1, 3]) }, "example/two-label")).toBeCloseTo(0.8808, 4);
	});

	it("rejects non-finite pair logits", () => {
		expect(() => scorePairLogits({ data: [Number.POSITIVE_INFINITY] }, "example/reranker")).toThrow(/non-finite/);
	});

	it("scores with a custom scorer through the shared pair machinery (default-path regression)", async () => {
		// The DEFAULT HF path (PI_KNOWLEDGE_RERANKER_RAW_LOGITS unset) must still tokenize real
		// query/pair inputs — the pre-fix text-classification pipeline fed `{text, text_pair}` as
		// one "text" and produced constant scores.
		const tokenizer = vi.fn(() => ({ input_ids: [4, 5] }));
		const model = vi.fn(async () => ({ logits: { data: Float32Array.from([1]) } }));

		await expect(
			rerankWithSingleRawLogit(
				{ text: "q", text_pair: "doc" },
				tokenizer,
				model,
				"Xenova/ms-marco-MiniLM-L-4-v2",
				scorePairLogits,
			),
		).resolves.toEqual([{ score: 1 / (1 + Math.exp(-1)) }]);
		expect(tokenizer).toHaveBeenCalledWith("q", { text_pair: "doc", padding: true, truncation: true });
	});
});
