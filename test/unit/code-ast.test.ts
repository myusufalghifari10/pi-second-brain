import { describe, expect, it } from "vitest";
import { analyzeIndexableContent, buildChunkEmbeddingText } from "../../src/indexer/chunker.ts";
import { analyzeCodeWithAST, chunkWithAST, parseCodeStructure } from "../../src/indexer/chunkers/code-ast.ts";

function metadata(chunk: { metadata_json: string }) {
	return JSON.parse(chunk.metadata_json) as Record<string, unknown>;
}

describe("AST code analysis", () => {
	it("uses chunk identity that includes file path and line metadata", async () => {
		const code = "export function same(): number { return 1; }";
		const [first] = await chunkWithAST(code, "src/a.ts", "typescript");
		const [second] = await chunkWithAST(code, "src/b.ts", "typescript");
		const [shifted] = await chunkWithAST(`\n${code}`, "src/a.ts", "typescript");

		expect(first.content).toBe(second.content);
		expect(first.content_hash).not.toBe(second.content_hash);
		expect(first.content).toBe(shifted.content);
		expect(metadata(shifted).start_line).toBe(2);
		expect(first.content_hash).not.toBe(shifted.content_hash);
	});

	it("keeps a small class coherent while retaining method symbols", async () => {
		const code = [
			"export class AuthenticationService {",
			"  authenticate(): boolean { return true; }",
			"  refreshToken(): string { return 'token'; }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/auth.ts", "typescript");
		const chunkMetadata = metadata(analysis.chunks[0]);

		expect(analysis.chunks).toHaveLength(1);
		expect(chunkMetadata.symbol).toBe("AuthenticationService");
		expect(chunkMetadata.symbol_kind).toBe("class");
		expect(analysis.symbols.map((symbol) => symbol.name)).toEqual([
			"AuthenticationService",
			"authenticate",
			"refreshToken",
		]);
		expect(analysis.symbols.find((symbol) => symbol.name === "refreshToken")?.container_name).toBe(
			"AuthenticationService",
		);
	});

	it("recursively splits oversized classes, packs small siblings, and bounds oversized leaves", async () => {
		const hugeBody = `return "${"x".repeat(7_000)}";`;
		const code = [
			"class LargeService {",
			`  hugeMethod(): string { ${hugeBody} }`,
			"  methodA(): number { return 1; }",
			"  methodB(): number { return 2; }",
			"  methodC(): number { return 3; }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/large.ts", "typescript");
		const allMetadata = analysis.chunks.map(metadata);

		expect(allMetadata.some((item) => item.symbol_kind === "class")).toBe(false);
		expect(allMetadata.filter((item) => item.symbol === "hugeMethod")).toHaveLength(2);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(allMetadata.some((item) => item.symbol_kind === "group" && Array.isArray(item.symbols))).toBe(true);
	});

	it("normalizes exported arrows, decorators, and class field methods", async () => {
		const code = [
			"@sealed",
			"export class DecoratedService {",
			"  run = async () => 'ok';",
			"}",
			"export const runUpdate = async () => 1;",
		].join("\n");

		const structure = await parseCodeStructure(code, "typescript");
		const analysis = await analyzeCodeWithAST(code, "src/decorated.ts", "typescript");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const classNode = structure.children.find((node) => node.name === "DecoratedService");

		expect(names).toContain("DecoratedService");
		expect(names).toContain("run");
		expect(names).toContain("runUpdate");
		expect(classNode?.exported).toBe(true);
		expect(classNode?.decorators).toEqual(["@sealed"]);
		expect(analysis.chunks.some((chunk) => metadata(chunk).symbol === "runUpdate")).toBe(true);
	});

	it("adds structural context to embedding text without changing returned content", async () => {
		const code = "class Auth { refreshToken(token: string): string { return token; } }";
		const analysis = await analyzeCodeWithAST(code, "src/auth.ts", "typescript");
		const chunk = analysis.chunks[0];
		const embeddingText = buildChunkEmbeddingText(chunk);

		expect(chunk.content).toBe(code);
		expect(embeddingText).toContain("Language: typescript");
		expect(embeddingText).toContain("Scope: Auth");
		expect(embeddingText).toContain("Kind: class");
		expect(embeddingText).toContain("Symbol: Auth");
	});

	it("extracts Bash function chunks and symbols", async () => {
		const code = [
			"build_package() {",
			'  local name="$1"',
			'  if [[ -n "$name" ]]; then',
			'    echo "$name"',
			"  fi",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "scripts/build.sh", "bash");
		const chunkMetadata = metadata(analysis.chunks[0]);

		expect(analysis.chunks).toHaveLength(1);
		expect(analysis.chunks[0].content).toBe(code);
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("build_package");
		expect(chunkMetadata.language).toBe("bash");
		expect(chunkMetadata.symbol).toBe("build_package");
		expect(chunkMetadata.symbol_kind).toBe("function");
		expect(chunkMetadata.signature).toBe("build_package()");
	});

	it("detects .sh files as Bash AST code", async () => {
		const analysis = await analyzeIndexableContent("run_service() { echo ok; }\n", "scripts/service.sh");

		expect(analysis.chunks[0].file_type).toBe("bash");
		expect(metadata(analysis.chunks[0]).language).toBe("bash");
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("run_service");
	});

	it("supports Bash function keyword declarations", async () => {
		const code = [
			"function deploy {",
			"  source ./env.sh",
			"  for target in prod; do",
			'    echo "$target"',
			"  done",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "scripts/deploy.bash", "bash");

		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("deploy");
		expect(metadata(analysis.chunks[0]).symbol).toBe("deploy");
	});

	it("bounds oversized Bash function fallback chunks", async () => {
		const code = ["build_package() {", `  echo "${"x".repeat(7_000)}"`, "}"].join("\n");
		const analysis = await analyzeCodeWithAST(code, "scripts/build.sh", "bash");
		const allMetadata = analysis.chunks.map(metadata);

		expect(analysis.chunks.length).toBeGreaterThan(1);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(allMetadata.every((item) => item.symbol === "build_package")).toBe(true);
		expect(allMetadata.some((item) => item.chunk_part === 1)).toBe(true);
	});

	it("falls back to text chunks for malformed Bash", async () => {
		const code = 'broken() {\n  if [[ -n "$name" ]]; then\n    echo "$name"\n';
		const analysis = await analyzeIndexableContent(code, "scripts/broken.sh");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("bash");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("extracts GNU C functions, types, enums, typedefs, and macros", async () => {
		const code = [
			"#define MAX_ITEMS 16",
			"",
			"typedef struct wl_connection {",
			"  int fd;",
			"  unsigned flags;",
			"} wl_connection;",
			"",
			"enum state { STATE_INIT, STATE_READY };",
			"",
			"static int handle_event(struct wl_connection *conn, int event) {",
			"  if (__builtin_expect(event > 0, 1)) {",
			"    return conn->fd + event;",
			"  }",
			"  return -1;",
			"}",
			"",
			"int initialize(struct wl_connection *conn);",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/protocol.c", "c");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const handleEvent = analysis.symbols.find((symbol) => symbol.name === "handle_event");
		const handleMetadata = handleEvent ? metadata(handleEvent) : {};

		expect(names).toContain("MAX_ITEMS");
		expect(names).toContain("wl_connection");
		expect(names).toContain("state");
		expect(names).toContain("handle_event");
		expect(names).toContain("initialize");
		expect(handleEvent?.kind).toBe("function");
		expect(handleMetadata.static).toBe(true);
		expect(analysis.chunks.some((chunk) => metadata(chunk).language === "c")).toBe(true);
	});

	it("detects .c files while leaving ambiguous .h headers conservative", async () => {
		const cAnalysis = await analyzeIndexableContent("int initialize(void) { return 0; }\n", "src/init.c");
		const headerAnalysis = await analyzeIndexableContent("int initialize(void);\n", "include/init.h");

		expect(cAnalysis.chunks[0].file_type).toBe("c");
		expect(cAnalysis.symbols.map((symbol) => symbol.name)).toContain("initialize");
		expect(headerAnalysis.chunks[0].file_type).toBe("text");
		expect(metadata(headerAnalysis.chunks[0]).language).toBeUndefined();
	});

	it("bounds oversized C function fallback chunks", async () => {
		const code = ["int handle_event(void) {", `  return ${"1 + ".repeat(2_000)}0;`, "}"].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/protocol.c", "c");
		const allMetadata = analysis.chunks.map(metadata);

		expect(analysis.chunks.length).toBeGreaterThan(1);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
		expect(allMetadata.every((item) => item.symbol === "handle_event")).toBe(true);
	});

	it("falls back to text chunks for malformed C", async () => {
		const code = "int handle_event(void) {\n  if (\n";
		const analysis = await analyzeIndexableContent(code, "src/broken.c");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("c");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("extracts C++ namespaces, classes, methods, templates, enums, and implementations", async () => {
		const code = [
			"namespace App {",
			"class MainWindow {",
			"public:",
			"  MainWindow();",
			"  ~MainWindow();",
			"  void openFile();",
			"};",
			"",
			"enum Mode { Read, Write };",
			"",
			"template <typename T>",
			"T identity(T value) { return value; }",
			"",
			"MainWindow::MainWindow() {}",
			"MainWindow::~MainWindow() {}",
			"void MainWindow::openFile() {}",
			"void handle_event(int event) {}",
			"}",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/main.cpp", "cpp");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const openFile = analysis.symbols.find((symbol) => symbol.name === "openFile");
		const implementation = analysis.symbols.find((symbol) => symbol.name === "MainWindow::openFile");
		const classChunk = analysis.chunks.find((chunk) => metadata(chunk).symbol === "MainWindow");

		expect(names).toContain("App");
		expect(names).toContain("MainWindow");
		expect(names).toContain("~MainWindow");
		expect(names).toContain("openFile");
		expect(names).toContain("MainWindow::MainWindow");
		expect(names).toContain("MainWindow::~MainWindow");
		expect(names).toContain("MainWindow::openFile");
		expect(names).toContain("Mode");
		expect(names).toContain("identity");
		expect(names).toContain("handle_event");
		expect(metadata(openFile ?? { metadata_json: "{}" }).visibility).toBe("public");
		expect(metadata(implementation ?? { metadata_json: "{}" }).parent_symbol).toBe("MainWindow");
		expect(classChunk).toBeDefined();
		expect(metadata(classChunk ?? { metadata_json: "{}" }).language).toBe("cpp");
	});

	it("detects C++ source and header extensions while keeping .h conservative", async () => {
		const sourceAnalysis = await analyzeIndexableContent("void run_service() {}\n", "src/service.cc");
		const headerAnalysis = await analyzeIndexableContent("class Service { void run(); };\n", "include/service.hpp");
		const ambiguousHeader = await analyzeIndexableContent("void run_service(void);\n", "include/service.h");

		expect(sourceAnalysis.chunks[0].file_type).toBe("cpp");
		expect(sourceAnalysis.symbols.map((symbol) => symbol.name)).toContain("run_service");
		expect(headerAnalysis.chunks[0].file_type).toBe("cpp");
		expect(headerAnalysis.symbols.map((symbol) => symbol.name)).toContain("Service");
		expect(ambiguousHeader.chunks[0].file_type).toBe("text");
	});

	it("recursively splits oversized C++ classes into methods", async () => {
		const code = [
			"class LargeService {",
			"public:",
			`  int hugeMethod() { return ${"1 + ".repeat(2_000)}0; }`,
			"  int smallMethod() { return 1; }",
			"};",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "src/large.cpp", "cpp");
		const allMetadata = analysis.chunks.map(metadata);

		expect(allMetadata.some((item) => item.symbol_kind === "class")).toBe(false);
		expect(allMetadata.some((item) => item.symbol === "hugeMethod")).toBe(true);
		expect(allMetadata.some((item) => item.symbol === "smallMethod")).toBe(true);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
	});

	it("falls back to text chunks for Qt macro C++ parser errors", async () => {
		const code = [
			"class MainWindow : public QWidget {",
			"  Q_OBJECT",
			"public:",
			"  MainWindow();",
			"signals:",
			"  void opened(QString path);",
			"private slots:",
			"  void onWaylandEvent(int event);",
			"};",
		].join("\n");
		const analysis = await analyzeIndexableContent(code, "include/MainWindow.hpp");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("cpp");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("extracts QML component hierarchy, properties, signals, handlers, ids, imports, and functions", async () => {
		const code = [
			"import QtQuick 2.15",
			"ApplicationWindow {",
			"  id: root",
			"  property bool sidebarVisible: true",
			"  signal opened(string path)",
			"  ListView {",
			"    id: documentList",
			"    delegate: Item {",
			"      property string title: model.title",
			"      function openDocument(path) {",
			"        root.opened(path)",
			"      }",
			"      onVisibleChanged: console.log(visible)",
			"    }",
			"  }",
			"}",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "ui/Main.qml", "qml");
		const names = analysis.symbols.map((symbol) => symbol.name);
		const openDocument = analysis.symbols.find((symbol) => symbol.name === "openDocument");
		const handler = analysis.symbols.find((symbol) => symbol.name === "onVisibleChanged");

		expect(names).toContain("QtQuick");
		expect(names).toContain("ApplicationWindow");
		expect(names).toContain("root");
		expect(names).toContain("sidebarVisible");
		expect(names).toContain("opened");
		expect(names).toContain("ListView");
		expect(names).toContain("documentList");
		expect(names).toContain("delegate");
		expect(names).toContain("Item");
		expect(names).toContain("title");
		expect(names).toContain("openDocument");
		expect(names).toContain("onVisibleChanged");
		expect(metadata(openDocument ?? { metadata_json: "{}" }).parent_symbol).toBe("Item");
		expect(metadata(handler ?? { metadata_json: "{}" }).symbol_kind).toBe("handler");
		expect(metadata(analysis.chunks[0]).language).toBe("qml");
	});

	it("detects .qml files as QML AST code", async () => {
		const analysis = await analyzeIndexableContent("Item { id: root; property string title: 'Demo' }\n", "ui/Item.qml");

		expect(analysis.chunks[0].file_type).toBe("qml");
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("root");
		expect(analysis.symbols.map((symbol) => symbol.name)).toContain("title");
	});

	it("recursively splits oversized QML components", async () => {
		const code = [
			"ApplicationWindow {",
			"  Item {",
			`    property string hugeText: "${"x".repeat(7_000)}"`,
			"  }",
			"  function openDocument(path) { return path }",
			"}",
		].join("\n");
		const analysis = await analyzeCodeWithAST(code, "ui/Large.qml", "qml");
		const allMetadata = analysis.chunks.map(metadata);

		expect(allMetadata.some((item) => item.symbol === "ApplicationWindow")).toBe(false);
		expect(allMetadata.some((item) => item.symbol === "hugeText")).toBe(true);
		expect(allMetadata.some((item) => item.symbol === "openDocument")).toBe(true);
		expect(analysis.chunks.every((chunk) => chunk.content.length <= 6_000)).toBe(true);
	});

	it("falls back to text chunks for malformed QML", async () => {
		const code = "ApplicationWindow {\n  property bool visible:\n";
		const analysis = await analyzeIndexableContent(code, "ui/Broken.qml");

		expect(analysis.chunks.length).toBeGreaterThan(0);
		expect(analysis.chunks[0].file_type).toBe("qml");
		expect(metadata(analysis.chunks[0]).language).toBeUndefined();
	});

	it("loads the tree-sitter baseline for every supported AST language", async () => {
		const cases = [
			{
				language: "typescript",
				filePath: "src/service.ts",
				code: "export class Service { run(): number { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "javascript",
				filePath: "src/service.js",
				code: "export class Service { run() { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "python",
				filePath: "service.py",
				code: "class Service:\n    def run(self):\n        return 1\n",
				symbols: ["Service", "run"],
			},
			{
				language: "go",
				filePath: "service.go",
				code: "package service\nfunc Run() int { return 1 }\n",
				symbols: ["Run"],
			},
			{
				language: "rust",
				filePath: "service.rs",
				code: "pub fn run() -> i32 { 1 }\n",
				symbols: ["run"],
			},
			{
				language: "java",
				filePath: "Service.java",
				code: "class Service { int run() { return 1; } }",
				symbols: ["Service", "run"],
			},
			{
				language: "bash",
				filePath: "scripts/service.sh",
				code: "run_service() { echo ok; }\n",
				symbols: ["run_service"],
			},
			{
				language: "c",
				filePath: "src/service.c",
				code: "int run_service(void) { return 0; }\n",
				symbols: ["run_service"],
			},
			{
				language: "cpp",
				filePath: "src/service.cpp",
				code: "class Service { public: void run() {} };\n",
				symbols: ["Service", "run"],
			},
			{
				language: "qml",
				filePath: "ui/Service.qml",
				code: "Item { id: root; function run() { return 1 } }\n",
				symbols: ["Item", "root", "run"],
			},
		];

		for (const item of cases) {
			const analysis = await analyzeCodeWithAST(item.code, item.filePath, item.language);
			const names = analysis.symbols.map((symbol) => symbol.name);

			expect(analysis.chunks.length, item.language).toBeGreaterThan(0);
			for (const symbol of item.symbols) expect(names, item.language).toContain(symbol);
			expect(metadata(analysis.chunks[0]).language).toBe(item.language);
		}
	});

	it("keeps annotated python signatures intact up to the terminating colon", async () => {
		const code = ["import os", "def scale(value: int, factor: float = 1.0):", "    return value * factor"].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/scale.py", "python");
		const fn = analysis.symbols.find((symbol) => symbol.name === "scale");
		// first-colon matching cut annotated params ("def scale(value"); the terminating
		// colon is the first colon at paren depth 0.
		expect(fn?.signature).toBe("def scale(value: int, factor: float = 1.0):");
	});

	it("cuts python class signatures at the header colon instead of flattening the body", async () => {
		const code = [
			"class Widget:",
			"    def __init__(self):",
			"        self.x = 1",
			"",
			"    def render(self) -> str:",
			"        return 'widget'",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/widget.py", "python");
		const cls = analysis.symbols.find((symbol) => symbol.name === "Widget");
		// Brace-less class headers have no "{" to cut at: pre-fix the signature (and the
		// symbol.text derived from it) collapsed the whole class body into one string.
		expect(cls?.signature).toBe("class Widget:");
		expect(cls?.text).toBe("class Widget:");
	});

	it("keeps non-python class signatures on the brace-cut path", async () => {
		// Regression pins for the round-20 blocker: the python colon-cutter must never see
		// TS/JS/C++ classes (bare `class` keyword exists in those languages too).
		const ts = await analyzeCodeWithAST(
			["class Auth {", "  refreshToken(token: string): string { return token; }", "}"].join("\n"),
			"src/auth.ts",
			"typescript",
		);
		expect(ts.symbols.find((symbol) => symbol.name === "Auth")?.signature).toBe("class Auth");

		const cpp = await analyzeCodeWithAST(
			["class MainWindow {", "public:", "  void openFile();", "};"].join("\n"),
			"src/main.cpp",
			"cpp",
		);
		expect(cpp.symbols.find((symbol) => symbol.name === "MainWindow")?.signature).toBe("class MainWindow");
	});

	it("routes decorated python defs and classes through the colon cut", async () => {
		const code = [
			"import functools",
			"@dataclass",
			"class Point:",
			"    x: int = 0",
			"",
			"@functools.cache",
			"def sample():",
			"    return Point()",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/point.py", "python");
		// The decorated_definition wrapper starts with '@' — the header sniff must skip
		// decorator lines, or these fall into the brace-cut path and flatten the body.
		expect(analysis.symbols.find((symbol) => symbol.name === "Point")?.signature).toBe("class Point:");
		expect(analysis.symbols.find((symbol) => symbol.name === "sample")?.signature).toBe("def sample():");
	});

	it("ignores colons and brackets inside quoted string defaults", async () => {
		const code = ['def render(sep="):"):', "    return sep"].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/render.py", "python");
		// The ')' and ':' inside the string default must not reset depth or terminate the
		// header early; the signature keeps the full header through its real terminator.
		expect(analysis.symbols.find((symbol) => symbol.name === "render")?.signature).toBe('def render(sep="):"):');
	});

	it("routes multi-line-wrapped python decorators through the colon cut", async () => {
		const code = [
			"import pytest",
			"@pytest.mark.parametrize(",
			'    ("a", "b"),',
			"    [(1, 2)],",
			")",
			"def add(a, b):",
			"    return a + b",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/add.py", "python");
		// The header line sits BELOW the wrapped decorator arguments — the sniff must find
		// the def line directly, not merely skip leading @-lines.
		expect(analysis.symbols.find((symbol) => symbol.name === "add")?.signature).toBe("def add(a, b):");
	});

	it("indexes members inside TypeScript namespaces and modules", async () => {
		const code = [
			"export function top(): number { return 0; }",
			"export namespace Util {",
			"  export function helper(): number { return 1; }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/util.ts", "typescript");
		const names = analysis.symbols.map((symbol) => symbol.name);
		// internal_module bodies were never descended pre-fix: helper landed in NO chunk and
		// NO symbol (silent index hole) in any mixed file.
		expect(names).toContain("Util");
		expect(names).toContain("helper");
		expect(analysis.chunks.some((chunk) => chunk.content.includes("return 1"))).toBe(true);
	});

	it("names Go type declarations from their spec children", async () => {
		const code = ["package main", "", "type Point struct {", "\tX int", "}", "", "type Meters int"].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/point.go", "go");
		const names = analysis.symbols.map((symbol) => symbol.name);
		// type_declaration has no name field: pre-fix every Go type node was unnamed →
		// no symbol row and metadata symbol degraded to the literal "type".
		expect(names).toContain("Point");
		expect(names).toContain("Meters");
	});

	it("kinds C++ namespace free prototypes as functions and struct fn-pointers as data", async () => {
		const code = ["namespace App {", "  void bar();", "}", "struct S {", "  int (*cb)(int);", "};"].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/mixed.cpp", "cpp");
		const parsed = analysis.chunks.map((chunk) => JSON.parse(chunk.metadata_json));
		const kindOf = (name: string) => parsed.find((meta) => meta.symbol === name)?.symbol_kind;
		expect(kindOf("bar")).toBe("function"); // was "method" pre-fix (declaration+parentSymbol)
		// The tree-sitter-c alias makes the TOP-level declarator of `int (*cb)(int);` a
		// function_declarator (parenthesized inner) — assert on SYMBOLS, not just chunks:
		// cb must not appear as a function symbol (pre-fix it did).
		const cbSymbol = analysis.symbols.find((symbol) => symbol.name === "cb");
		expect(cbSymbol).toBeUndefined();
	});

	it("covers C++ template headers in the chunk span", async () => {
		const code = ["template <typename T>", "T identity(T value) { return value; }"].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/identity.cpp", "cpp");
		const chunk = analysis.chunks.find((c) => c.content.includes("identity"));
		expect(chunk?.content).toContain("template <typename T>"); // header line was uncovered pre-fix
		expect(chunk?.start_line).toBe(1);
	});

	it("covers nested C++ template headers with the outermost span", async () => {
		const code = [
			"template <typename T>",
			"template <typename U>",
			"U Worker<T>::convert(U value) { return value; }",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/worker.cpp", "cpp");
		const chunk = analysis.chunks.find((c) => c.content.includes("convert"));
		expect(chunk?.content).toContain("template <typename T>"); // outer header was uncovered pre-fix
		expect(chunk?.start_line).toBe(1);
	});

	it("strips quotes from TS ambient module names", async () => {
		const code = ['declare module "left-pad" {', "  export function pad(s: string, n: number): string;", "}"].join(
			"\n",
		);

		const analysis = await analyzeCodeWithAST(code, "src/types.d.ts", "typescript");
		// Pre-fix the name kept the literal quotes: \"left-pad\" with quote chars, breaking
		// exact symbol lookup for left-pad.
		expect(analysis.symbols.some((symbol) => symbol.name === "left-pad")).toBe(true);
	});

	it("gives multi-declarator exports per-declarator spans", async () => {
		const code = ["export const a = () => 1, b = () => 2;"].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/multi.ts", "typescript");
		const contents = analysis.chunks.map((chunk) => chunk.content);
		// Pre-fix both declarator nodes inherited the whole export statement span → two
		// duplicate-content chunks. Post-fix: per-declarator spans or one packed group —
		// either way NO identical-content duplicates.
		expect(new Set(contents).size).toBe(contents.length);
	});

	it("indexes Java records and their compact constructors", async () => {
		const code = [
			"public record Point(int x, int y) {",
			"  public Point {",
			"    if (x < 0) throw new IllegalArgumentException();",
			"  }",
			"}",
		].join("\n");

		const analysis = await analyzeCodeWithAST(code, "src/Point.java", "java");
		const names = analysis.symbols.map((symbol) => symbol.name);
		expect(names).toContain("Point");
		expect(names).toContain("constructor");
	});

	it("splits the pack buffer when draft-less gaps would blow the span budget", async () => {
		const gapLiteral =
			"const GAP_DATA = [\n" +
			Array.from({ length: 400 }, (_, i) => `  "item-${i}-xxxxxxxxxxxxxxx",`).join("\n") +
			"\n];\n";
		const code = [
			"export function beforeGap(): number { return 1; }",
			gapLiteral,
			"export function afterGap(): number { return 2; }",
		].join("\n");

		const chunks = await chunkWithAST(code, "src/gap.ts", "typescript");
		const texts = chunks.map((chunk) => chunk.content);
		// Both functions are packable with the same packKey, but the >6KB draft-less gap
		// must split the pack: no emitted chunk may contain both functions nor exceed the
		// 6,000-char span budget the other AST paths enforce.
		expect(texts.some((text) => text.includes("beforeGap") && text.includes("afterGap"))).toBe(false);
		expect(texts.every((text) => text.length <= 6200)).toBe(true);
	});
});
