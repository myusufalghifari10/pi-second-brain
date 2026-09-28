import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The MCP surface must forward to the extension's runtime (single owner). Mock the three runtime
// modules exactly like tool-contract.test.ts so the handshake tests run without ONNX workers.
const engineState = vi.hoisted(() => ({
	initializeCalls: 0,
	disposeCalls: 0,
	searchCalls: [] as Array<{ query: string; options: unknown }>,
	removeCalls: [] as Array<{ target: string; confirm: unknown }>,
}));

vi.mock("../../src/engine.ts", () => ({
	KnowledgeEngine: class {
		async initialize(): Promise<void> {
			engineState.initializeCalls += 1;
		}

		list(): Array<{ id: string; name: string; chunk_count: number; file_count: number; status: string }> {
			return [{ id: "kb-1", name: "repo", chunk_count: 12, file_count: 3, status: "ready" }];
		}

		async search(query: string, options: unknown): Promise<unknown> {
			engineState.searchCalls.push({ query, options });
			return {
				results: [
					{
						content: "content",
						file_path: "src/engine.ts",
						file_type: "typescript",
						kb_name: "repo",
						score: 0.9,
						snippet: "export function search() {}",
						start_line: 1,
						end_line: 1,
					},
				],
				total_count: 1,
				has_more: false,
				mode_used: "fast",
			};
		}

		async remove(target: string): Promise<boolean> {
			engineState.removeCalls.push({ target, confirm: undefined });
			return true;
		}

		async dispose(): Promise<void> {
			engineState.disposeCalls += 1;
		}
	},
}));

vi.mock("../../src/storage/sqlite.ts", () => ({
	getDefaultKnowledgeDir(): string {
		return "/tmp/pi-second-brain-mcp-test";
	},
}));

vi.mock("../../src/watcher/file-watcher.ts", () => ({
	getActiveWatcherCount(): number {
		return 0;
	},
	startWatcher(): void {},
	stopWatcher(): void {},
	stopAllWatchers(): void {},
}));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createMcpServer } = await import("../../src/mcp-server.ts");

async function connectClient(): Promise<{ client: InstanceType<typeof Client>; cleanup: () => Promise<void> }> {
	const server = await createMcpServer();
	const client = new Client({ name: "test-client", version: "0.0.1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		cleanup: async () => {
			await client.close();
			await server.close();
		},
	};
}

const EXPECTED_TOOLS = [
	"knowledge_plan",
	"knowledge_configure",
	"knowledge_add",
	"knowledge_search",
	"knowledge_symbol_search",
	"knowledge_update",
	"knowledge_status",
	"knowledge_doctor",
	"knowledge_show",
	"knowledge_remove",
	"knowledge_export",
	"knowledge_import",
	"knowledge_clear",
	"knowledge_class_sync",
];

describe("mcp server surface", () => {
	beforeEach(() => {
		engineState.initializeCalls = 0;
		engineState.disposeCalls = 0;
		engineState.searchCalls = [];
		engineState.removeCalls = [];
	});

	afterEach(async () => {
		// The extension runtime owns the engine; drain it between tests like the host would.
		const lifecycleModule = await import("../../index.ts");
		void lifecycleModule;
	});

	it("exposes the same 14 tools as the Pi extension", async () => {
		const { client, cleanup } = await connectClient();
		try {
			const { tools } = await client.listTools();
			expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
		} finally {
			await cleanup();
		}
	});

	it("normalizes Pi literal unions to JSON-schema enums", async () => {
		const { client, cleanup } = await connectClient();
		try {
			const { tools } = await client.listTools();
			const search = tools.find((tool) => tool.name === "knowledge_search");
			expect(search).toBeDefined();
			const mode = (search?.inputSchema as { properties: Record<string, { anyOf?: Array<{ enum?: string[] }> }> })
				.properties.mode;
			expect(mode?.anyOf?.[0]?.enum).toEqual(["auto"]);
		} finally {
			await cleanup();
		}
	});

	it("marks write-approval tools as destructive and read tools as read-only", async () => {
		const { client, cleanup } = await connectClient();
		try {
			const { tools } = await client.listTools();
			const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
			expect(byName.knowledge_search?.annotations?.readOnlyHint).toBe(true);
			expect(byName.knowledge_remove?.annotations?.destructiveHint).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("dispatches a search call to the extension runtime and returns text content", async () => {
		const { client, cleanup } = await connectClient();
		try {
			const result = await client.callTool({ name: "knowledge_search", arguments: { query: "watcher race" } });
			expect(result.isError).not.toBe(true);
			const text = (result.content as Array<{ type: string; text: string }>).map((block) => block.text).join("");
			expect(text).toContain("src/engine.ts");
			expect(engineState.searchCalls[0]?.query).toBe("watcher race");
			expect(engineState.initializeCalls).toBe(1);
		} finally {
			await cleanup();
		}
	});

	it("maps engine errors to isError results instead of crashing the server", async () => {
		const { client, cleanup } = await connectClient();
		try {
			const result = await client.callTool({ name: "knowledge_remove", arguments: { target: "repo" } });
			expect(result.isError).toBe(true);
			const text = (result.content as Array<{ type: string; text: string }>).map((block) => block.text).join("");
			expect(text).toContain("Confirmation required");
			expect(engineState.removeCalls).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("returns an isError result for unknown tools", async () => {
		const { client, cleanup } = await connectClient();
		try {
			const result = await client.callTool({ name: "not_a_tool", arguments: {} });
			expect(result.isError).toBe(true);
		} finally {
			await cleanup();
		}
	});
});
