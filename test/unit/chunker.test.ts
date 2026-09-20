import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	analyzeIndexableContent,
	buildChunkEmbeddingText,
	chunkFile,
	chunkIdentityHash,
	chunkLaTeX,
	chunkMarkdown,
	chunkText,
	contentHash,
	createSkippedScanStats,
	iterateScannableFiles,
	iterateScannedFiles,
	preTokenizeForFTS,
	summarizeSkippedScan,
	walkDir,
	walkDirDetailed,
} from "../../src/indexer/chunker.ts";

describe("preTokenizeForFTS", () => {
	it("splits camelCase", () => expect(preTokenizeForFTS("getElementById")).toBe("get Element By Id"));
	it("splits ACRONYM", () => expect(preTokenizeForFTS("HTMLElement")).toBe("HTML Element"));
	it("splits numbers", () => expect(preTokenizeForFTS("item1value")).toBe("item 1 value"));
	it("CJK per-char", () => expect(preTokenizeForFTS("認證流程")).toBe("認 證 流 程"));
	it("mixed", () => expect(preTokenizeForFTS("getUser認證")).toBe("get User 認 證"));
	it("empty", () => expect(preTokenizeForFTS("")).toBe(""));
	it("snake_case unchanged", () => expect(preTokenizeForFTS("snake_case")).toBe("snake_case"));
});

describe("contentHash", () => {
	it("consistent", () => expect(contentHash("x")).toBe(contentHash("x")));
	it("64 hex chars", () => expect(contentHash("x")).toHaveLength(64));
	it("different input → different hash", () => expect(contentHash("a")).not.toBe(contentHash("b")));
});

describe("chunkIdentityHash", () => {
	const base = {
		content: "same content",
		fileType: "typescript",
		startLine: 1,
		endLine: 2,
		metadataJson: "{}",
	};

	it("distinguishes duplicate content in different files", () => {
		expect(chunkIdentityHash({ ...base, filePath: "a.ts" })).not.toBe(chunkIdentityHash({ ...base, filePath: "b.ts" }));
	});

	it("distinguishes duplicate content at different locations", () => {
		expect(chunkIdentityHash({ ...base, filePath: "a.ts", startLine: 1, endLine: 2 })).not.toBe(
			chunkIdentityHash({ ...base, filePath: "a.ts", startLine: 10, endLine: 11 }),
		);
	});
});

describe("chunkMarkdown", () => {
	it("splits on headings", () => {
		const md =
			"## S1\n\nContent for section one that is long enough to pass threshold.\n\n## S2\n\nContent for section two that is also long enough to pass.";
		expect(chunkMarkdown(md, "t.md").length).toBe(2);
	});
	it("keeps heading in chunk", () => {
		const md = "## Title\n\nContent that is definitely long enough to pass the minimum char threshold.";
		expect(chunkMarkdown(md, "t.md")[0].content).toContain("## Title");
	});
	it("adds heading breadcrumb and file context to indexed text", () => {
		const md = [
			"# Product",
			"## Billing",
			"### Refunds",
			"RefundPolicyToken content that is definitely long enough to pass the minimum char threshold.",
		].join("\n\n");
		const [chunk] = chunkMarkdown(md, "docs/billing.md");
		expect(chunk.metadata_json).toContain("Product > Billing > Refunds");
		expect(chunk.content_tokenized).toContain("docs/billing.md");
		expect(buildChunkEmbeddingText(chunk)).toContain("Section: Product > Billing > Refunds");
	});
	it("splits large sections into focused contextual chunks", () => {
		const para = "FocusedMarkdownToken paragraph with enough detail about one specific retrieval subject. ".repeat(20);
		const md = `## Big Section\n\n${Array(8).fill(para).join("\n\n")}`;
		const chunks = chunkMarkdown(md, "big.md");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.metadata_json.includes("Big Section"))).toBe(true);
	});
	it("splits oversized single paragraphs into bounded chunks", () => {
		const chunks = chunkMarkdown(`## Big Section\n\nLongMarkdownToken ${"x".repeat(20_000)}`, "big.md");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(chunks[0].content).toContain("## Big Section");
		expect(chunks.every((chunk) => chunk.metadata_json.includes("Big Section"))).toBe(true);
	});
	it("skips short sections", () => {
		const md = "## A\n\nHi\n\n## B\n\nThis section passes the fifty character minimum threshold for valid chunks.";
		const chunks = chunkMarkdown(md, "t.md");
		expect(chunks.length).toBe(1);
		expect(chunks[0].content).toContain("## B");
	});
	it("empty → no chunks", () => expect(chunkMarkdown("", "t.md")).toEqual([]));
});

describe("chunkText", () => {
	it("chunks long content", () => {
		const para =
			"This is a substantial paragraph with enough words to contribute meaningful token count towards the chunk size target. ".repeat(
				5,
			);
		const text = Array(10).fill(para).join("\n\n");
		expect(chunkText(text, "t.txt").length).toBeGreaterThan(1);
	});
	it("does not overlap paragraphs between adjacent text chunks", () => {
		const paragraphs = Array.from({ length: 8 }, (_, i) =>
			`UniqueTextParagraph${i} has enough meaningful detail for contextual retrieval without overlap. `.repeat(8),
		);
		const chunks = chunkText(paragraphs.join("\n\n"), "t.txt");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].content).not.toContain("UniqueTextParagraph7");
		expect(chunks[1].content).not.toContain("UniqueTextParagraph0");
	});
	it("splits oversized single paragraphs into bounded chunks", () => {
		const chunks = chunkText(`LongLineToken ${"x".repeat(20_000)}`, "backup.jsonl");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(chunks[0].content).toContain("LongLineToken");
	});
	it("empty → no chunks", () => expect(chunkText("", "t.txt")).toEqual([]));
});

describe("walkDir", () => {
	let tmp = "";

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pk-test-walk-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("respects ignores and skips binary", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		mkdirSync(join(tmp, "docs"), { recursive: true });
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		mkdirSync(join(tmp, "packages", "playwright-core", "src", "server", "chromium"), { recursive: true });
		mkdirSync(join(tmp, "browsers", "Chromium.app", "Contents", "Resources", "en.lproj"), { recursive: true });
		writeFileSync(join(tmp, "src/a.ts"), "export const a = 1;");
		writeFileSync(
			join(tmp, "packages", "playwright-core", "src", "server", "chromium", "crBrowser.ts"),
			"export class BrowserSource {}",
		);
		writeFileSync(join(tmp, "node_modules/x.js"), "no");
		writeFileSync(join(tmp, "b.png"), Buffer.from([0x89, 0x50, 0x00]));
		writeFileSync(join(tmp, "c.md"), "# C\n\nContent");
		writeFileSync(join(tmp, "docs/knowledge-base-full-evaluation-report.md"), "# Generated evaluation");
		writeFileSync(join(tmp, "knowledge-backup.jsonl"), JSON.stringify({ exported: true }));
		writeFileSync(join(tmp, "browsers", "Chromium.app", "Contents", "Resources", "en.lproj", "locale.pak"), "no");
		const paths = walkDir(tmp).map((f) => f.relPath);
		expect(paths).toContain("src/a.ts");
		expect(paths).toContain("c.md");
		expect(paths).toContain("packages/playwright-core/src/server/chromium/crBrowser.ts");
		expect(paths).not.toContain("node_modules/x.js");
		expect(paths).not.toContain("b.png");
		expect(paths).not.toContain("docs/knowledge-base-full-evaluation-report.md");
		expect(paths).not.toContain("knowledge-backup.jsonl");
		expect(paths).not.toContain("browsers/Chromium.app/Contents/Resources/en.lproj/locale.pak");
	});

	it("can include suggested-excluded text after explicit confirmation", () => {
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		writeFileSync(join(tmp, ".env"), "CONFIRMED_ENV_TEXT=1");
		writeFileSync(join(tmp, "node_modules", "x.js"), "export const ConfirmedVendorText = true;");
		writeFileSync(join(tmp, "image.png"), Buffer.from([0x89, 0x50, 0x00]));

		const scan = walkDirDetailed(tmp, { includeSuggestedText: true });
		const paths = scan.files.map((file) => file.relPath);

		expect(paths).toContain(".env");
		expect(paths).toContain("node_modules/x.js");
		expect(paths).not.toContain("image.png");
		expect(scan.skipped.by_reason.binary).toBe(1);
	});

	it("can include a focused suggested-excluded path without including the whole suggested tree", () => {
		mkdirSync(join(tmp, "node_modules", "chosen"), { recursive: true });
		mkdirSync(join(tmp, "node_modules", "other"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", "chosen", "index.js"), "export const ChosenVendorText = true;");
		writeFileSync(join(tmp, "node_modules", "other", "index.js"), "export const OtherVendorText = true;");

		const scan = walkDirDetailed(tmp, { includePaths: ["node_modules/chosen/index.js"] });
		const paths = scan.files.map((file) => file.relPath);

		expect(paths).toContain("node_modules/chosen/index.js");
		expect(paths).not.toContain("node_modules/other/index.js");
		expect(scan.skipped.by_reason.suggested_excluded).toBeGreaterThan(0);
	});

	it("reports skipped file reasons and samples", () => {
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		writeFileSync(join(tmp, "src.ts"), "export const token = 'ScanToken';");
		writeFileSync(join(tmp, "node_modules", "ignored.js"), "ignored");
		writeFileSync(join(tmp, "image.png"), Buffer.from([0x89, 0x50, 0x00]));

		const scan = walkDirDetailed(tmp);

		expect(scan.files.map((file) => file.relPath)).toContain("src.ts");
		expect(scan.skipped.total).toBeGreaterThanOrEqual(2);
		expect(scan.skipped.by_reason.suggested_excluded).toBeGreaterThan(0);
		expect(scan.skipped.by_reason.binary).toBeGreaterThan(0);
		expect(scan.skipped.samples.some((sample) => sample.path.includes("node_modules"))).toBe(true);
	});

	it("streams files while accumulating bounded skipped stats", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		for (let i = 0; i < 30; i++) writeFileSync(join(tmp, "src", `file-${i}.ts`), `export const value${i} = ${i};`);
		for (let i = 0; i < 40; i++) writeFileSync(join(tmp, `image-${i}.png`), Buffer.from([0x89, 0x50, 0x00]));
		const skipped = createSkippedScanStats();
		const paths: string[] = [];

		for (const file of iterateScannedFiles(tmp, skipped)) {
			if (paths.length < 5) paths.push(file.relPath);
		}

		expect(paths).toHaveLength(5);
		expect(skipped.samples.length).toBeLessThanOrEqual(25);
		expect(summarizeSkippedScan(skipped)).toContain("binary");
	});

	it("can scan file metadata without loading file content", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "large.ts"), `export const LargeMetadataToken = "${"x".repeat(1000)}";`);
		const skipped = createSkippedScanStats();

		const [file] = [...iterateScannableFiles(tmp, skipped)];

		expect(file.relPath).toBe("src/large.ts");
		expect(file.fileType).toBe("typescript");
		expect(file.size).toBeGreaterThan(1000);
		expect("content" in file).toBe(false);
	});
});

describe("chunkFile (async)", () => {
	it("dispatches .md to markdown chunker", async () => {
		const chunks = await chunkFile(
			"## Test\n\nContent that is long enough to pass the minimum character threshold.",
			"test.md",
		);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].file_type).toBe("markdown");
	});
	it("dispatches .ts to AST chunker", async () => {
		const code = 'export function hello(): string { return "hi"; }';
		const chunks = await chunkFile(code, "test.ts");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].metadata_json).toContain("hello");
	});
	it("falls back to text for unknown types", async () => {
		const text = Array(15).fill("A paragraph with enough meaningful content for testing purposes here.").join("\n\n");
		const chunks = await chunkFile(text, "data.csv");
		expect(chunks.length).toBeGreaterThan(0);
	});
});

describe("preTokenizeForFTS math canonicalization", () => {
	it("folds superscripts into pow composite tokens", () => {
		const tokenized = preTokenizeForFTS("x² + y²");
		expect(tokenized).toContain("pow2");
		expect(tokenized).toContain("x pow2");
	});
	it("folds greek letters and relations into canonical words", () => {
		const tokenized = preTokenizeForFTS("α ≤ β");
		expect(tokenized).toContain("alpha");
		expect(tokenized).toContain("leq");
	});
	it("keeps LaTeX command input symmetric at the token level", () => {
		const latexSide = preTokenizeForFTS("\\alpha \\leq \\beta");
		expect(latexSide).toContain("alpha");
		expect(latexSide).toContain("leq");
		// unicode side folds onto the same words
		const unicodeSide = preTokenizeForFTS("α ≤ β");
		expect(unicodeSide).toContain("alpha leq");
	});
});

describe("chunkMarkdown math and table protection", () => {
	it("keeps a $$ block containing blank lines intact inside exactly one chunk", () => {
		const md = [
			"## Math Section",
			"",
			"Intro paragraph that is long enough to pass the fifty character minimum threshold for chunks.",
			"",
			"$$",
			"E = mc^2",
			"",
			"c^2 = a^2 + b^2",
			"$$",
			"",
			"Closing paragraph that is also long enough to pass the fifty character minimum threshold.",
		].join("\n");
		const chunks = chunkMarkdown(md, "math.md");
		expect(chunks.length).toBeGreaterThan(0);
		const withBlock = chunks.filter((chunk) => chunk.content.includes("$$"));
		expect(withBlock).toHaveLength(1);
		expect(withBlock[0].content).toContain("$$\nE = mc^2\n\nc^2 = a^2 + b^2\n$$");
		expect(JSON.parse(withBlock[0].metadata_json).formulas).toEqual(["$$\nE = mc^2\n\nc^2 = a^2 + b^2\n$$"]);
	});

	it("splits oversized pipe tables only at row boundaries", () => {
		const row = `| ${"cell".repeat(60)} | value |`;
		const table = Array(30).fill(row).join("\n");
		const md = `## Data\n\nIntro paragraph that is long enough to pass the fifty character minimum threshold.\n\n${table}`;
		const chunks = chunkMarkdown(md, "table.md");
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.content.startsWith("## Data") || chunk.content.startsWith("|")).toBe(true);
			expect(chunk.content.length).toBeLessThanOrEqual(6_000);
		}
		const tableChunks = chunks.filter((chunk) => chunk.content.startsWith("|"));
		expect(tableChunks.length).toBeGreaterThan(0);
		for (const chunk of tableChunks) {
			for (const line of chunk.content.split("\n")) {
				if (line.startsWith("|")) expect(table).toContain(line);
			}
		}
	});

	it("strips frontmatter and carries title/tags/aliases into metadata and embedding text", () => {
		const md = [
			"---",
			"title: Vault Note",
			"tags: [math, physics]",
			"aliases: [Mass Energy]",
			"---",
			"## Body",
			"",
			"Frontmatter note body content that is long enough to pass the fifty character threshold.",
		].join("\n");
		const chunks = chunkMarkdown(md, "note.md");
		expect(chunks.length).toBeGreaterThan(0);
		const metadata = JSON.parse(chunks[0].metadata_json);
		expect(metadata.title).toBe("Vault Note");
		expect(metadata.tags).toEqual(["math", "physics"]);
		expect(metadata.aliases).toEqual(["Mass Energy"]);
		const embedding = buildChunkEmbeddingText(chunks[0]);
		expect(embedding).toContain("Title: Vault Note");
		expect(embedding).toContain("Tags: math, physics");
		expect(embedding).toContain("Aliases: Mass Energy");
		expect(chunks[0].content).not.toContain("tags: [math, physics]");
	});

	it("extracts wikilinks into metadata and embedding text", () => {
		const md =
			"## Links\n\nSee [[Mass Energy]] and [[Special Relativity|SR]] plus [[Momentum#conservation]] notes are long enough for retrieval here.";
		const [chunk] = chunkMarkdown(md, "links.md");
		const metadata = JSON.parse(chunk.metadata_json);
		expect(metadata.links).toEqual(["Mass Energy", "Special Relativity", "Momentum"]);
		expect(buildChunkEmbeddingText(chunk)).toContain("Links: Mass Energy, Special Relativity, Momentum");
	});

	it("canonicalizes math unicode into content_tokenized", () => {
		const md =
			"## Ratio\n\nThe parameter β controls the spread and β² appears twice in this note which is long enough to pass the minimum.";
		const [chunk] = chunkMarkdown(md, "beta.md");
		expect(chunk.content_tokenized).toContain("beta");
		expect(chunk.content_tokenized).toContain("pow2");
		// chunk content stays verbatim (never canonicalized)
		expect(chunk.content).toContain("β²");
	});
});

describe("buildChunkEmbeddingText context prefix guard", () => {
	// buildChunkEmbeddingText = `<File/Type/Section baseline>\n\n<content>`; everything the
	// guard controls (Title/Tags/Aliases/Links/Labels/Formulas) lives in the added prefix.
	function addedPrefixChars(embedding: string): number {
		const baseline = ["File: ", "Type: ", "Section: "];
		return embedding
			.slice(0, embedding.indexOf("\n\n"))
			.split("\n")
			.filter((line) => !baseline.some((prefix) => line.startsWith(prefix)))
			.reduce((sum, line) => sum + line.length, 0);
	}

	it("hard-caps the added metadata prefix at 1500 chars by dropping whole lines", () => {
		const tag = "a".repeat(220);
		const alias = "b".repeat(220);
		const link = "c".repeat(220);
		const md = [
			"---",
			"title: Guard Note",
			`tags: [${Array.from({ length: 8 }, () => tag).join(", ")}]`,
			`aliases: [${Array.from({ length: 4 }, () => alias).join(", ")}]`,
			"---",
			"## Body",
			"",
			`See [[${link}]] and [[${link}2]] plus [[${link}3]] and [[${link}4]] cross-referenced in this sufficiently long body paragraph.`,
		].join("\n");
		const [chunk] = chunkMarkdown(md, "guard.md");
		const embedding = buildChunkEmbeddingText(chunk);
		expect(addedPrefixChars(embedding)).toBeLessThanOrEqual(1500);
		// Whole lines that fit stay; the first oversized line and everything after it are dropped.
		expect(embedding).toContain("Title: Guard Note");
		expect(embedding).not.toContain(`Tags: ${tag}`);
		expect(embedding).not.toContain(`Aliases: ${alias}`);
	});

	it("keeps the Formulas prefix line when math exists within the guard", () => {
		const md = [
			"---",
			"title: Math Note",
			"---",
			"## Formula",
			"",
			"The mass-energy relation below is the anchor formula for this whole section of notes.",
			"",
			"$$",
			"E = mc^2",
			"$$",
		].join("\n");
		const [chunk] = chunkMarkdown(md, "math.md");
		const embedding = buildChunkEmbeddingText(chunk);
		expect(embedding).toContain("Title: Math Note");
		expect(embedding).toContain("Formulas: $$ E = mc^2 $$");
		expect(addedPrefixChars(embedding)).toBeLessThanOrEqual(1500);
	});
});

describe("chunkText math protection", () => {
	it("keeps a $$ block with blank lines intact in a single chunk with formulas metadata", () => {
		const text = [
			"Opening paragraph with enough content to survive the fifty character minimum for text chunks.",
			"",
			"$$",
			"E = mc^2",
			"",
			"F = ma",
			"$$",
		].join("\n");
		const chunks = chunkText(text, "notes.txt");
		expect(chunks.length).toBeGreaterThan(0);
		const withBlock = chunks.filter((chunk) => chunk.content.includes("$$"));
		expect(withBlock).toHaveLength(1);
		expect(withBlock[0].content).toContain("$$\nE = mc^2\n\nF = ma\n$$");
		expect(JSON.parse(withBlock[0].metadata_json).formulas).toEqual(["$$\nE = mc^2\n\nF = ma\n$$"]);
	});
});

describe("chunkLaTeX", () => {
	const tex = [
		"\\documentclass{article}",
		"\\begin{document}",
		"",
		"Preamble context paragraph with enough content to pass the fifty character minimum threshold.",
		"",
		"\\chapter{Physics}",
		"",
		"Chapter introduction paragraph with enough content to pass the fifty character threshold here.",
		"",
		"\\section{Kinematics}",
		"",
		"Section body paragraph with enough content to pass the fifty character minimum threshold.",
		"",
		"\\begin{equation}",
		"E = mc^2",
		"",
		"v = u + at",
		"\\end{equation}",
		"",
		"\\label{eq:motion}",
		"Closing body paragraph with enough content to pass the fifty character minimum threshold.",
		"\\end{document}",
	].join("\n");

	it("routes .tex files through chunkFile as latex chunks", async () => {
		const chunks = await chunkFile(tex, "paper.tex");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.every((chunk) => chunk.file_type === "latex")).toBe(true);
	});

	it("splits preamble and sections with breadcrumbs and keeps equations intact", () => {
		const chunks = chunkLaTeX(tex, "paper.tex");
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		const preamble = chunks.find((chunk) => chunk.metadata_json.includes('"Preamble"'));
		expect(preamble).toBeDefined();
		const kinematics = chunks.find((chunk) => chunk.metadata_json.includes("Physics > Kinematics"));
		expect(kinematics).toBeDefined();
		const equationChunk = chunks.find((chunk) => chunk.content.includes("\\begin{equation}"));
		if (!equationChunk) throw new Error("expected an intact equation chunk");
		expect(equationChunk.content).toContain("E = mc^2\n\nv = u + at\n\\end{equation}");
		expect(JSON.parse(equationChunk.metadata_json).labels).toEqual(["eq:motion"]);
		expect(buildChunkEmbeddingText(equationChunk)).toContain("Labels: eq:motion");
	});

	it("falls back to a single chunk for tiny latex content", () => {
		const chunks = chunkLaTeX("\\documentclass{article}", "tiny.tex");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].file_type).toBe("latex");
	});
});

describe("chunkFile pdf sidecar threading", () => {
	const sidecarMarkdown = [
		"## Section One",
		"",
		"Mass-energy equivalence is written as $$E = mc^2$$ in display math notation for testing.",
		"",
		"## Section Two",
		"",
		"Additional prose making the second section long enough to pass the chunk threshold easily.",
	].join("\n");

	it("T1: markdown override on a .pdf keeps file_type pdf, threads converter metadata, and renders the Converter prefix", async () => {
		const chunks = await chunkFile(sidecarMarkdown, "paper.pdf", {
			fileTypeOverride: "markdown",
			extraMetadata: { converter: "marker" },
		});
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.file_type).toBe("pdf");
			expect(JSON.parse(chunk.metadata_json).converter).toBe("marker");
		}
		const first = JSON.parse(chunks[0].metadata_json);
		expect(first.breadcrumb).toBe("Section One");
		expect(buildChunkEmbeddingText(chunks[0])).toContain("Converter: marker");
	});

	it("T2: chunkFile on a .pdf without override is byte-identical to the chunkText fallback", async () => {
		const text = Array(15).fill("A paragraph with enough meaningful content for testing purposes here.").join("\n\n");
		const viaChunkFile = await chunkFile(text, "data.pdf");
		const viaChunkText = chunkText(text, "data.pdf");
		expect(viaChunkFile).toEqual(viaChunkText);
	});

	it("T3: chunkMarkdown default params reproduce existing behavior exactly", () => {
		const md = "## Heading\n\nContent for the heading that is long enough to pass the minimum threshold.";
		expect(chunkMarkdown(md, "note.md")).toEqual(chunkMarkdown(md, "note.md", "markdown", {}));
	});

	it("T4: latex override on a .pdf routes to chunkLaTeX (mechanism proof)", async () => {
		const latex =
			"\\section{Alpha}\n\nBody text about the alpha section that easily exceeds fifty characters in length.\n";
		const chunks = await chunkFile(latex, "paper.pdf", { fileTypeOverride: "latex" });
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].file_type).toBe("latex");
		expect(JSON.parse(chunks[0].metadata_json).breadcrumb).toBe("Alpha");
	});

	it("Amendment B: a non-routing extractor label does not demote extension-detected markdown routing", async () => {
		const md = "## Heading\n\nContent for the heading that is long enough to pass the minimum threshold.";
		// analyzeIndexableContent receives an extraction-level "text" label for a detected .md file.
		const analysis = await analyzeIndexableContent(md, "note.md", "text", { converter: "marker" });
		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("markdown");
		expect(JSON.parse(analysis.chunks[0].metadata_json).breadcrumb).toBe("Heading");
		expect(JSON.parse(analysis.chunks[0].metadata_json).converter).toBe("marker");
		// Same protection at the chunkFile layer for a direct non-routing override.
		const direct = await chunkFile(md, "note.md", { fileTypeOverride: "text", extraMetadata: { converter: "marker" } });
		expect(direct).toEqual(chunkMarkdown(md, "note.md", "markdown", { converter: "marker" }));
	});
});

describe("chunkMarkdown fence-aware headings", () => {
	it("ignores hash-heading lines inside fenced code (no split, no breadcrumb leak, fence stays atomic)", () => {
		const md = [
			"## Guide",
			"",
			"Intro paragraph that is long enough to pass the fifty character minimum threshold for chunks.",
			"",
			"```bash",
			"# This comment looks like a markdown heading but is shell syntax",
			"echo done",
			"```",
			"",
			"Closing paragraph that is also long enough to pass the fifty character minimum threshold.",
		].join("\n");
		const chunks = chunkMarkdown(md, "fence.md");
		expect(chunks).toHaveLength(1);
		const metadata = JSON.parse(chunks[0].metadata_json);
		expect(metadata.breadcrumb).toBe("Guide");
		expect(chunks[0].content).toContain("## Guide");
		// The fence stays atomic: open fence, comment, and close fence in one chunk.
		expect(chunks[0].content).toContain(
			"```bash\n# This comment looks like a markdown heading but is shell syntax\necho done\n```",
		);
	});

	it("keeps splitting on real headings after a fence closes (tilde fences included)", () => {
		const md = [
			"## One",
			"",
			"First section paragraph that is long enough to pass the fifty character threshold here.",
			"~~~",
			"# not a heading inside a tilde fence",
			"~~~",
			"Second section paragraph that is also long enough to pass the minimum chunk threshold.",
			"## Two",
			"",
			"Third section paragraph that is once again long enough to pass the minimum threshold.",
		].join("\n");
		const chunks = chunkMarkdown(md, "fence2.md");
		expect(chunks).toHaveLength(2);
		expect(JSON.parse(chunks[0].metadata_json).breadcrumb).toBe("One");
		expect(JSON.parse(chunks[1].metadata_json).breadcrumb).toBe("Two");
		expect(chunks[0].content).toContain("# not a heading inside a tilde fence");
		expect(chunks[1].content).not.toContain("~~~");
	});

	it("ignores hash-heading lines inside display math ($$ blocks and \\[..\\])", () => {
		const md = [
			"## Theory",
			"",
			"Opening paragraph that is long enough to pass the fifty character minimum threshold here.",
			"$$",
			"# \\text{this line starts with hash inside display math}",
			"E = mc^2 \\tag{1}",
			"$$",
			"Middle paragraph that is likewise long enough to pass the minimum chunk threshold.",
			"\\[",
			"# bracket-comment inside bracketed display math",
			"\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}",
			"\\]",
			"Closing paragraph that is once again long enough to pass the minimum chunk threshold.",
			"## Later",
			"",
			"Final section paragraph that is long enough to pass the fifty character threshold.",
		].join("\n");
		const chunks = chunkMarkdown(md, "mathfence.md");
		// Only ## Theory and ## Later are real headings; the two hash lines inside math stay put.
		expect(chunks).toHaveLength(2);
		expect(JSON.parse(chunks[0].metadata_json).breadcrumb).toBe("Theory");
		expect(JSON.parse(chunks[1].metadata_json).breadcrumb).toBe("Later");
		// Display math stays atomic (open + body + close in one chunk).
		expect(chunks[0].content).toContain("$$\n# \\text{this line starts with hash inside display math}\nE = mc^2");
		expect(chunks[0].content).toContain("\\int_0^\\infty");
	});

	it("does not latch math state on prose mentioning $$ or inline bracket notation", () => {
		const md = [
			"## Before",
			"",
			"First section paragraph that is long enough to pass the fifty character minimum threshold.",
			"In prose you can write: use `$$` to open a display block, or an inline \\[a+b\\] span.",
			"# The $$ operator is a heading here, not math — this line must split the section.",
			"Body paragraph after the fake heading, still long enough to pass the minimum chunk size.",
			"## After",
			"",
			"Closing paragraph that is also long enough to pass the fifty character minimum threshold.",
		].join("\n");
		const chunks = chunkMarkdown(md, "prose-money.md");
		// Prose `$$`/`\[` must not latch math state: the `#`-leading line IS a real heading and
		// splits the section — yielding Before | The $$ operator | After (NOT one merged lump).
		expect(chunks).toHaveLength(3);
		expect(JSON.parse(chunks[0].metadata_json).breadcrumb).toBe("Before");
		expect(JSON.parse(chunks[1].metadata_json).breadcrumb).toContain("The $$ operator");
		expect(JSON.parse(chunks[2].metadata_json).breadcrumb).toContain("After");
	});
});

describe("chunker line coordinates", () => {
	it("reports real start lines for markdown plain-text chunks emitted after a mid-section flush", () => {
		const para = (word: string) =>
			`${word} paragraph with enough content to easily pass every chunking threshold used here. `.repeat(10).trim();
		const md = ["## Big", "", para("Alpha"), "", para("Beta"), "", para("Gamma"), "", para("Delta")].join("\n");
		const chunks = chunkMarkdown(md, "coords.md");
		expect(chunks).toHaveLength(4);
		const [, second, third] = chunks;
		expect(second.start_line).toBe(5);
		expect(third.start_line).toBe(7);
		for (const chunk of chunks) {
			expect(chunk.end_line).toBe(9);
			expect(chunk.end_line).toBeGreaterThanOrEqual(chunk.start_line);
		}
	});

	it("reports inclusive end lines for plain-text chunks (k lines span start..start+k-1)", () => {
		const text = Array.from(
			{ length: 6 },
			(_, i) => `Line ${i + 1} of the plain text chunk end line test file content.`,
		).join("\n");
		const [chunk] = chunkText(text, "lines.txt");
		expect(chunk.content.split("\n")).toHaveLength(6);
		expect(chunk.start_line).toBe(1);
		expect(chunk.end_line).toBe(6);
	});

	it("oversized single-line paragraphs report single-line spans (inclusive end)", () => {
		const chunks = chunkText(`LongLineToken ${"x".repeat(8000)}`, "bigline.txt");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.map((chunk) => chunk.start_line)).toEqual([1, 2]);
		for (const chunk of chunks) {
			expect(chunk.end_line).toBe(chunk.start_line);
		}
	});

	it("oversized markdown text advances by raw slice line count and tiles the file inclusively", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `Line${i} ${"y".repeat(70)}`);
		const md = [
			"## Big",
			"",
			"Starter paragraph that is long enough to pass the fifty character minimum threshold.",
			"",
			lines.join("\n"),
		].join("\n");
		const chunks = chunkMarkdown(md, "biglines.md");
		expect(chunks).toHaveLength(2);
		let prevEnd = 0;
		for (const chunk of chunks) {
			expect(chunk.start_line).toBeGreaterThan(prevEnd);
			// Inclusive end: chunk span (end - start + 1) equals the content's real line count.
			expect(chunk.end_line - chunk.start_line + 1).toBe(chunk.content.split("\n").length);
			prevEnd = chunk.end_line;
		}
		// Slices tile the whole 104-line file; the mid-line char-slice boundary makes both
		// windows count the split file line, so the last slice reports 105 (104 + 1 slack).
		expect(chunks.at(-1)?.end_line).toBe(105);
	});

	it("keeps mid-section start lines exact after blank-line reconstruction", () => {
		const filler = (word: string) => `${word} ${word} ${word.repeat(700).trim()}`.slice(0, 3600).trimEnd();
		// k = 2 blanks after the heading: pre-fix hard-coded reconstruction reported [3, 5]
		// (drifted one line early); the real paragraphs live on lines 4 and 6. (k = 1 is the
		// fixed point of both implementations and cannot discriminate a regression.)
		const md = ["# H", "", "", filler("alpha"), "", filler("gamma")].join("\n");
		const chunks = chunkMarkdown(md, "gap.md");
		const mid = chunks.filter((chunk) => chunk.start_line > 1);
		expect(mid.map((chunk) => chunk.start_line)).toEqual([4, 6]);
	});

	it("anchors provenance to the oversized block itself, not the section end", () => {
		const oversizedPara = `oversized prefix ${"z".repeat(6500)}`.slice(0, 6800);
		const md = [
			"## H",
			"",
			oversizedPara.slice(0, 3250),
			oversizedPara.slice(3250),
			"",
			"First after paragraph. Extra text to pass the fifty character minimum threshold here.",
			"",
			"Second after paragraph. More text to pass the fifty character minimum threshold too.",
		].join("\n");
		const chunks = chunkMarkdown(md, "anchor.md");
		const starts = chunks.map((chunk) => chunk.start_line);
		// Chunk 1 = heading + first oversized slice (buffer nonempty → anchor is the heading's
		// line 1); slice 2 continues at 5. The post-oversized paragraphs must anchor to their
		// own lines 6 and 8 — the section-end default (9) leaked into provenance pre-fix.
		expect(starts).toEqual([1, 5, 6]); // last chunk spans First(6) → Second(8), endLine 8
		expect(starts).not.toContain(9);
	});
});
