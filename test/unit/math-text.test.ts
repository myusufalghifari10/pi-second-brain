import { describe, expect, it } from "vitest";
import {
	canonicalizeMathText,
	extractDisplayFormulas,
	extractTexLabels,
	extractWikiLinks,
	MATH_UNICODE_MAP,
	MAX_FORMULA_CHARS,
	MAX_FORMULAS,
	MAX_LINKS,
	parseFrontmatter,
	type Segment,
	SUBSCRIPT_FOLDS,
	SUPERSCRIPT_FOLDS,
	splitOversizedProtected,
	splitProtectedSegments,
} from "../../src/indexer/math-text.ts";

describe("MATH_UNICODE_MAP", () => {
	it("has exactly 95 entries", () => expect(Object.keys(MATH_UNICODE_MAP)).toHaveLength(95));
	it("has exactly 15 superscript folds", () => expect(Object.keys(SUPERSCRIPT_FOLDS)).toHaveLength(15));
	it("has exactly 14 subscript folds", () => expect(Object.keys(SUBSCRIPT_FOLDS)).toHaveLength(14));
	it("fold sets and map do not overlap", () => {
		const keys = [...Object.keys(MATH_UNICODE_MAP), ...Object.keys(SUPERSCRIPT_FOLDS), ...Object.keys(SUBSCRIPT_FOLDS)];
		expect(new Set(keys).size).toBe(keys.length);
	});
	it("folds are plain alphanumeric words (FTS unicode61 safe)", () => {
		for (const word of [...Object.values(SUPERSCRIPT_FOLDS), ...Object.values(SUBSCRIPT_FOLDS)]) {
			expect(word).toMatch(/^[a-z0-9]+$/);
		}
	});
});

describe("canonicalizeMathText", () => {
	it("x² + y² = r² → x pow2 + y pow2 = r pow2", () =>
		expect(canonicalizeMathText("x² + y² = r²")).toBe("x pow2 + y pow2 = r pow2"));
	it("α ≤ β → alpha leq beta", () => expect(canonicalizeMathText("α ≤ β")).toBe("alpha leq beta"));
	it("x^2 + y^{ij} → x pow2 + y powij (caret rule)", () =>
		expect(canonicalizeMathText("x^2 + y^{ij}")).toBe("x pow2 + y powij"));
	it("\\frac{a}{b} unchanged", () => expect(canonicalizeMathText("\\frac{a}{b}")).toBe("\\frac{a}{b}"));
	it("E = mc² → E = mc pow2", () => expect(canonicalizeMathText("E = mc²")).toBe("E = mc pow2"));
	it("a_{ij} unchanged (ASCII underscore never transformed)", () =>
		expect(canonicalizeMathText("a_{ij}")).toBe("a_{ij}"));
	it("a₁ → a sub1 (unicode subscript folds directly)", () => expect(canonicalizeMathText("a₁")).toBe("a sub1"));
	it("snake_case_and_more unchanged", () =>
		expect(canonicalizeMathText("snake_case_and_more")).toBe("snake_case_and_more"));
	it("∫₀^∞ f(x)dx → int sub0 powinfty f(x)dx", () =>
		expect(canonicalizeMathText("∫₀^∞ f(x)dx")).toBe("int sub0 powinfty f(x)dx"));
	it("non-alphanumeric braced exponent → bare pow", () => expect(canonicalizeMathText("x^{\\top}")).toBe("x pow"));
	it("identity fast-path returns the same string reference for non-math input", () => {
		const inputs = ["snake_case_and_more", "plain prose with $ dollars and \\backslashes", "認證流程", "", "a_b 1 2 x"];
		for (const input of inputs) {
			expect(canonicalizeMathText(input)).toBe(input);
		}
	});
	it("every map entry folds its char to its word", () => {
		for (const [char, word] of Object.entries(MATH_UNICODE_MAP)) {
			expect(canonicalizeMathText(char)).toBe(word);
			expect(canonicalizeMathText(`a${char}b`)).toContain(word);
		}
	});
	it("every superscript/subscript fold yields its composite token", () => {
		for (const [char, token] of Object.entries(SUPERSCRIPT_FOLDS)) {
			expect(canonicalizeMathText(`x${char}`)).toBe(`x ${token}`);
		}
		for (const [char, token] of Object.entries(SUBSCRIPT_FOLDS)) {
			expect(canonicalizeMathText(`x${char}`)).toBe(`x ${token}`);
		}
	});
});

describe("splitProtectedSegments", () => {
	it("keeps $$ block with internal blank line as exactly ONE math segment", () => {
		const text = ["before", "", "$$", "E = mc^2", "", "c^2 = a^2 + b^2", "$$", "", "after"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		const math = segments.filter((s) => s.kind === "math");
		expect(math).toHaveLength(1);
		expect(math[0].startLine).toBe(3);
		expect(math[0].endLine).toBe(7);
		expect(math[0].text).toContain("");
	});

	it("unclosed $$ stays plain text (fail-open)", () => {
		const text = ["text", "$$", "E = mc^2", "never closed"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		expect(segments.filter((s) => s.kind === "math")).toHaveLength(0);
		expect(segments.every((s) => s.kind === "text")).toBe(true);
	});

	it("single-line $$…$$ is one atomic math segment", () => {
		const segments = splitProtectedSegments("a\n\n$$E=mc^2$$\n\nb", "markdown");
		const math = segments.filter((s) => s.kind === "math");
		expect(math).toHaveLength(1);
		expect(math[0].text).toBe("$$E=mc^2$$");
		expect(math[0].startLine).toBe(3);
	});

	it("escaped \\$ never opens math", () => {
		const segments = splitProtectedSegments("cost is \\$\\$5\\$\\$ total", "markdown");
		expect(segments.filter((s) => s.kind === "math")).toHaveLength(0);
	});

	it("```math fence → math segment", () => {
		const text = ["```math", "E = mc^2", "```", "after"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		const math = segments.filter((s) => s.kind === "math");
		expect(math).toHaveLength(1);
		expect(math[0].text).toBe("```math\nE = mc^2\n```");
	});

	it("```js fence with pipe lines inside is ONE code segment with zero table segments", () => {
		const text = ["```js", "const x = 1;", "| not | a table |", "| more |", "```", "after"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		expect(segments.filter((s) => s.kind === "code")).toHaveLength(1);
		expect(segments.filter((s) => s.kind === "table")).toHaveLength(0);
		expect(segments.filter((s) => s.kind === "code")[0].text).toContain("| not | a table |");
	});

	it("unclosed code fence stays text (fail-open)", () => {
		const text = ["```js", "const x = 1;", "no close"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		expect(segments.every((s) => s.kind === "text")).toBe(true);
	});

	it("3-line pipe table → one table segment with correct line numbers", () => {
		const text = ["intro", "| a | b |", "| - | - |", "| 1 | 2 |", "outro"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		const table = segments.filter((s) => s.kind === "table");
		expect(table).toHaveLength(1);
		expect(table[0].startLine).toBe(2);
		expect(table[0].endLine).toBe(4);
		expect(table[0].text.split("\n")).toHaveLength(3);
	});

	it("single pipe row is not a table", () => {
		const segments = splitProtectedSegments("| just | one | row |", "markdown");
		expect(segments.filter((s) => s.kind === "table")).toHaveLength(0);
	});

	it("\\begin{align}…\\end{align} is math in markdown mode", () => {
		const text = ["x", "\\begin{align}", "a &= b \\\\", "c &= d", "\\end{align}", "y"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		const math = segments.filter((s) => s.kind === "math");
		expect(math).toHaveLength(1);
		expect(math[0].startLine).toBe(2);
		expect(math[0].endLine).toBe(5);
	});

	it("\\begin{align}…\\end{align} is math in latex mode", () => {
		const text = ["\\begin{align}", "a &= b", "\\end{align}"].join("\n");
		const segments = splitProtectedSegments(text, "latex");
		expect(segments.filter((s) => s.kind === "math")).toHaveLength(1);
	});

	it("\\begin{tabular} is a table only in latex mode", () => {
		const text = ["\\begin{tabular}{cc}", "a & b \\\\", "\\end{tabular}"].join("\n");
		expect(splitProtectedSegments(text, "latex").filter((s) => s.kind === "table")).toHaveLength(1);
		expect(splitProtectedSegments(text, "markdown").filter((s) => s.kind === "table")).toHaveLength(0);
	});

	it("\\begin{equation} unclosed stays text (fail-open)", () => {
		const text = ["\\begin{equation}", "E = mc^2", "no end"].join("\n");
		const segments = splitProtectedSegments(text, "latex");
		expect(segments.every((s) => s.kind === "text")).toBe(true);
	});

	it("\\[ … \\] display math is protected in markdown mode", () => {
		const text = ["\\[", "E = mc^2", "\\]"].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		expect(segments.filter((s) => s.kind === "math")).toHaveLength(1);
	});

	it("segments are contiguous and line numbers reconstruct the input exactly", () => {
		const text = [
			"# Title",
			"",
			"Intro prose paragraph.",
			"",
			"$$",
			"E = mc^2",
			"",
			"F = ma",
			"$$",
			"",
			"| a | b |",
			"| - | - |",
			"",
			"```python",
			"| fake | table |",
			"x = 1",
			"```",
			"",
			"\\begin{gather}",
			"a & b",
			"\\end{gather}",
			"",
			"Closing paragraph.",
		].join("\n");
		const segments = splitProtectedSegments(text, "markdown");
		let expectedLine = 1;
		let reconstructed = "";
		for (const segment of segments) {
			expect(segment.startLine).toBe(expectedLine);
			expectedLine = segment.endLine + 1;
			reconstructed += `${segment.text}\n`;
		}
		expect(reconstructed).toBe(`${text}\n`);
		expect(expectedLine).toBe(text.split("\n").length + 1);
	});
});

describe("splitOversizedProtected", () => {
	function mathSegment(text: string): Segment {
		return { kind: "math", text, startLine: 1, endLine: text.split("\n").length };
	}

	it("returns the segment unchanged when under the limit", () => {
		const segment = mathSegment("$$E=mc^2$$");
		expect(splitOversizedProtected(segment, 6000)).toEqual([segment]);
	});

	it("splits oversized math only at top-level \\\\ row separators", () => {
		const row = `a_{${"x".repeat(300)}} &= ${"y".repeat(300)} \\\\`;
		const rows = Array(30).fill(row).join("\n");
		const pieces = splitOversizedProtected(mathSegment(rows), 6000);
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.every((piece) => piece.kind === "math")).toBe(true);
		expect(pieces.every((piece) => piece.text.length <= 6000)).toBe(true);
		// no characters lost: pieces concatenated reproduce the original segment
		expect(pieces.map((piece) => piece.text).join("")).toBe(rows);
		// every piece boundary falls between rows: every non-empty line is an original row
		for (const piece of pieces) {
			for (const line of piece.text.split("\n")) {
				if (line) expect(rows).toContain(line);
			}
		}
	});

	it("does not split at \\\\ inside braces", () => {
		const text = `${"a".repeat(5000)}_{x\\\\y} ${"b".repeat(2000)}`;
		const pieces = splitOversizedProtected(mathSegment(text), 6000);
		expect(pieces).toHaveLength(1);
	});

	it("splits oversized tables only at row boundaries", () => {
		const rowText = `| ${"c".repeat(200)} | d |`;
		const text = Array(40).fill(rowText).join("\n");
		const pieces = splitOversizedProtected({ kind: "table", text, startLine: 10, endLine: 49 }, 6000);
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.every((piece) => piece.text.startsWith("|"))).toBe(true);
		expect(pieces.map((piece) => piece.text).join("\n")).toBe(text);
		expect(pieces[0].startLine).toBe(10);
	});

	it("line numbers of pieces stay consistent with the source segment", () => {
		const rowText = `| ${"c".repeat(200)} | d |`;
		const text = Array(40).fill(rowText).join("\n");
		const pieces = splitOversizedProtected({ kind: "table", text, startLine: 10, endLine: 49 }, 6000);
		let expected = 10;
		for (const piece of pieces) {
			expect(piece.startLine).toBe(expected);
			expected = piece.endLine + 1;
		}
		expect(expected).toBe(50);
	});
});

describe("parseFrontmatter", () => {
	it("parses title, tags list, and aliases", () => {
		const text = [
			"---",
			"title: My Note",
			"tags: [math, physics]",
			"aliases: [Mass Energy, E=mc2]",
			"---",
			"",
			"body",
		].join("\n");
		const fm = parseFrontmatter(text);
		expect(fm.title).toBe("My Note");
		expect(fm.tags).toEqual(["math", "physics"]);
		expect(fm.aliases).toEqual(["Mass Energy", "E=mc2"]);
		expect(fm.bodyStartLine).toBe(6);
	});

	it("parses comma-string and bare values", () => {
		const text = ["---", "title: 'Quoted Title'", "tags: one, two", "---", "body"].join("\n");
		const fm = parseFrontmatter(text);
		expect(fm.title).toBe("Quoted Title");
		expect(fm.tags).toEqual(["one", "two"]);
		expect(fm.aliases).toEqual([]);
	});

	it("returns empty + bodyStartLine 1 for missing frontmatter", () => {
		const fm = parseFrontmatter("just body text");
		expect(fm.title).toBeUndefined();
		expect(fm.tags).toEqual([]);
		expect(fm.aliases).toEqual([]);
		expect(fm.bodyStartLine).toBe(1);
	});

	it("returns empty + bodyStartLine 1 for unclosed frontmatter", () => {
		const fm = parseFrontmatter("---\ntitle: Never Closed\nbody");
		expect(fm.title).toBeUndefined();
		expect(fm.bodyStartLine).toBe(1);
	});

	it("returns empty + bodyStartLine 1 for malformed list values", () => {
		const fm = parseFrontmatter("---\ntitle: X\ntags: [unclosed, list\n---\nbody");
		expect(fm.title).toBeUndefined();
		expect(fm.tags).toEqual([]);
		expect(fm.aliases).toEqual([]);
		expect(fm.bodyStartLine).toBe(1);
	});

	it("ignores non-allowlisted keys", () => {
		const fm = parseFrontmatter("---\ncustom: value\ntitle: Kept\n---\nbody");
		expect(fm.title).toBe("Kept");
	});
});

describe("extractWikiLinks", () => {
	it("extracts targets from plain, aliased, and heading links, deduped", () => {
		const text = "[[A]] and [[B|alias]] plus [[C#section]] and [[A]] again";
		expect(extractWikiLinks(text)).toEqual(["A", "B", "C"]);
	});

	it("caps at MAX_LINKS", () => {
		const text = Array.from({ length: 30 }, (_, i) => `[[Link${i}]]`).join(" ");
		const links = extractWikiLinks(text);
		expect(links).toHaveLength(MAX_LINKS);
		expect(links[0]).toBe("Link0");
	});

	it("returns empty for link-free text", () => expect(extractWikiLinks("no links here")).toEqual([]));
});

describe("extractTexLabels", () => {
	it("extracts label values", () => {
		expect(extractTexLabels("\\begin{equation}\\label{eq:mass}E=mc^2\\end{equation}")).toEqual(["eq:mass"]);
	});

	it("dedupes and caps at MAX_LABELS", () => {
		const text = `${Array.from({ length: 25 }, (_, i) => `\\label{eq:${i}}`).join(" ")} \\label{eq:0}`;
		const labels = extractTexLabels(text);
		expect(labels).toHaveLength(20);
	});
});

describe("extractDisplayFormulas", () => {
	it("extracts only math segments verbatim", () => {
		const segments: Segment[] = [
			{ kind: "text", text: "prose", startLine: 1, endLine: 1 },
			{ kind: "math", text: "$$E=mc^2$$", startLine: 2, endLine: 2 },
			{ kind: "code", text: "```js\nx=1\n```", startLine: 3, endLine: 5 },
			{ kind: "math", text: "$$E=mc^2$$", startLine: 6, endLine: 6 },
		];
		expect(extractDisplayFormulas(segments)).toEqual(["$$E=mc^2$$"]);
	});

	it("caps at MAX_FORMULAS entries of MAX_FORMULA_CHARS with ellipsis truncation", () => {
		const segments: Segment[] = Array.from({ length: 12 }, (_, i) => ({
			kind: "math" as const,
			// distinguishing char first so truncated formulas stay unique
			text: `${i}${"x".repeat(MAX_FORMULA_CHARS + 10)}`,
			startLine: i + 1,
			endLine: i + 1,
		}));
		const formulas = extractDisplayFormulas(segments);
		expect(formulas).toHaveLength(MAX_FORMULAS);
		for (const formula of formulas) {
			expect(formula.length).toBeLessThanOrEqual(MAX_FORMULA_CHARS + 1);
			expect(formula.endsWith("…")).toBe(true);
		}
	});
});
