import { describe, expect, it } from "vitest";
import { preTokenizeForFTS } from "../../src/indexer/chunker.ts";
import { canonicalizeMathText, MATH_UNICODE_MAP } from "../../src/indexer/math-text.ts";
import {
	rewriteUnitTokens,
	rewriteUnitWordVariants,
	UNIT_TOKENS,
	UNIT_WORD_VARIANTS,
} from "../../src/indexer/units.ts";
import { tokenizeForSearch } from "../../src/search/query.ts";

// Spec §3.2 surface forms paired with their token-space form (preTokenizeForFTS output).
// Every token of every surface form must be a UNIT_TOKEN so any cdot written between two
// surface forms rewrites symmetrically.
const SURFACE_FORMS: ReadonlyArray<readonly [string, string]> = [
	["N", "N"],
	["m", "m"],
	["kg", "kg"],
	["s", "s"],
	["A", "A"],
	["K", "K"],
	["mol", "mol"],
	["cd", "cd"],
	["Hz", "Hz"],
	["J", "J"],
	["W", "W"],
	["V", "V"],
	["C", "C"],
	["\u03A9", "omega"],
	["S", "S"],
	["F", "F"],
	["T", "T"],
	["H", "H"],
	["Pa", "Pa"],
	["bar", "bar"],
	["eV", "e V"],
	["L", "L"],
	["kN", "k N"],
	["MPa", "M Pa"],
	["GPa", "G Pa"],
	["kPa", "k Pa"],
	["kW", "k W"],
	["MJ", "MJ"],
	["kWh", "k Wh"],
	["mm", "mm"],
	["cm", "cm"],
	["km", "km"],
	["mg", "mg"],
	["\u00B5g", "mu g"],
];

describe("UNIT_TOKENS", () => {
	it("is frozen at 34 token-space entries", () => expect(UNIT_TOKENS.size).toBe(34));
	it("every §3.2 surface form tokenizes to a UNIT_TOKENS-covered token form (paired vectors)", () => {
		for (const [surface, tokenForm] of SURFACE_FORMS) {
			expect(preTokenizeForFTS(surface), surface).toBe(tokenForm);
			for (const token of tokenForm.split(" ")) {
				expect(UNIT_TOKENS.has(token), `${surface} → ${token}`).toBe(true);
			}
		}
	});
	it("Nm single alnum run is not a unit token (documented asymmetric, L1 invariant)", () =>
		expect(UNIT_TOKENS.has("Nm")).toBe(false));
});

describe("rewriteUnitTokens", () => {
	it("rewrites cdot between two unit tokens", () => {
		expect(rewriteUnitTokens("N cdot m")).toBe("N m");
		expect(rewriteUnitTokens("Pa cdot s")).toBe("Pa s");
		expect(rewriteUnitTokens("km cdot h")).toBe("km h");
		expect(rewriteUnitTokens("omega cdot m")).toBe("omega m");
	});
	it("rewrites the tokenized kW·h form (k W cdot h)", () => expect(rewriteUnitTokens("k W cdot h")).toBe("k W h"));
	it("collapses chains iteratively left-to-right (N cdot m cdot s)", () =>
		expect(rewriteUnitTokens("N cdot m cdot s")).toBe("N m s"));
	it("rewrites prefixed token forms (M Pa cdot s, e V cdot m, mu cdot g)", () => {
		expect(rewriteUnitTokens("M Pa cdot s")).toBe("M Pa s");
		expect(rewriteUnitTokens("e V cdot m")).toBe("e V m");
		expect(rewriteUnitTokens("mu cdot g")).toBe("mu g");
	});
	it("leaves non-unit pairs untouched (a cdot b)", () => expect(rewriteUnitTokens("a cdot b")).toBe("a cdot b"));
	it("leaves 5 cdot kg untouched — 5 is not a unit token (spec negative vector)", () =>
		expect(rewriteUnitTokens("5 cdot kg")).toBe("5 cdot kg"));
	it("leaves N cdot 5 and a cdot N cdot m partially rewritten per the two-unit rule", () => {
		expect(rewriteUnitTokens("N cdot 5")).toBe("N cdot 5");
		expect(rewriteUnitTokens("a cdot N cdot m")).toBe("a cdot N m");
	});
	it("leaves slash compounds untouched (m/s is one composite token, not a unit token)", () =>
		expect(rewriteUnitTokens("N cdot m/s")).toBe("N cdot m/s"));
	it("returns cdot-free input unchanged", () => {
		const input = "plain prose tokens only";
		expect(rewriteUnitTokens(input)).toBe(input);
	});
	it("Nm stays Nm (locked negative — alnum runs are never split)", () => expect(rewriteUnitTokens("Nm")).toBe("Nm"));
});

describe("preTokenizeForFTS unit symmetry (S2: index ≡ query)", () => {
	it("N·m ≡ N m ≡ N m", () => {
		expect(preTokenizeForFTS("N·m")).toBe("N m");
		expect(preTokenizeForFTS("N m")).toBe("N m");
	});
	it("rewrites every unit-pair form symmetrically", () => {
		const pairs: ReadonlyArray<readonly [string, string]> = [
			["kW·h", "kW h"],
			["Pa·s", "Pa s"],
			["N·m·s", "N m s"],
			["kN·m", "kN m"],
			["MPa·s", "MPa s"],
			["eV·m", "eV m"],
			["km·h", "km h"],
			["\u03A9·m", "\u03A9 m"],
			["\u00B5·g", "\u00B5g"],
			["mm·s", "mm s"],
		];
		for (const [dotted, spaced] of pairs) {
			expect(preTokenizeForFTS(dotted), dotted).toBe(preTokenizeForFTS(spaced));
		}
	});
	it("kW·h and kWh share the kW h token stream", () => {
		expect(preTokenizeForFTS("kW·h")).toBe("k W h");
		expect(preTokenizeForFTS("kWh")).toBe("k Wh");
	});
	it("Nm stays one unsplit token (locked negative)", () => expect(preTokenizeForFTS("Nm")).toBe("Nm"));
	it("non-unit content stays byte-identical (S6)", () => {
		expect(preTokenizeForFTS("The quick brown fox")).toBe("The quick brown fox");
		expect(preTokenizeForFTS("a·b")).toBe("a cdot b");
		expect(preTokenizeForFTS("5·kg")).toBe("5 cdot kg");
		expect(preTokenizeForFTS("μ·t momentum")).toBe("mu cdot t momentum");
	});
});

describe("unit glyph folds (§3.2 paired vectors)", () => {
	it("µ U+00B5 folds to mu, same token as Greek μ U+03BC", () => {
		expect(MATH_UNICODE_MAP["\u00B5"]).toBe("mu");
		expect(canonicalizeMathText("\u00B5")).toBe("mu");
		expect(preTokenizeForFTS("\u00B5g")).toBe(preTokenizeForFTS("\u03BCg"));
		expect(preTokenizeForFTS("\u00B5g")).toBe("mu g");
	});
	it("omega folds BOTH codepoints U+03A9 and U+2126 to the same token (locked)", () => {
		expect(MATH_UNICODE_MAP["\u03A9"]).toBe("omega");
		expect(MATH_UNICODE_MAP["\u2126"]).toBe("omega");
		expect(canonicalizeMathText("\u03A9")).toBe(canonicalizeMathText("\u2126"));
		expect(canonicalizeMathText("\u2126")).toBe("omega");
		expect(preTokenizeForFTS("\u2126·m")).toBe(preTokenizeForFTS("\u03A9 m"));
	});
	it("Å angstrom sign U+212B folds to angstrom; Latin Å U+00C5 deliberately stays unmapped", () => {
		expect(MATH_UNICODE_MAP["\u212B"]).toBe("angstrom");
		expect(canonicalizeMathText("\u212B")).toBe("angstrom");
		expect(preTokenizeForFTS("1 \u212B spacing")).toBe("1 angstrom spacing");
		expect(MATH_UNICODE_MAP["\u00C5"]).toBeUndefined();
	});
	it("° degree sign U+00B0 folds to degree (pre-existing anchor)", () => {
		expect(MATH_UNICODE_MAP["\u00B0"]).toBe("degree");
		expect(preTokenizeForFTS("45\u00B0 angle")).toBe("45 degree angle");
	});
});

describe("unit word-variant canonicalization (D3: spelled-out ≡ symbol)", () => {
	it("rewrites every bounded word form at BOTH index and query time (symmetric)", () => {
		for (const [word, symbol] of UNIT_WORD_VARIANTS) {
			expect(preTokenizeForFTS(`3 ${word}`), word).toBe(`3 ${symbol}`);
			expect(tokenizeForSearch(`3 ${word}`), word).toEqual(tokenizeForSearch(`3 ${symbol}`));
		}
	});

	it("km and kilometers (and British kilometres) converge on one token stream (D3 probe vector)", () => {
		expect(preTokenizeForFTS("5 km")).toBe("5 km");
		expect(preTokenizeForFTS("3 kilometers")).toBe("3 km");
		expect(preTokenizeForFTS("3 kilometre")).toBe("3 km");
		expect(tokenizeForSearch("kilometers")).toEqual(tokenizeForSearch("km"));
	});

	it("is case-insensitive so mixed-case prose stays symmetric (Kilometers ≡ km)", () => {
		expect(preTokenizeForFTS("5 Kilometers")).toBe("5 km");
		expect(preTokenizeForFTS("30 SECONDS")).toBe("30 s");
		expect(tokenizeForSearch("Kilometers")).toEqual(tokenizeForSearch("km"));
	});

	it("word boundaries keep prose intact (kilometerstone never rewrites)", () => {
		expect(preTokenizeForFTS("kilometerstone")).toBe("kilometerstone");
		expect(preTokenizeForFTS("Meganometers")).toBe("Meganometers");
		expect(preTokenizeForFTS("The quick brown fox")).toBe("The quick brown fox");
	});

	it("spelled forms feed the cdot rule symmetrically (second·meter ≡ s·m ≡ s m)", () => {
		expect(preTokenizeForFTS("second·meter")).toBe("s m");
		expect(preTokenizeForFTS("s·m")).toBe("s m");
	});

	it("query side rewrites before filtering (spelled ≡ symbol token sets; single-char targets stay dropped)", () => {
		expect(tokenizeForSearch("kilometers")).toEqual(new Set(["km"]));
		expect(tokenizeForSearch("milliseconds")).toEqual(tokenizeForSearch("ms"));
		expect(tokenizeForSearch("minutes")).toEqual(tokenizeForSearch("min"));
		// Single-char rewrite targets (hours → h) hit the pre-existing length-1 noise filter:
		// letter/digit splits shard symbol runs (H2SO4 → h 2 so 4), so bare single-char terms
		// stay excluded from FTS queries by design; both spelled and symbol queries degrade
		// identically (empty), keeping the sides symmetric.
		expect(tokenizeForSearch("3 hours")).toEqual(tokenizeForSearch("3 h"));
	});

	it("rewriteUnitWordVariants returns input unchanged (same reference) when no word variant occurs", () => {
		const input = "plain prose tokens only";
		expect(rewriteUnitWordVariants(input)).toBe(input);
	});
});
