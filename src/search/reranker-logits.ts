export type RawLogitRerankInput = {
	text: string;
	text_pair: string;
};

export type RawLogitTokenizer = (
	text: string,
	options: { text_pair: string; padding: true; truncation: true },
) => Record<string, unknown>;

export type RawLogitModel = (inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>;

export function scoreSingleRawLogit(logits: { data: ArrayLike<number> }, model: string): number {
	const scores = Array.from(logits.data);
	if (scores.length !== 1) {
		throw new Error(
			`Raw-logit reranker expected a single-logit sequence classifier for ${model}, got ${scores.length} logits. ` +
				"Use a single-logit reranker model or disable PI_KNOWLEDGE_RERANKER_RAW_LOGITS.",
		);
	}
	const score = scores[0];
	if (!Number.isFinite(score)) throw new Error(`Raw-logit reranker returned a non-finite score for ${model}`);
	return score;
}

/**
 * Pipeline-equivalent scoring for pair inputs. Cross-encoder rerankers (ms-marco family) emit a
 * single relevance logit → sigmoid maps it to (0,1). Genuine multi-class classifiers fall back
 * to softmax-max, mirroring the text-classification pipeline's top-1 output.
 */
export function scorePairLogits(logits: { data: ArrayLike<number> }, model: string): number {
	const scores = Array.from(logits.data);
	if (!scores.every((value) => Number.isFinite(value))) {
		throw new Error(`Reranker returned a non-finite score for ${model}`);
	}
	if (scores.length === 1) return 1 / (1 + Math.exp(-scores[0]));
	const max = Math.max(...scores);
	const exps = scores.map((value) => Math.exp(value - max));
	const sum = exps.reduce((total, value) => total + value, 0);
	return Math.max(...exps.map((value) => value / sum));
}

export async function rerankWithSingleRawLogit(
	input: RawLogitRerankInput,
	tokenizer: RawLogitTokenizer,
	model: RawLogitModel,
	modelName: string,
	scoreLogits: (logits: { data: ArrayLike<number> }, model: string) => number = scoreSingleRawLogit,
): Promise<Array<{ score: number }>> {
	const inputs = tokenizer(input.text, { text_pair: input.text_pair, padding: true, truncation: true });
	const { logits } = await model(inputs);
	return [{ score: scoreLogits(logits, modelName) }];
}
