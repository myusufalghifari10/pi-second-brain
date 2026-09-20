import { describe, expect, it } from "vitest";
import {
	chemNormalize,
	isMolecularFormula,
	MOLECULAR_RE,
	rewriteFormulaTokens,
} from "../../src/indexer/chem-normalize.ts";
import { preTokenizeForFTS } from "../../src/indexer/chunker.ts";
import { extractQueryFormulas, normalizeFormula } from "../../src/indexer/formula-normalize.ts";
import { MAX_FORMULA_CHARS } from "../../src/indexer/math-text.ts";
import { tokenizeForSearch } from "../../src/search/query.ts";

describe("chemNormalize — F1 vectors (L4 spec §3.1)", () => {
	it("H2SO4 ≡ H₂SO₄ ≡ \\ce{H2SO4} ≡ \\ce{H2SO4(aq)} → H2 S O4", () => {
		const expected = "H2 S O4";
		expect(normalizeFormula("H2SO4")?.normalized).toBe(expected);
		expect(normalizeFormula("H₂SO₄")?.normalized).toBe(expected);
		expect(normalizeFormula("\\ce{H2SO4}")?.normalized).toBe(expected);
		expect(normalizeFormula("\\ce{H2SO4(aq)}")?.normalized).toBe(expected);
	});

	it("\\ce{SO4^2-} ≡ \\ce{SO4^{2-}} ≡ SO4^{2-} → S O4 ^ 2- (charge forms unify)", () => {
		const expected = "S O4 ^ 2-";
		expect(normalizeFormula("\\ce{SO4^2-}")?.normalized).toBe(expected);
		expect(normalizeFormula("\\ce{SO4^{2-}}")?.normalized).toBe(expected);
		expect(normalizeFormula("SO4^{2-}")?.normalized).toBe(expected);
	});

	it("unicode charge form folds to the ASCII digit+sign run (documented fold behavior)", () => {
		// §3.1.2 step 2 folds ₄²⁻ → 42- directly from the raw string; the trailing digit+sign
		// run then unifies as one charge magnitude (step 3: "2+ ≡ ^2+"). Deterministic and
		// identical on index and query side; caret notation (\ce{SO4^2-}) remains the
		// canonical charged-species spelling.
		expect(normalizeFormula("SO₄²⁻")?.normalized).toBe("S O ^ 42-");
		expect(normalizeFormula("SO₄²⁻")?.normalized).toBe(normalizeFormula("SO42-")?.normalized);
	});

	it("Co ≠ CO (case-sensitive chemistry)", () => {
		expect(normalizeFormula("Co")?.normalized).toBe("Co"); // single element token → generic path
		expect(normalizeFormula("CO")?.normalized).toBe("C O"); // C + O → chem path
		expect(normalizeFormula("\\ce{Co}")?.normalized).toBe("Co"); // \ce keeps element casing
		expect(normalizeFormula("Co")?.normalized).not.toBe(normalizeFormula("CO")?.normalized);
	});

	it("\\ce{Ca(OH)2} ≡ Ca(OH)2 → Ca O2 H2 (paren multiplier distributed)", () => {
		expect(normalizeFormula("\\ce{Ca(OH)2}")?.normalized).toBe("Ca O2 H2");
		expect(normalizeFormula("Ca(OH)2")?.normalized).toBe("Ca O2 H2");
	});

	it("(NH4)2SO4 → N2 H8 S O4", () => {
		expect(normalizeFormula("(NH4)2SO4")?.normalized).toBe("N2 H8 S O4");
	});

	it("nested groups compose multiplicatively: K4(Fe(CN)6)3 → K4 Fe3 C18 N18", () => {
		expect(normalizeFormula("K4(Fe(CN)6)3")?.normalized).toBe("K4 Fe3 C18 N18");
	});

	it("mismatched parens never throw: unterminated group flattens with multiplier 1", () => {
		expect(normalizeFormula("\\ce{Ca(OH}")?.normalized).toBe("Ca O H");
	});

	it("H_2SO_4 underscore subscript form ≡ H2SO4", () => {
		expect(normalizeFormula("H_2SO_4")?.normalized).toBe("H2 S O4");
	});

	it("arrows unify across notations (->, →, \\rightarrow)", () => {
		const expected = "2 H2 + O2 -> 2 H2 O";
		expect(normalizeFormula("\\ce{2H2 + O2 -> 2H2O}")?.normalized).toBe(expected);
		expect(normalizeFormula("\\ce{2H2 + O2 → 2H2O}")?.normalized).toBe(expected);
		expect(normalizeFormula("\\ce{2H2 + O2 \\rightarrow 2H2O}")?.normalized).toBe(expected);
	});

	it("charge notations unify to trailing ^n± inside \\ce{}", () => {
		expect(normalizeFormula("\\ce{Na+}")?.normalized).toBe("Na ^ +");
		expect(normalizeFormula("\\ce{Ca2+}")?.normalized).toBe("Ca ^ 2+");
		expect(normalizeFormula("\\ce{Fe+3}")?.normalized).toBe("Fe ^ 3+");
		expect(normalizeFormula("\\ce{Fe^{3+}}")?.normalized).toBe("Fe ^ 3+");
	});

	it("hydrate dots: CuSO4·5H2O ≡ CuSO4*5H2O → Cu S O4 . 5 H2 O", () => {
		expect(normalizeFormula("CuSO4·5H2O")?.normalized).toBe("Cu S O4 . 5 H2 O");
		expect(normalizeFormula("CuSO4*5H2O")?.normalized).toBe("Cu S O4 . 5 H2 O");
	});

	it("states are stripped: H2O(l) ≡ H2O(g) ≡ \\ce{H2O(s)} → H2 O", () => {
		expect(normalizeFormula("H2O(l)")?.normalized).toBe("H2 O");
		expect(normalizeFormula("H2O(g)")?.normalized).toBe("H2 O");
		expect(normalizeFormula("\\ce{H2O(s)}")?.normalized).toBe("H2 O");
	});

	it("display-math fencing does not hide chemistry (S1: plain ≡ \\ce index rows)", () => {
		expect(normalizeFormula("$$\nH2SO4\n$$")?.normalized).toBe("H2 S O4");
		expect(normalizeFormula("$H2SO4$")?.normalized).toBe("H2 S O4");
		expect(normalizeFormula("\\[Ca(OH)2\\]")?.normalized).toBe("Ca O2 H2");
	});

	it("same contract as the generic path: raw is trimmed, tokens/tokenCount consistent", () => {
		const result = normalizeFormula("  \\ce{H2SO4}  ");
		expect(result?.raw).toBe("\\ce{H2SO4}");
		expect(result?.tokens).toEqual(["H2", "S", "O4"]);
		expect(result?.tokenCount).toBe(3);
	});

	it("rejects: empty \\ce{}, charge-only, arrow-only → undefined", () => {
		expect(normalizeFormula("\\ce{}")).toBeUndefined();
		expect(normalizeFormula("\\ce{+}")).toBeUndefined();
		expect(normalizeFormula("\\ce{->}")).toBeUndefined();
		expect(chemNormalize("")).toBeUndefined();
	});

	it("rejects: oversized input → undefined (shared MAX_FORMULA_CHARS guard)", () => {
		expect(MAX_FORMULA_CHARS).toBe(2000);
		expect(normalizeFormula(`\\ce{${"H".repeat(MAX_FORMULA_CHARS)}}`)).toBeUndefined();
		expect(chemNormalize("H2O".repeat(MAX_FORMULA_CHARS))).toBeUndefined();
	});
});

describe("chem routing keeps the L3 generic path byte-identical for non-chemistry", () => {
	it("e^{i\\pi} is NOT chemistry (TeX command → generic path)", () => {
		expect(isMolecularFormula("e^{i\\pi}")).toBe(false);
		expect(normalizeFormula("e^{i\\pi}")?.normalized).toBe("e ^ i pi");
	});

	it("x^2 is NOT chemistry (x is not an element symbol)", () => {
		expect(isMolecularFormula("x^2")).toBe(false);
		expect(normalizeFormula("x^2")?.normalized).toBe("x ^ 2");
	});

	it("prose words never route chem: No / At / In are single element tokens", () => {
		expect(isMolecularFormula("No")).toBe(false);
		expect(isMolecularFormula("At")).toBe(false);
		expect(isMolecularFormula("In")).toBe(false);
	});

	it("plain single-element charges stay generic (§3.1.1 ≥ 2 element tokens guard)", () => {
		expect(normalizeFormula("Fe^{3+}")?.normalized).toBe("Fe ^ 3 +");
		expect(normalizeFormula("Na+")?.normalized).toBe("Na +");
		expect(normalizeFormula("Ca2+")?.normalized).toBe("Ca2 +");
	});

	it("MOLECULAR_RE accepts NO (N+O) and rejects bare digits / single-element species / math", () => {
		expect(isMolecularFormula("NO")).toBe(true);
		expect(isMolecularFormula("H2")).toBe(false); // single element token
		expect(isMolecularFormula("123")).toBe(false);
		expect(MOLECULAR_RE.test("Ca(OH)2")).toBe(true);
		expect(MOLECULAR_RE.test("(NH4)2SO4")).toBe(true);
		expect(MOLECULAR_RE.test("K4(Fe(CN)6)3")).toBe(true);
		expect(MOLECULAR_RE.test("CuSO4·5H2O")).toBe(true);
		expect(MOLECULAR_RE.test("SO4^{2-}")).toBe(true);
		expect(MOLECULAR_RE.test("H2O(l)")).toBe(true);
		expect(MOLECULAR_RE.test("E=mc^2")).toBe(false);
		expect(MOLECULAR_RE.test("H2O and CO2")).toBe(false); // whitespace inside a species
	});
});

describe("extractQueryFormulas — F2 chem query routing", () => {
	it("plain query H2SO4 → one chem formula", () => {
		const result = extractQueryFormulas("H2SO4");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("H2 S O4");
		expect(result.cleanedQuery).toBe("H2SO4"); // text leg never starves
	});

	it("\\ce{H2SO4} query → chem formula via the bare-TeX rule", () => {
		const result = extractQueryFormulas("\\ce{H2SO4}");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("H2 S O4");
	});

	it("unicode H₂SO₄ query routes to the same chem formula", () => {
		const result = extractQueryFormulas("H₂SO₄");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("H2 S O4");
	});

	it("prose around a formula is NOT extracted (no internal whitespace in a species)", () => {
		const result = extractQueryFormulas("what is H2SO4 used for");
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe("what is H2SO4 used for");
	});

	it("ReDoS guard: a 64-digit run input is rejected fast instead of backtracking exponentially", () => {
		const start = Date.now();
		const result = isMolecularFormula(`H${"2".repeat(64)}z`);
		expect(result).toBe(false);
		// Loose bound: the fix makes this single-digit-ms; the loose assertion avoids CI flakiness.
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("ReDoS guard: a moderate 20-digit run stays linear (lookbehind kill-test)", () => {
		// 20 digits bypasses the 25-digit pre-guard, so this input reaches MOLECULAR_RE: with the
		// lookbehind partition removed, the digit alternation backtracks exponentially and this
		// test hangs past the wall-clock bound instead of failing fast.
		const start = Date.now();
		expect(isMolecularFormula(`H${"2".repeat(20)}z`)).toBe(false);
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("25+ digit-run guard fires before MOLECULAR_RE (dead-guard regression)", () => {
		// Direct guard-level proof: MOLECULAR_RE alone would ACCEPT CO·<30 digits> (hydrate-dot
		// digit run is a valid CORE_ATOM), so only the digit-run guard can reject it.
		expect(isMolecularFormula(`CO·${"1".repeat(30)}`)).toBe(false);
		const start = Date.now();
		expect(isMolecularFormula(`·${"1".repeat(30)}x`)).toBe(false);
		// Boolean is the real assertion; the loose wall bound only catches exponential blowups.
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("single-element plain text stays prose (Co queries are not chem formulas)", () => {
		const result = extractQueryFormulas("Co");
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe("Co");
	});

	it("cap semantics unchanged: 6 inline chem candidates cap at 5", () => {
		const result = extractQueryFormulas("$H2O$ $CO2$ $NaCl$ $CaO$ $MgO$ $ZnO$");
		expect(result.formulas).toHaveLength(5);
		expect(result.formulas[0]?.normalized).toBe("H2 O");
	});
});

describe("rewriteFormulaTokens — FTS token-stream unification (fast-mode token symmetry)", () => {
	it("collapses sharded ASCII formula runs back to one composite token", () => {
		expect(rewriteFormulaTokens("Heavy water ( H 2 O with deuterium )")).toBe("Heavy water ( H2O with deuterium )");
		expect(rewriteFormulaTokens("Carbon dioxide is CO 2 gas")).toBe("Carbon dioxide is CO2 gas");
		expect(rewriteFormulaTokens("H 2 SO 4 acid")).toBe("H2SO4 acid");
		expect(rewriteFormulaTokens("glucose C 6 H 12 O 6 ring")).toBe("glucose C6H12O6 ring");
		// the ₂ → sub2 pin participates as a count, so the subscript spelling unifies identically
		expect(rewriteFormulaTokens("H sub2 O")).toBe("H2O");
	});

	it("keeps glued punctuation and stoichiometric coefficients on the collapsed token", () => {
		expect(rewriteFormulaTokens("2 H 2 O freezes")).toBe("2H2O freezes");
	});

	it("never fuses count-less element runs or eats prose punctuation", () => {
		expect(rewriteFormulaTokens("Na Cl, H Cl; and C, N, O cycles")).toBe("Na Cl, H Cl; and C, N, O cycles");
		expect(rewriteFormulaTokens("Helium He is noble. He said")).toBe("Helium He is noble. He said");
		expect(rewriteFormulaTokens("the p H 7 buffer")).toBe("the p H 7 buffer");
	});

	it("is identity for math and unit token streams", () => {
		expect(rewriteFormulaTokens("x pow2 + y pow2 = r pow2")).toBe("x pow2 + y pow2 = r pow2");
		expect(rewriteFormulaTokens("torque N cdot m")).toBe("torque N cdot m");
		expect(rewriteFormulaTokens("single")).toBe("single");
	});
});

describe("fast-mode token symmetry (index content_tokenized ≡ query tokenizeForSearch)", () => {
	it("H2O: both spellings produce the same single term on index and query sides", () => {
		expect(preTokenizeForFTS("Heavy water (H2O with deuterium)")).toBe("Heavy water (H2O with deuterium)");
		expect(preTokenizeForFTS("Heavy water (H₂O with deuterium)")).toBe("Heavy water (H2O with deuterium)");
		expect(tokenizeForSearch("H2O")).toEqual(tokenizeForSearch("H₂O"));
		expect(tokenizeForSearch("H2O")).toEqual(new Set(["h2o"]));
	});

	it("CO2: the acronym-glued run unifies symmetrically", () => {
		expect(preTokenizeForFTS("Carbon dioxide is CO2 gas")).toBe("Carbon dioxide is CO2 gas");
		expect(tokenizeForSearch("CO2")).toEqual(new Set(["co2"]));
	});

	it("cross-spelling: an H2O doc and an H₂O doc share one token stream", () => {
		expect(preTokenizeForFTS("water is H2O here")).toBe(preTokenizeForFTS("water is H₂O here"));
		expect(tokenizeForSearch("(H₂O)")).toEqual(tokenizeForSearch("H2O"));
	});
});
