#!/usr/bin/env node
// pi-second-brain CLI: the multi-harness installer and the MCP server launcher.
//
//   pi-second-brain mcp                       Run the MCP stdio server (what harnesses launch)
//   pi-second-brain setup [--all|flags]       Register the MCP server into detected harnesses
//   pi-second-brain remove [flags]            Undo registration
//   pi-second-brain list                      Show which harnesses were detected
//
// Pi itself stays on the native extension path (`pi install`); every MCP-capable harness gets a
// stdio entry that launches `node <this file> mcp`, so all harnesses share one brain
// (~/.pi/knowledge). Registration is idempotent: re-running setup never duplicates entries.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CLI_PATH = fileURLToPath(import.meta.url);
const NODE_BIN = process.execPath;
const SERVER_NAME = "pi-second-brain";
const READ_ONLY_TOOLS = [
	"knowledge_plan",
	"knowledge_search",
	"knowledge_symbol_search",
	"knowledge_status",
	"knowledge_show",
	"knowledge_doctor",
];

export function buildServerEntry(): { command: string; args: string[] } {
	return { command: NODE_BIN, args: [CLI_PATH, "mcp"] };
}

// --- TOML (Codex: ~/.codex/config.toml) ----------------------------------------------------------

function tomlServerBlock(name: string, entry: { command: string; args: string[] }): string[] {
	return [
		`[mcp_servers.${name}]`,
		`command = ${JSON.stringify(entry.command)}`,
		`args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
	];
}

export function upsertTomlServer(content: string, name: string, entry: { command: string; args: string[] }): string {
	const header = `[mcp_servers.${name}]`;
	const lines = content.split("\n");
	const start = lines.findIndex((line) => line.trim() === header);
	const block = tomlServerBlock(name, entry);
	if (start === -1) {
		const base = lines.length > 0 && lines[lines.length - 1].trim() === "" ? lines : [...lines, ""];
		return [...base, ...block].join("\n");
	}
	let end = start + 1;
	while (end < lines.length && !lines[end].trim().startsWith("[")) end += 1;
	return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

export function stripTomlServer(content: string, name: string): string {
	const header = `[mcp_servers.${name}]`;
	const lines = content.split("\n");
	const start = lines.findIndex((line) => line.trim() === header);
	if (start === -1) return content;
	let end = start + 1;
	while (end < lines.length && !lines[end].trim().startsWith("[")) end += 1;
	return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

// --- JSON (Cursor / Cline / Gemini / OpenCode) ------------------------------------

export function upsertJsonMcpServer(
	filePath: string,
	keyPath: string[],
	value: unknown,
): "created" | "updated" | "unchanged" {
	const existed = existsSync(filePath);
	let root: Record<string, unknown> = {};
	if (existed) {
		try {
			root = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
		} catch (error) {
			throw new Error(`Cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	let node = root;
	for (let index = 0; index < keyPath.length - 1; index += 1) {
		const key = keyPath[index] as string;
		if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
		node = node[key] as Record<string, unknown>;
	}
	const leaf = keyPath[keyPath.length - 1] as string;
	if (JSON.stringify(node[leaf]) === JSON.stringify(value)) return "unchanged";
	node[leaf] = value;
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`);
	return existed ? "updated" : "created";
}

export function removeJsonMcpServer(filePath: string, keyPath: string[]): "removed" | "absent" {
	if (!existsSync(filePath)) return "absent";
	let root: Record<string, unknown>;
	try {
		root = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let node = root;
	for (let index = 0; index < keyPath.length - 1; index += 1) {
		const key = keyPath[index] as string;
		if (!node[key] || typeof node[key] !== "object") return "absent";
		node = node[key] as Record<string, unknown>;
	}
	const leaf = keyPath[keyPath.length - 1] as string;
	if (!(leaf in node)) return "absent";
	delete node[leaf];
	writeFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`);
	return "removed";
}

// --- Harness targets ---------------------------------------------------------------

function clineSettingsDir(): string | null {
	if (platform() === "darwin")
		return join(
			homedir(),
			"Library",
			"Application Support",
			"Code",
			"User",
			"globalStorage",
			"saoudrizwan.claude-dev",
			"settings",
		);
	if (platform() === "win32")
		return join(
			process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
			"Code",
			"User",
			"globalStorage",
			"saoudrizwan.claude-dev",
			"settings",
		);
	return join(homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings");
}

function opencodeConfigPath(): string {
	if (platform() === "win32")
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode", "opencode.json");
	return join(homedir(), ".config", "opencode", "opencode.json");
}

function runCapture(command: string, args: string[]): { ok: boolean; output: string } {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error) return { ok: false, output: result.error.message };
	return {
		ok: result.status === 0,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
	};
}

type TargetStatus = "configured" | "already" | "removed" | "not-detected" | "failed" | "manual";
type Target = {
	id: string;
	label: string;
	detect: () => boolean;
	configure: () => TargetStatus;
	remove: () => TargetStatus;
	manualNote?: string;
};

function claudeTarget(): Target {
	return {
		id: "claude",
		label: "Claude Code",
		detect: () => runCapture("claude", ["--version"]).ok || existsSync(join(homedir(), ".claude.json")),
		configure: () => {
			const existing = runCapture("claude", ["mcp", "get", SERVER_NAME]);
			if (existing.ok) return "already";
			const add = runCapture("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, "--", NODE_BIN, CLI_PATH, "mcp"]);
			return add.ok ? "configured" : "failed";
		},
		remove: () => (runCapture("claude", ["mcp", "remove", "-s", "user", SERVER_NAME]).ok ? "removed" : "failed"),
	};
}

function codexTarget(): Target {
	const configPath = join(homedir(), ".codex", "config.toml");
	return {
		id: "codex",
		label: "Codex CLI",
		detect: () => existsSync(join(homedir(), ".codex")),
		configure: () => {
			const content = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
			const next = upsertTomlServer(content, SERVER_NAME, buildServerEntry());
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, next);
			return content.includes(`[mcp_servers.${SERVER_NAME}]`) ? "already" : "configured";
		},
		remove: () => {
			if (!existsSync(configPath)) return "not-detected";
			const next = stripTomlServer(readFileSync(configPath, "utf8"), SERVER_NAME);
			writeFileSync(configPath, next);
			return "removed";
		},
	};
}

function jsonTarget(
	id: string,
	label: string,
	detectPath: string,
	file: string,
	keyPath: string[],
	entry: unknown,
): Target {
	return {
		id,
		label,
		detect: () => existsSync(detectPath),
		configure: () => {
			const outcome = upsertJsonMcpServer(file, keyPath, entry);
			return outcome === "unchanged" ? "already" : "configured";
		},
		remove: () => (removeJsonMcpServer(file, keyPath) === "removed" ? "removed" : "not-detected"),
	};
}

function piTarget(): Target {
	return {
		id: "pi",
		label: "Pi (native extension)",
		detect: () => runCapture("pi", ["--version"]).ok || existsSync(join(homedir(), ".pi", "agent")),
		configure: () => "manual",
		remove: () => "manual",
		manualNote:
			"Pi uses the native extension, not MCP: `pi install npm:pi-second-brain` (after publish) or `pi install /path/to/pi-second-brain`.",
	};
}

function buildTargets(): Target[] {
	const entry = buildServerEntry();
	return [
		claudeTarget(),
		codexTarget(),
		jsonTarget(
			"cursor",
			"Cursor",
			join(homedir(), ".cursor"),
			join(homedir(), ".cursor", "mcp.json"),
			["mcpServers", SERVER_NAME],
			entry,
		),
		jsonTarget(
			"cline",
			"Cline (VS Code)",
			clineSettingsDir() ?? "",
			join(clineSettingsDir() ?? ".", "cline_mcp_settings.json"),
			["mcpServers", SERVER_NAME],
			{ ...entry, disabled: false, autoApprove: READ_ONLY_TOOLS },
		),
		jsonTarget(
			"gemini",
			"Gemini CLI",
			join(homedir(), ".gemini"),
			join(homedir(), ".gemini", "settings.json"),
			["mcpServers", SERVER_NAME],
			entry,
		),
		jsonTarget(
			"opencode",
			"OpenCode",
			join(homedir(), ".config", "opencode"),
			opencodeConfigPath(),
			["mcp", SERVER_NAME],
			{ type: "local", command: [entry.command, ...entry.args], enabled: true },
		),
		piTarget(),
	];
}

// --- Command dispatch ----------------------------------------------------------------

const FLAGS = ["claude", "codex", "cursor", "cline", "gemini", "opencode", "pi"] as const;
type FlagId = (typeof FLAGS)[number];

function parse(argv: string[]): { command: string; ids: FlagId[]; all: boolean } {
	const { positionals, values: rawValues } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: Object.fromEntries([
			...FLAGS.map((flag) => [flag, { type: "boolean" as const }]),
			["all", { type: "boolean" as const }],
		]),
	});
	const values = rawValues as Partial<Record<FlagId | "all", boolean>>;
	const ids = FLAGS.filter((flag) => values[flag] === true);
	return { command: positionals[0] ?? "", ids, all: values.all === true };
}

function printHelp(): void {
	console.log(`pi-second-brain — local-first RAG knowledge base for coding agents

Usage:
  pi-second-brain mcp                Run the MCP stdio server (this is what harnesses launch)
  pi-second-brain setup [flags]      Register the MCP server into harnesses
  pi-second-brain remove [flags]     Undo registration
  pi-second-brain list               Show detected harnesses

Flags: --all | ${FLAGS.map((flag) => `--${flag}`).join(" ")}

Pi uses the native extension instead of MCP: pi install /path/to/pi-second-brain`);
}

async function main(): Promise<number> {
	const { command, ids, all } = parse(process.argv.slice(2));
	if (command === "--version" || command === "-v") {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: string;
		};
		console.log(manifest.version ?? "unknown");
		return 0;
	}
	if (command === "mcp") {
		const { runStdioServer } = await import("./mcp-server.ts");
		await runStdioServer();
		return 0;
	}
	if (command === "" || command === "help" || command === "--help" || command === "-h") {
		printHelp();
		return 0;
	}
	const targets = buildTargets();
	const selected = all
		? targets
		: ids.length > 0
			? targets.filter((target) => (ids as string[]).includes(target.id))
			: [];

	if (command === "list") {
		for (const target of targets) {
			console.log(`${target.detect() ? "✓" : "-"} ${target.label} (${target.id})`);
		}
		return 0;
	}
	if (command !== "setup" && command !== "remove") {
		console.error(`Unknown command: ${command}`);
		printHelp();
		return 1;
	}
	if (selected.length === 0) {
		const detected = targets.filter((target) => target.detect()).map((target) => `--${target.id}`);
		console.log("No harness flags given. Detected on this machine:");
		console.log(detected.length > 0 ? `  ${detected.join(" ")}` : "  (none)");
		console.log(
			`\nRe-run with --all or with specific flags, e.g.: pi-second-brain setup ${detected.join(" ") || "--claude"}`,
		);
		return 0;
	}

	let failed = 0;
	for (const target of selected) {
		const detected = target.detect();
		if (!detected && command === "setup" && all) {
			console.log(`- ${target.label}: not detected, skipped`);
			continue;
		}
		try {
			const status = command === "setup" ? target.configure() : target.remove();
			const note = target.manualNote ? `\n    ${target.manualNote}` : "";
			console.log(`- ${target.label}: ${status}${note}`);
			if (status === "failed") failed += 1;
		} catch (error) {
			failed += 1;
			console.log(`- ${target.label}: failed — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main()
		.then((code) => {
			if (code !== 0) process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
