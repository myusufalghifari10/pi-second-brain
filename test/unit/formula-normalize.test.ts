import { describe, expect, it } from "vitest";
import { extractQueryFormulas, normalizeFormula } from "../../src/indexer/formula-normalize.ts";
import { MAX_FORMULA_CHARS } from "../../src/indexer/math-text.ts";

describe("normalizeFormula — F1 vectors (spec §5)", () => {
	it("E=mc^2 ≡ $E = mc^{2}$ ≡ \\mathrm{E}\\!=\\!mc^2", () => {
		const expected = "E = mc ^ 2";
		expect(normalizeFormula("E=mc^2")?.normalized).toBe(expected);
		expect(normalizeFormula("$E = mc^{2}$")?.normalized).toBe(expected);
		expect(normalizeFormula("\\mathrm{E}\\!=\\!mc^2")?.normalized).toBe(expected);
	});

	it("E=mc^2 tokens are E = mc ^ 2 (caret stays an op token)", () => {
		expect(normalizeFormula("E=mc^2")?.tokens).toEqual(["E", "=", "mc", "^", "2"]);
	});

	it("\\dfrac{a}{b} ≡ \\frac{a}{b} ≡ \\frac a b → frac a b", () => {
		expect(normalizeFormula("\\dfrac{a}{b}")?.normalized).toBe("frac a b");
		expect(normalizeFormula("\\frac{a}{b}")?.normalized).toBe("frac a b");
		expect(normalizeFormula("\\frac a b")?.normalized).toBe("frac a b");
	});

	it("\\frac{a}{b} tokenizes to exactly [frac, a, b] (braces removed)", () => {
		expect(normalizeFormula("\\frac{a}{b}")?.tokens).toEqual(["frac", "a", "b"]);
	});

	it("\\le ≡ \\leq", () => {
		expect(normalizeFormula("x \\le 1")?.normalized).toBe("x leq 1");
		expect(normalizeFormula("x \\leq 1")?.normalized).toBe("x leq 1");
	});

	it("\\ne ≡ \\neq and \\ge ≡ \\geq", () => {
		expect(normalizeFormula("a \\ne b")?.normalized).toBe("a neq b");
		expect(normalizeFormula("a \\neq b")?.normalized).toBe("a neq b");
		expect(normalizeFormula("a \\ge b")?.normalized).toBe("a geq b");
		expect(normalizeFormula("a \\geq b")?.normalized).toBe("a geq b");
	});

	it("α ≡ \\alpha → alpha", () => {
		expect(normalizeFormula("α")?.normalized).toBe("alpha");
		expect(normalizeFormula("\\alpha")?.normalized).toBe("alpha");
	});

	it("ε ≡ \\varepsilon ≡ \\epsilon → epsilon (all three)", () => {
		expect(normalizeFormula("ε")?.normalized).toBe("epsilon");
		expect(normalizeFormula("\\varepsilon")?.normalized).toBe("epsilon");
		expect(normalizeFormula("\\epsilon")?.normalized).toBe("epsilon");
	});

	it("α ≠ ε (different base words)", () => {
		expect(normalizeFormula("α")?.normalized).not.toBe(normalizeFormula("ε")?.normalized);
	});

	it("E ≠ e (case is preserved)", () => {
		expect(normalizeFormula("E")?.normalized).toBe("E");
		expect(normalizeFormula("e")?.normalized).toBe("e");
		expect(normalizeFormula("E")?.normalized).not.toBe(normalizeFormula("e")?.normalized);
	});

	it("{x}+{y} ≡ x+y → x + y", () => {
		expect(normalizeFormula("{x}+{y}")?.normalized).toBe("x + y");
		expect(normalizeFormula("x+y")?.normalized).toBe("x + y");
	});

	it("\\left( x \\right) ≡ (x) (delimiters kept in text, dropped from tokens)", () => {
		expect(normalizeFormula("\\left( x \\right)")?.normalized).toBe("x");
		expect(normalizeFormula("(x)")?.normalized).toBe("x");
	});

	it("{x} ≡ x", () => {
		expect(normalizeFormula("{x}")?.normalized).toBe("x");
		expect(normalizeFormula("x")?.normalized).toBe("x");
	});

	it("outer math delimiters are stripped repeatedly: $$…$$, $…$, \\[…\\], \\(…\\)", () => {
		expect(normalizeFormula("$$x^2$$")?.normalized).toBe("x ^ 2");
		expect(normalizeFormula("$x^2$")?.normalized).toBe("x ^ 2");
		expect(normalizeFormula("\\[y\\]")?.normalized).toBe("y");
		expect(normalizeFormula("\\(z\\)")?.normalized).toBe("z");
		expect(normalizeFormula("$$\nE = mc^2\n$$")?.normalized).toBe("E = mc ^ 2");
	});

	it("spacing commands \\, \\; \\: \\! are removed", () => {
		expect(normalizeFormula("a \\, b \\; c \\: d \\! e")?.normalized).toBe("a b c d e");
	});

	it("\\quad and \\qquad are removed", () => {
		expect(normalizeFormula("a \\quad b \\qquad c")?.normalized).toBe("a b c");
	});

	it("\\displaystyle and \\limits are removed (sum equivalence)", () => {
		expect(normalizeFormula("\\displaystyle\\sum\\limits_{i=1}^{n} i")?.normalized).toBe(
			normalizeFormula("\\sum_{i=1}^{n} i")?.normalized,
		);
		expect(normalizeFormula("\\sum_{i=1}^{n} i")?.normalized).toBe("sum _ i = 1 ^ n i");
	});

	it("sized delimiter commands are removed, delimiters with them: \\left[ \\right], \\Big( \\Big)", () => {
		expect(normalizeFormula("\\left[ x \\right]")?.normalized).toBe("x");
		expect(normalizeFormula("\\Big( y \\Big)")?.normalized).toBe("y");
	});

	it("\\bigg|x\\bigg| ≡ |x| (brackets removed from tokens)", () => {
		expect(normalizeFormula("\\bigg|x\\bigg|")?.normalized).toBe("| x |");
		expect(normalizeFormula("|x|")?.normalized).toBe("| x |");
	});

	it("style wrappers unwrap keeping the argument", () => {
		expect(normalizeFormula("\\mathrm{d}x")?.normalized).toBe("d x");
		expect(normalizeFormula("\\mathbb{R}")?.normalized).toBe("R");
		expect(normalizeFormula("\\text{where} x")?.normalized).toBe("where x");
		expect(normalizeFormula("\\operatorname{sgn}(x)")?.normalized).toBe("sgn x");
	});

	it("\\mathbf{v}\\cdot\\nabla f → v cdot nabla f", () => {
		expect(normalizeFormula("\\mathbf{v}\\cdot\\nabla f")?.normalized).toBe("v cdot nabla f");
	});

	it("unicode superscripts fold: x²+y²=z² → x pow2 + y pow2 = z pow2", () => {
		expect(normalizeFormula("x²+y²=z²")?.normalized).toBe("x pow2 + y pow2 = z pow2");
	});

	it("unicode subscript folds: a₁ → a sub1", () => {
		expect(normalizeFormula("a₁")?.normalized).toBe("a sub1");
	});

	it("∫₀^∞ f → int sub0 ^ infty f", () => {
		expect(normalizeFormula("∫₀^∞ f")?.normalized).toBe("int sub0 ^ infty f");
	});

	it("α+β → alpha + beta", () => {
		expect(normalizeFormula("α+β")?.normalized).toBe("alpha + beta");
	});

	it("Σ ≡ σ ≡ \\varsigma → sigma", () => {
		expect(normalizeFormula("Σ")?.normalized).toBe("sigma");
		expect(normalizeFormula("σ")?.normalized).toBe("sigma");
		expect(normalizeFormula("\\varsigma")?.normalized).toBe("sigma");
	});

	it("→ ≡ \\to ≡ \\rightarrow → to", () => {
		expect(normalizeFormula("→")?.normalized).toBe("to");
		expect(normalizeFormula("\\to")?.normalized).toBe("to");
		expect(normalizeFormula("\\rightarrow")?.normalized).toBe("to");
	});

	it("⇔ ≡ \\iff ≡ \\Leftrightarrow → iff", () => {
		expect(normalizeFormula("⇔")?.normalized).toBe("iff");
		expect(normalizeFormula("\\iff")?.normalized).toBe("iff");
		expect(normalizeFormula("\\Leftrightarrow")?.normalized).toBe("iff");
	});

	it("\\implies ≡ \\Rightarrow → Rightarrow (capital preserved)", () => {
		expect(normalizeFormula("\\implies")?.normalized).toBe("Rightarrow");
		expect(normalizeFormula("\\Rightarrow")?.normalized).toBe("Rightarrow");
	});

	it("frozen-table artifacts: unicode ⇒/← fold to implies/gets, NOT to the TeX Rightarrow/leftarrow tokens", () => {
		// Both tables are frozen (spec §3.1 steps 4–5): MATH_UNICODE_MAP folds ⇒→implies, ←→gets,
		// while the alias table maps \Rightarrow/\implies→Rightarrow and \gets/\leftarrow→leftarrow.
		expect(normalizeFormula("⇒")?.normalized).toBe("implies");
		expect(normalizeFormula("←")?.normalized).toBe("gets");
		expect(normalizeFormula("\\gets")?.normalized).toBe("leftarrow");
	});

	it("\\land ≡ \\wedge → land; \\lor ≡ \\vee → lor", () => {
		expect(normalizeFormula("p \\land q")?.normalized).toBe("p land q");
		expect(normalizeFormula("p \\wedge q")?.normalized).toBe("p land q");
		expect(normalizeFormula("p \\lor q")?.normalized).toBe("p lor q");
		expect(normalizeFormula("p \\vee q")?.normalized).toBe("p lor q");
	});

	it("\\dots ≡ \\ldots ≡ \\cdots → dots", () => {
		expect(normalizeFormula("1 \\dots n")?.normalized).toBe("1 dots n");
		expect(normalizeFormula("1 \\ldots n")?.normalized).toBe("1 dots n");
		expect(normalizeFormula("1 \\cdots n")?.normalized).toBe("1 dots n");
	});

	it("· ≡ \\cdot → cdot", () => {
		expect(normalizeFormula("v · f")?.normalized).toBe("v cdot f");
		expect(normalizeFormula("v \\cdot f")?.normalized).toBe("v cdot f");
	});

	it("var-family ≡ plain TeX names", () => {
		expect(normalizeFormula("\\varepsilon")?.normalized).toBe(normalizeFormula("\\epsilon")?.normalized);
		expect(normalizeFormula("\\vartheta")?.normalized).toBe(normalizeFormula("\\theta")?.normalized);
		expect(normalizeFormula("\\varphi")?.normalized).toBe(normalizeFormula("\\phi")?.normalized);
		expect(normalizeFormula("\\varpi")?.normalized).toBe(normalizeFormula("\\pi")?.normalized);
		expect(normalizeFormula("\\varrho")?.normalized).toBe(normalizeFormula("\\rho")?.normalized);
	});

	it("≤ ≡ \\leq (unicode relation ≡ TeX alias)", () => {
		expect(normalizeFormula("a≤b")?.normalized).toBe("a leq b");
		expect(normalizeFormula("a \\leq b")?.normalized).toBe("a leq b");
	});

	it("\\Gamma ≠ \\gamma (TeX command case preserved)", () => {
		expect(normalizeFormula("\\Gamma")?.normalized).toBe("Gamma");
		expect(normalizeFormula("\\gamma")?.normalized).toBe("gamma");
		expect(normalizeFormula("\\Gamma")?.normalized).not.toBe(normalizeFormula("\\gamma")?.normalized);
	});

	it("mismatched braces are tolerated (tokens still extracted, no throw)", () => {
		expect(normalizeFormula("\\frac{a")?.normalized).toBe("frac a");
		expect(normalizeFormula("x}")?.normalized).toBe("x");
	});

	it("subscript brace forms agree: x_i ≡ x_{i}", () => {
		expect(normalizeFormula("x_i")?.normalized).toBe("x _ i");
		expect(normalizeFormula("x_{i}")?.normalized).toBe("x _ i");
	});

	it("degenerate input → undefined (empty, blank, brace-only)", () => {
		expect(normalizeFormula("")).toBeUndefined();
		expect(normalizeFormula("   ")).toBeUndefined();
		expect(normalizeFormula("{}")).toBeUndefined();
	});

	it("trimmed length > MAX_FORMULA_CHARS (reused L1 constant) → undefined", () => {
		expect(MAX_FORMULA_CHARS).toBe(2000);
		expect(normalizeFormula("x".repeat(MAX_FORMULA_CHARS))?.normalized).toBe("x".repeat(MAX_FORMULA_CHARS));
		expect(normalizeFormula("x".repeat(MAX_FORMULA_CHARS + 1))).toBeUndefined();
	});

	it("raw is the trimmed input; tokenCount matches tokens", () => {
		const result = normalizeFormula("  x^2  ");
		expect(result?.raw).toBe("x^2");
		expect(result?.tokenCount).toBe(3);
		expect(result?.tokens).toEqual(["x", "^", "2"]);
	});

	it("internal whitespace runs never affect the canonical form", () => {
		expect(normalizeFormula("  E  =  mc ^ 2  ")?.normalized).toBe(normalizeFormula("E=mc^2")?.normalized);
	});

	it("unknown commands keep their name (backslash dropped)", () => {
		expect(normalizeFormula("\\foo{x}")?.normalized).toBe("foo x");
	});
});

describe("extractQueryFormulas — F2 vectors (spec §5)", () => {
	it("inline math: 'solve $x^2=4$ fast' → 1 formula + cleaned 'solve fast'", () => {
		const result = extractQueryFormulas("solve $x^2=4$ fast");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("x ^ 2 = 4");
		expect(result.cleanedQuery).toBe("solve fast");
	});

	it("plain text → no formulas + cleanedQuery === input (dormant path is verbatim)", () => {
		const result = extractQueryFormulas("plain text");
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe("plain text");
	});

	it("bare-TeX with braced argument: 'use \\frac{a}{b} here' → 1 formula", () => {
		const result = extractQueryFormulas("use \\frac{a}{b} here");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("use frac a b here");
	});

	it("bare-TeX with ≥2 commands: 'compare \\alpha and \\beta now' → 1 formula", () => {
		const result = extractQueryFormulas("compare \\alpha and \\beta now");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("compare alpha and beta now");
	});

	it("single command without braces stays prose (anti-false-positive)", () => {
		const result = extractQueryFormulas("the \\frac command");
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe("the \\frac command");
	});

	it("more than 5 formulas → capped at 5", () => {
		const query = "$a$ $b$ $c$ $d$ $e$ $f$";
		const result = extractQueryFormulas(query);
		expect(result.formulas).toHaveLength(5);
		expect(result.formulas.map((f) => f.normalized)).toEqual(["a", "b", "c", "d", "e"]);
		expect(result.cleanedQuery).toBe(query); // all text was math → never empty
	});

	it("degenerate math span is dropped silently, sibling formula survives", () => {
		const result = extractQueryFormulas("solve $ { } $ $x^2$ fast");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("x ^ 2");
		expect(result.cleanedQuery).toBe("solve fast");
	});

	it("all-degenerate spans → zero formulas → dormant verbatim query", () => {
		const query = "solve $ { } $ fast";
		const result = extractQueryFormulas(query);
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe(query);
	});

	it("whole-query display math → 1 formula + cleanedQuery never empty", () => {
		const result = extractQueryFormulas("$$E = mc^2$$");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("E = mc ^ 2");
		expect(result.cleanedQuery).toBe("$$E = mc^2$$");
	});

	it("multi-line display block is extracted and removed from the text leg", () => {
		const result = extractQueryFormulas("before\n$$\nE = mc^2\n$$\nafter");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("E = mc ^ 2");
		expect(result.cleanedQuery).toBe("before after");
	});

	it("query that is only one inline formula keeps cleanedQuery = original", () => {
		const result = extractQueryFormulas("$x^2$");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("x ^ 2");
		expect(result.cleanedQuery).toBe("$x^2$");
	});

	it("empty query → dormant empty result", () => {
		const result = extractQueryFormulas("");
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe("");
	});

	it("unpaired $ stays literal prose (no formula)", () => {
		const query = "cost is 5$ here";
		const result = extractQueryFormulas(query);
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe(query);
	});

	it("escaped \\$ never opens a math span", () => {
		const result = extractQueryFormulas("price is \\$5 and $x^2$ here");
		expect(result.formulas).toHaveLength(1);
		expect(result.formulas[0]?.normalized).toBe("x ^ 2");
		expect(result.cleanedQuery).toBe("price is \\$5 and here");
	});

	it("normalization rejects do not consume cap slots (first 5 valid formulas win)", () => {
		const result = extractQueryFormulas("$a$ $ { } $ $b$ $ { } $ $c$ $d$ $e$ $f$");
		expect(result.formulas).toHaveLength(5);
		expect(result.formulas.map((f) => f.normalized)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("oversized formulas are rejected by the shared MAX_FORMULA_CHARS guard", () => {
		const oversized = "x".repeat(MAX_FORMULA_CHARS + 1);
		const result = extractQueryFormulas(`$${oversized}$`);
		expect(result.formulas).toHaveLength(0);
		expect(result.cleanedQuery).toBe(`$${oversized}$`);
	});
});
