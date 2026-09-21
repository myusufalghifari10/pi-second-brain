#!/usr/bin/env node
// MCP stdio surface for pi-second-brain.
//
// The Pi extension (index.ts) is the native front door; this file is the second front door that
// lets every MCP-capable harness (Claude Code, Codex, Cline, Cursor, Gemini CLI, OpenCode, ...)
// drive the SAME engine, the SAME storage (~/.pi/knowledge), and the SAME 13 knowledge_* tools.
// Tool definitions AND the runtime lifecycle are collected from the extension factory itself via
// a shim host, so both surfaces can never drift: one definition, one runtime owner, two
// transports.
//
// Startup stays light: no engine import happens until the first tool call triggers the captured
// session_start lifecycle (which is exactly the extension's session_start contract, including
// PI_KNOWLEDGE_WATCH watcher startup). Shutdown calls the captured session_shutdown lifecycle on
// SIGINT/SIGTERM/transport close, which fully disposes the engine (model worker killed, ONNX
// memory reclaimed) per the documented contract.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import createExtension, { type ExtensionAPI, type ToolDefinition } from "../index.ts";

const MCP_SERVER_NAME = "pi-second-brain";
const SERVER_INSTRUCTIONS = [
	"pi-second-brain: a local-first RAG knowledge base (SQLite + FTS5 + local ONNX embeddings).",
	"Start with knowledge_show/knowledge_status to see what is indexed; search with knowledge_search (hybrid is the default mode; fast for exact symbols and numbers);",
	"use knowledge_symbol_search before broad search for exact code symbols/config keys/env vars;",
	"use knowledge_plan before broad knowledge_add on directories that may contain private or low-signal files.",
].join(" ");

function packageVersion(): string {
	try {
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			version?: string;
		};
		return manifest.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

type LifecycleHandler = (event: unknown, ctx: unknown) => unknown;

// Collect the tool definitions and lifecycle hooks from the extension factory through a shim
// host. The factory only registers definitions and hooks here (no engine import happens at
// registration time), so this is cheap and keeps index.ts the single source of truth for names,
// descriptions, schemas, behavior, and the runtime lifecycle.
export function collectExtensionSurface(): {
	tools: ToolDefinition[];
	sessionStart?: LifecycleHandler;
	sessionShutdown?: LifecycleHandler;
} {
	const tools: ToolDefinition[] = [];
	let sessionStart: LifecycleHandler | undefined;
	let sessionShutdown: LifecycleHandler | undefined;
	const host: ExtensionAPI = {
		on: (event: string, handler: unknown) => {
			if (event === "session_start") sessionStart = handler as LifecycleHandler;
			if (event === "session_shutdown") sessionShutdown = handler as LifecycleHandler;
		},
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	createExtension(host);
	return { tools, sessionStart, sessionShutdown };
}

// Pi's schema dialect stores literal unions as { const: "x" }; MCP clients are happiest with
// { type, enum: ["x"] }. Normalize recursively and drop the internal `optional` marker.
export function normalizeJsonSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map((item) => normalizeJsonSchema(item));
	if (!schema || typeof schema !== "object") return schema;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
		if (key === "optional") continue;
		if (key === "const") {
			out.type = typeof value === "string" ? "string" : "number";
			out.enum = [value];
			continue;
		}
		out[key] = normalizeJsonSchema(value);
	}
	return out;
}

function toMcpTool(tool: ToolDefinition) {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: normalizeJsonSchema(tool.parameters) as {
			type: "object";
			properties?: Record<string, unknown>;
			required?: string[];
		},
		annotations:
			tool.approval === "write"
				? { readOnlyHint: false, destructiveHint: true }
				: { readOnlyHint: true, destructiveHint: false },
	};
}

export async function createMcpServer(): Promise<Server> {
	const { tools, sessionStart, sessionShutdown } = collectExtensionSurface();
	let sessionStarted = false;
	const ensureSession = async (): Promise<void> => {
		if (sessionStarted) return;
		sessionStarted = true;
		try {
			if (sessionStart) await sessionStart(undefined, undefined);
		} catch {
			// Tool bodies surface engine failures themselves; a failed warm-up (for example a bad
			// storage path) must not take down the server before the tool can report it.
			sessionStarted = false;
		}
	};
	const server = new Server(
		{ name: MCP_SERVER_NAME, version: packageVersion() },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(toMcpTool) }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
		}
		if (!tool.execute) {
			return { content: [{ type: "text", text: `Tool ${name} has no executor` }], isError: true };
		}
		try {
			await ensureSession();
			const result = await tool.execute(name, (args ?? {}) as Record<string, unknown>, undefined, undefined, undefined);
			return { content: result.content, isError: result.isError === true };
		} catch (error) {
			return {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				isError: true,
			};
		}
	});
	server.onclose = () => {
		if (sessionStarted && sessionShutdown) void sessionShutdown(undefined, undefined);
	};
	return server;
}

export async function runStdioServer(): Promise<void> {
	const server = await createMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			server.onclose?.();
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	// Direct `node dist/src/mcp-server.js` execution (the CLI normally wraps this).
	void runStdioServer();
}
