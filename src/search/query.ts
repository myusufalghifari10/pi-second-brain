import { preTokenizeForFTS } from "../indexer/chunker.ts";

export const STOP_WORDS = new Set([
	"the",
	"and",
	"or",
	"to",
	"of",
	"in",
	"on",
	"for",
	"with",
	"how",
	"does",
	"what",
	"when",
	"where",
	"why",
	"this",
	"that",
	"from",
]);

const TYPO_CORRECTIONS: Record<string, string> = {
	ho: "how",
	setpup: "setup",
	setpu: "setup",
	seting: "setting",
	configuraiton: "configuration",
	permisson: "permission",
	permisions: "permissions",
};

export function stemToken(token: string): string {
	if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
	if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
	if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
	return token;
}

// Placeholder guarding decimal digits through the punctuation strip below. It must be a
// character that can never appear in real text (a control char), so the mask is lossless.
const DECIMAL_PLACEHOLDER = "\u0001";

export function tokenizeForSearch(text: string): Set<string> {
	const normalized = preTokenizeForFTS(text)
		.toLowerCase()
		// Numeric symmetry with the index side: preTokenizeForFTS keeps "11.94" whole, so the
		// query must not shred it at the dot either. Mask digit.dot.digit before the character
		// class replace, then restore (same pattern the FTS tokenizer sees on both sides).
		.replace(/(\d)\.(\d)/g, `$1${DECIMAL_PLACEHOLDER}$2`)
		.replace(/[-_*"(){}[\]^~:+.#@!\\/<>|&$%?]/g, " ")
		.replace(new RegExp(DECIMAL_PLACEHOLDER, "g"), ".");
	const tokens = normalized
		.split(/\s+/)
		.map((token) => TYPO_CORRECTIONS[token] ?? token)
		// Pure-digit tokens are high-signal AND indexed on the FTS side (unicode61 keeps
		// single digits, e.g. "shell-2" -> [shell, 2]), so the length filter must not drop
		// them on the query side.
		.filter((token) => token.length > 1 || /\d/.test(token) || /[\u3400-\u4dbf\u4e00-\u9fff]/.test(token));
	return new Set(tokens);
}

export function signalTokens(tokens: Set<string>): Set<string> {
	return new Set([...tokens].filter((token) => !STOP_WORDS.has(token)).map(stemToken));
}

export function normalizedQueryText(query: string): string {
	return [...tokenizeForSearch(query)].join(" ");
}
