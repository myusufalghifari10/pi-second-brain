import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkLaTeX } from "../../src/indexer/chunker.ts";
import { resolveLabelTarget } from "../../src/indexer/label-resolve.ts";
import { extractTexRefs, MAX_REFS } from "../../src/indexer/math-text.ts";

describe("extractTexRefs", () => {
	it("captures all five ref macros including mixed-case Cref", () => {
		const text = "\\ref{eq:a} and \\eqref{eq:b} plus \\cref{sec:c}, \\Cref{fig:d}, \\autoref{app:e}.";
		expect(extractTexRefs(text)).toEqual(["eq:a", "eq:b", "sec:c", "fig:d", "app:e"]);
	});

	it("is case-sensitive: cref and Cref are both matched, targets kept verbatim", () => {
		expect(extractTexRefs("\\cref{fig:one} \\Cref{fig:one}")).toEqual(["fig:one"]);
		expect(extractTexRefs("\\Cref{Fig:One} \\cref{fig:one}")).toEqual(["Fig:One", "fig:one"]);
	});

	it("dedupes while preserving first-occurrence order", () => {
		expect(extractTexRefs("\\ref{b} \\ref{a} \\eqref{b} \\autoref{a} \\cref{c}")).toEqual(["b", "a", "c"]);
	});

	it("caps at MAX_REFS (40)", () => {
		const text = Array.from({ length: 45 }, (_, i) => `\\ref{r${i}}`).join(" ");
		const refs = extractTexRefs(text);
		expect(refs).toHaveLength(MAX_REFS);
		expect(refs[0]).toBe("r0");
		expect(refs[MAX_REFS - 1]).toBe("r39");
	});

	it("returns empty for text without refs and ignores labels", () => {
		expect(extractTexRefs("\\label{eq:x} plain text without any reference macro")).toEqual([]);
		expect(extractTexRefs("")).toEqual([]);
	});
});

describe("resolveLabelTarget", () => {
	it("resolves a same-file hit", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/a.tex"]);
		expect(r.status).toBe("resolved");
		expect(r.targetPath).toBe("docs/a.tex");
	});

	it("prefers a same-file hit over out-of-file definitions", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/b.tex", "docs/a.tex"]);
		expect(r.status).toBe("resolved");
		expect(r.targetPath).toBe("docs/a.tex");
	});

	it("resolves a unique cross-file hit", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/b.tex"]);
		expect(r.status).toBe("resolved");
		expect(r.targetPath).toBe("docs/b.tex");
	});

	it("stays unresolved on collision (label defined in more than one other file)", () => {
		const r = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/b.tex", "docs/c.tex"]);
		expect(r.status).toBe("unresolved");
		expect(r.targetPath).toBeNull();
	});

	it("stays unresolved when the label has no defining file", () => {
		expect(resolveLabelTarget("docs/a.tex", "eq:missing", []).status).toBe("unresolved");
		expect(resolveLabelTarget("docs/a.tex", "eq:missing", ["docs/b.tex", "docs/c.tex", "docs/d.tex"]).status).toBe(
			"unresolved",
		);
	});

	it("never guesses: empty label stays unresolved even with candidates", () => {
		const r = resolveLabelTarget("docs/a.tex", "  ", ["docs/a.tex"]);
		expect(r.status).toBe("unresolved");
		expect(r.targetPath).toBeNull();
	});

	it("scope-key is sha256(relPath + NUL + label), distinct per referencing file", () => {
		const expected = createHash("sha256").update("docs/a.tex\0eq:x").digest("hex");
		const inA = resolveLabelTarget("docs/a.tex", "eq:x", ["docs/a.tex"]);
		const fromB = resolveLabelTarget("docs/b.tex", "eq:x", ["docs/a.tex"]);
		expect(inA.scopeKey).toBe(expected);
		expect(inA.scopeKey).not.toBe(fromB.scopeKey);
		expect(fromB.scopeKey).toBe(createHash("sha256").update("docs/b.tex\0eq:x").digest("hex"));
	});
});

describe("chunker metadata.refs threading", () => {
	const tex = [
		"\\documentclass{article}",
		"",
		"Preamble context paragraph with enough content to pass the fifty character minimum threshold.",
		"",
		"\\section{Derivation}",
		"",
		"Body paragraph with enough content to pass the fifty character minimum threshold here.",
		"",
		"\\begin{equation}",
		"E = mc^2",
		"\\end{equation}",
		"\\label{eq:main}",
		"As \\ref{eq:other} and \\eqref{eq:third} show, \\cref{fig:one} agrees with \\Cref{fig:one}.",
		"\\end{document}",
	].join("\n");

	it("writes metadata.refs alongside labels and both coexist on the same chunk", () => {
		const chunks = chunkLaTeX(tex, "paper.tex");
		const labeled = chunks.find((chunk) => chunk.metadata_json.includes('"labels"'));
		if (!labeled) throw new Error("expected a labeled latex chunk");
		const metadata = JSON.parse(labeled.metadata_json) as { labels?: string[]; refs?: string[] };
		expect(metadata.labels).toEqual(["eq:main"]);
		expect(metadata.refs).toEqual(["eq:other", "eq:third", "fig:one"]);
	});

	it("omits the refs key when a section references nothing", () => {
		const chunks = chunkLaTeX(
			[
				"\\documentclass{article}",
				"",
				"Preamble context paragraph with enough content to pass the fifty character minimum threshold.",
				"",
				"\\section{Plain}",
				"",
				"Section body paragraph with enough content to pass the fifty character minimum threshold.",
				"",
				"\\label{eq:only} and a closing line with enough content to pass the fifty character limit.",
				"\\end{document}",
			].join("\n"),
			"plain.tex",
		);
		const labeled = chunks.find((chunk) => chunk.metadata_json.includes('"labels"'));
		if (!labeled) throw new Error("expected a labeled latex chunk");
		const metadata = JSON.parse(labeled.metadata_json) as { refs?: string[] };
		expect(metadata.refs).toBeUndefined();
	});
});
