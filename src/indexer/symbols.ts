import { extname } from "node:path";
import type { KnowledgeSymbolInsert } from "../storage/sqlite.ts";

type SymbolKind = KnowledgeSymbolInsert["kind"];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".env"]);
const TEX_EXTENSIONS = new Set([".tex", ".ltx", ".latex"]);
const LATEX_SECTION_DEPTHS: Record<string, number> = { chapter: 1, section: 2, subsection: 3, subsubsection: 4 };

function lineNumberAt(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (content.charCodeAt(i) === 10) line++;
	}
	return line;
}

function lineEnd(content: string, startLine: number, maxLines = 12): number {
	return Math.min(startLine + maxLines, content.split("\n").length);
}

function makeSymbol(
	name: string,
	kind: SymbolKind,
	filePath: string,
	fileType: string,
	startLine: number,
	options: {
		endLine?: number;
		containerName?: string;
		signature?: string;
		text?: string;
		metadata?: Record<string, string | number | boolean | null>;
	} = {},
): KnowledgeSymbolInsert | undefined {
	const trimmed = name.trim();
	if (!trimmed) return undefined;
	return {
		name: trimmed,
		kind,
		file_path: filePath,
		file_type: fileType,
		start_line: startLine,
		end_line: options.endLine ?? startLine,
		container_name: options.containerName ?? null,
		signature: options.signature ?? null,
		text: options.text ?? trimmed,
		metadata_json: JSON.stringify(options.metadata ?? {}),
	};
}

function pushSymbol(symbols: KnowledgeSymbolInsert[], symbol: KnowledgeSymbolInsert | undefined): void {
	if (symbol) symbols.push(symbol);
}

function extractMarkdownSymbols(content: string, filePath: string, fileType: string): KnowledgeSymbolInsert[] {
	const symbols: KnowledgeSymbolInsert[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
		if (!match) continue;
		pushSymbol(
			symbols,
			makeSymbol(match[2].replace(/\s+#*$/, ""), "heading", filePath, fileType, index + 1, {
				text: lines[index],
				metadata: { depth: match[1].length },
			}),
		);
	}
	return symbols;
}

function extractConfigSymbols(content: string, filePath: string, fileType: string): KnowledgeSymbolInsert[] {
	const symbols: KnowledgeSymbolInsert[] = [];
	const lines = content.split("\n");
	const ext = extname(filePath).toLowerCase();
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (ext === ".json") {
			const match = /^\s*"([^"]+)"\s*:/.exec(line);
			pushSymbol(
				symbols,
				match ? makeSymbol(match[1], "config_key", filePath, fileType, index + 1, { text: line.trim() }) : undefined,
			);
			continue;
		}
		if (ext === ".yaml" || ext === ".yml") {
			const match = /^\s*([A-Za-z0-9_.-]+)\s*:/.exec(line);
			pushSymbol(
				symbols,
				match ? makeSymbol(match[1], "config_key", filePath, fileType, index + 1, { text: line.trim() }) : undefined,
			);
			continue;
		}
		if (ext === ".toml") {
			const section = /^\s*\[+([A-Za-z0-9_.-]+)\]+/.exec(line);
			const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
			const name = section?.[1] ?? key?.[1];
			pushSymbol(
				symbols,
				name ? makeSymbol(name, "config_key", filePath, fileType, index + 1, { text: line.trim() }) : undefined,
			);
			continue;
		}
		const env = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		pushSymbol(
			symbols,
			env ? makeSymbol(env[1], "env_var", filePath, fileType, index + 1, { text: line.trim() }) : undefined,
		);
	}
	return symbols;
}

function extractCodeSymbols(content: string, filePath: string, fileType: string): KnowledgeSymbolInsert[] {
	const symbols: KnowledgeSymbolInsert[] = [];
	const patterns: Array<{ regex: RegExp; kind: SymbolKind; nameIndex: number }> = [
		{
			regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)/g,
			kind: "function",
			nameIndex: 1,
		},
		{ regex: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g, kind: "class", nameIndex: 1 },
		{ regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/g, kind: "interface", nameIndex: 1 },
		{ regex: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/g, kind: "type", nameIndex: 1 },
		{
			regex:
				/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
			kind: "function",
			nameIndex: 1,
		},
		{ regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g, kind: "variable", nameIndex: 1 },
		{ regex: /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\([^)]*\)/g, kind: "function", nameIndex: 1 },
		{ regex: /\btype\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/g, kind: "type", nameIndex: 1 },
		{ regex: /\bdef\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*:/g, kind: "function", nameIndex: 1 },
		{ regex: /\bclass\s+([A-Za-z_][\w]*)\b/g, kind: "class", nameIndex: 1 },
		{ regex: /\bfn\s+([A-Za-z_][\w]*)\s*\([^)]*\)/g, kind: "function", nameIndex: 1 },
		{ regex: /\b(?:struct|enum|trait)\s+([A-Za-z_][\w]*)\b/g, kind: "type", nameIndex: 1 },
	];

	const seen = new Set<string>();
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern.regex)) {
			const name = match[pattern.nameIndex];
			const index = match.index ?? 0;
			const startLine = lineNumberAt(content, index);
			const key = `${pattern.kind}:${name}:${startLine}`;
			if (seen.has(key)) continue;
			seen.add(key);
			pushSymbol(
				symbols,
				makeSymbol(name, pattern.kind, filePath, fileType, startLine, {
					endLine: lineEnd(content, startLine),
					signature: match[0].split("\n")[0].trim(),
					text: match[0].split("\n")[0].trim(),
				}),
			);
		}
	}
	return symbols;
}

function extractRouteSymbols(content: string, filePath: string, fileType: string): KnowledgeSymbolInsert[] {
	const symbols: KnowledgeSymbolInsert[] = [];
	const patterns: Array<{ regex: RegExp; methodIndex?: number; pathIndex: number; defaultMethod?: string }> = [
		{
			regex:
				/\b(?:app|router|route|server|api|hono)\s*\.\s*(get|post|put|patch|delete|del|options|head|all|use)\s*\(\s*["'`]([^"'`]+)["'`]/g,
			methodIndex: 1,
			pathIndex: 2,
		},
		{
			regex: /\b(?:http\.)?HandleFunc\s*\(\s*["'`]([^"'`]+)["'`]/g,
			pathIndex: 1,
			defaultMethod: "ANY",
		},
		{
			regex: /\b(?:http\.)?Handle\s*\(\s*["'`]([^"'`]+)["'`]/g,
			pathIndex: 1,
			defaultMethod: "ANY",
		},
	];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern.regex)) {
			const rawMethod = pattern.methodIndex ? match[pattern.methodIndex] : pattern.defaultMethod;
			const method = rawMethod === "del" ? "DELETE" : (rawMethod ?? "ANY").toUpperCase();
			const path = match[pattern.pathIndex];
			const index = match.index ?? 0;
			const startLine = lineNumberAt(content, index);
			const name = `${method} ${path}`;
			const key = `${name}:${startLine}`;
			if (seen.has(key)) continue;
			seen.add(key);
			pushSymbol(
				symbols,
				makeSymbol(name, "route", filePath, fileType, startLine, {
					signature: match[0].split("\n")[0].trim(),
					text: match[0].split("\n")[0].trim(),
					metadata: { method, path },
				}),
			);
		}
	}
	return symbols;
}

function extractLatexSymbols(content: string, filePath: string, fileType: string): KnowledgeSymbolInsert[] {
	const symbols: KnowledgeSymbolInsert[] = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const match = /^\\(chapter|section|subsection|subsubsection)\*?\s*\{(.+)\}\s*$/.exec(lines[index].trim());
		if (!match) continue;
		pushSymbol(
			symbols,
			makeSymbol(match[2].trim(), "heading", filePath, fileType, index + 1, {
				text: lines[index],
				metadata: { depth: LATEX_SECTION_DEPTHS[match[1]] },
			}),
		);
	}
	return symbols;
}

export function extractSymbols(content: string, filePath: string, fileType: string): KnowledgeSymbolInsert[] {
	const ext = extname(filePath).toLowerCase();
	const symbols: KnowledgeSymbolInsert[] = [];
	if (fileType === "markdown" || ext === ".md" || ext === ".mdx")
		symbols.push(...extractMarkdownSymbols(content, filePath, fileType));
	if (TEX_EXTENSIONS.has(ext)) symbols.push(...extractLatexSymbols(content, filePath, fileType));
	if (CONFIG_EXTENSIONS.has(ext) || filePath.split("/").pop()?.startsWith(".env")) {
		symbols.push(...extractConfigSymbols(content, filePath, fileType));
	}
	if (CODE_EXTENSIONS.has(ext) || ["typescript", "javascript", "python", "go", "rust", "java"].includes(fileType)) {
		symbols.push(...extractCodeSymbols(content, filePath, fileType));
		symbols.push(...extractRouteSymbols(content, filePath, fileType));
	}
	return symbols;
}
