import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServerEntry, stripTomlServer, upsertJsonMcpServer, upsertTomlServer } from "../../src/cli.ts";

describe("cli server entry", () => {
	it("launches this CLI in mcp mode via the current node binary", () => {
		const entry = buildServerEntry();
		expect(entry.command).toBe(process.execPath);
		expect(entry.args[0]).toMatch(/cli\.(ts|js)$/);
		expect(entry.args[1]).toBe("mcp");
	});
});

describe("codex toml registration", () => {
	it("appends a server block to empty content", () => {
		const next = upsertTomlServer("", "pi-second-brain", { command: "/usr/bin/node", args: ["/x/cli.js", "mcp"] });
		expect(next).toContain("[mcp_servers.pi-second-brain]");
		expect(next).toContain('command = "/usr/bin/node"');
		expect(next).toContain('args = ["/x/cli.js", "mcp"]');
	});

	it("replaces an existing block without duplicating it", () => {
		const initial = upsertTomlServer("", "pi-second-brain", { command: "/old/node", args: ["/old.js", "mcp"] });
		const other = `[mcp_servers.keep-me]\ncommand = "/keep"\n\n${initial}`;
		const next = upsertTomlServer(other, "pi-second-brain", { command: "/new/node", args: ["/new.js", "mcp"] });
		expect((next.match(/\[mcp_servers\.pi-second-brain\]/g) ?? []).length).toBe(1);
		expect(next).toContain('command = "/new/node"');
		expect(next).not.toContain("/old/node");
		expect(next).toContain("[mcp_servers.keep-me]");
		expect(next).toContain('command = "/keep"');
	});

	it("strips only its own block on remove", () => {
		const initial = upsertTomlServer('[mcp_servers.other]\ncommand = "/keep"\n', "pi-second-brain", {
			command: "/usr/bin/node",
			args: ["/x/cli.js", "mcp"],
		});
		const next = stripTomlServer(initial, "pi-second-brain");
		expect(next).not.toContain("pi-second-brain");
		expect(next).toContain('command = "/keep"');
		expect(stripTomlServer(next, "pi-second-brain")).toBe(next);
	});
});

describe("json harness registration", () => {
	it("creates, preserves, and idempotently rewrites cursor-style config", () => {
		const dir = mkdtempSync(join(tmpdir(), "psb-cli-test-"));
		try {
			const file = join(dir, "mcp.json");
			const entry = { command: "/usr/bin/node", args: ["/x/cli.js", "mcp"] };
			expect(upsertJsonMcpServer(file, ["mcpServers", "pi-second-brain"], entry)).toBe("created");
			expect(upsertJsonMcpServer(file, ["mcpServers", "pi-second-brain"], entry)).toBe("unchanged");
			expect(upsertJsonMcpServer(file, ["mcpServers", "other"], { command: "/keep" })).toBe("updated");
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
			expect(parsed.mcpServers.other).toEqual({ command: "/keep" });
			expect(parsed.mcpServers["pi-second-brain"]).toEqual(entry);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports created-vs-updated correctly on existing files", () => {
		const dir = mkdtempSync(join(tmpdir(), "psb-cli-test-"));
		try {
			const file = join(dir, "settings.json");
			writeFileSync(file, '{\n  "existing": true\n}\n');
			expect(upsertJsonMcpServer(file, ["mcpServers", "pi-second-brain"], { command: "n" })).toBe("updated");
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { existing: boolean };
			expect(parsed.existing).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
