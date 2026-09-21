#!/usr/bin/env node
// pi-second-brain CLI: the multi-harness installer and the MCP server launcher.
//
//   pi-second-brain mcp                       Run the MCP stdio server (what harnesses launch)
//   pi-second-brain setup [--all|flags]       Register into detected harnesses
//   pi-second-brain remove [flags]            Undo registration
//   pi-second-brain list                      Show which harnesses were detected
//
// Two install paths by design:
// - Pi uses the NATIVE extension (`pi install <path>`) — the exact setup the maintainer runs. No
//   MCP involved; `setup --pi` simply automates that same `pi install` against this package root.
// - Every other harness gets an MCP stdio entry (`node <this file> mcp`) written in each harness's
//   own config format, so all of them share one brain (~/.pi/knowledge).
//
// Detection follows the vercel-labs/skills CLI pattern: pure existsSync on config directories with
// environment overrides respected (CLAUDE_CONFIG_DIR, CODEX_HOME) — never spawn the harness binary
// just to detect it. Idempotent: re-running setup never duplicates entries.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const CLI_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
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

const IS_WINDOWS = platform() === "win32";

// Detection homes — env overrides first, mirroring vercel-labs/skills so installs that moved their
// harness home (CLAUDE_CONFIG_DIR, CODEX_HOME) are still detected.
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const XDG_CONFIG_HOME = join(homedir(), ".config");

export function buildServerEntry(): { command: string; args: string[] } {
	return { command: NODE_BIN, args: [CLI_PATH, "mcp"] };
}

function quoteWindowsArg(arg: string): string {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function runCapture(command: string, args: string[]): { ok: boolean; output: string } {
	// On Windows, harness launchers are .cmd shims (claude.cmd, pi.cmd) that spawnSync cannot
	// execute without a shell; quote args manually because shell mode joins them itself.
	const finalArgs = IS_WINDOWS ? args.map(quoteWindowsArg) : args;
	const result = spawnSync(command, finalArgs, { encoding: "utf8", shell: IS_WINDOWS });
	if (result.error) return { ok: false, output: result.error.message };
	return {
		ok: result.status === 0,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
	};
}

// --- TOML (Codex: $CODEX_HOME/config.toml) -------------------------------------------------------

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

// --- JSON (Cursor / Cline / Gemini / OpenCode) ---------------------------------------------------

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

// --- Harness targets -----------------------------------------------------------------------------

type TargetStatus = "configured" | "already" | "removed" | "not-detected" | "failed" | "manual";
type Target = {
	id: string;
	label: string;
	detect: () => boolean;
	configure: () => TargetStatus;
	remove: () => TargetStatus;
	manualNote?: string;
};

function appDataDir(): string {
	return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

function piTarget(): Target {
	return {
		id: "pi",
		label: "Pi (native extension)",
		detect: () => existsSync(join(homedir(), ".pi", "agent")),
		configure: () => {
			const install = runCapture("pi", ["install", PACKAGE_ROOT]);
			return install.ok ? "configured" : "failed";
		},
		remove: () => "manual",
		manualNote:
			"Pi uses the native extension (no MCP). Remove by deleting the entry from ~/.pi/agent/settings.json `packages`.",
	};
}

function claudeTarget(): Target {
	const manualCommand = `claude mcp add --scope user ${SERVER_NAME} -- ${NODE_BIN} ${CLI_PATH} mcp`;
	return {
		id: "claude",
		label: "Claude Code",
		detect: () => existsSync(CLAUDE_HOME),
		configure: () => {
			if (runCapture("claude", ["mcp", "get", SERVER_NAME]).ok) return "already";
			const add = runCapture("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, "--", NODE_BIN, CLI_PATH, "mcp"]);
			if (add.ok) return "configured";
			console.log(`    Run manually: ${manualCommand}`);
			return "manual";
		},
		remove: () => (runCapture("claude", ["mcp", "remove", "-s", "user", SERVER_NAME]).ok ? "removed" : "failed"),
	};
}

function codexTarget(): Target {
	const configPath = join(CODEX_HOME, "config.toml");
	return {
		id: "codex",
		label: "Codex CLI",
		detect: () => existsSync(CODEX_HOME),
		configure: () => {
			const content = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
			const hadServer = content.includes(`[mcp_servers.${SERVER_NAME}]`);
			const next = upsertTomlServer(content, SERVER_NAME, buildServerEntry());
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, next);
			return hadServer ? "already" : "configured";
		},
		remove: () => {
			if (!existsSync(configPath)) return "not-detected";
			writeFileSync(configPath, stripTomlServer(readFileSync(configPath, "utf8"), SERVER_NAME));
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

function clineSettingsCandidates(): string[] {
	const relative = join("User", "globalStorage", "saoudrizwan.claude-dev", "settings");
	const base =
		platform() === "darwin"
			? join(homedir(), "Library", "Application Support")
			: IS_WINDOWS
				? appDataDir()
				: join(homedir(), ".config");
	return [join(base, "Code", relative), join(base, "Code - Insiders", relative), join(base, "VSCodium", relative)];
}

function clineTarget(): Target {
	const candidates = clineSettingsCandidates();
	const dir = candidates.find((candidate) => existsSync(candidate)) ?? (candidates[0] as string);
	const file = join(dir, "cline_mcp_settings.json");
	return {
		id: "cline",
		label: "Cline (VS Code)",
		detect: () => candidates.some((candidate) => existsSync(candidate)),
		configure: () => {
			const outcome = upsertJsonMcpServer(file, ["mcpServers", SERVER_NAME], {
				...buildServerEntry(),
				disabled: false,
				autoApprove: READ_ONLY_TOOLS,
			});
			return outcome === "unchanged" ? "already" : "configured";
		},
		remove: () => (removeJsonMcpServer(file, ["mcpServers", SERVER_NAME]) === "removed" ? "removed" : "not-detected"),
	};
}

function buildTargets(): Target[] {
	const entry = buildServerEntry();
	return [
		piTarget(),
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
		clineTarget(),
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
			join(XDG_CONFIG_HOME, "opencode"),
			join(XDG_CONFIG_HOME, "opencode", "opencode.json"),
			["mcp", SERVER_NAME],
			{ type: "local", command: [entry.command, ...entry.args], enabled: true },
		),
	];
}

// --- Command dispatch ----------------------------------------------------------------------------

const FLAGS = ["pi", "claude", "codex", "cursor", "cline", "gemini", "opencode"] as const;
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
  pi-second-brain mcp                Run the MCP stdio server (this is what other harnesses launch)
  pi-second-brain setup [flags]      Register into harnesses (Pi: runs \`pi install\` on this package)
  pi-second-brain remove [flags]     Undo registration
  pi-second-brain list               Show detected harnesses

Flags: --all | ${FLAGS.map((flag) => `--${flag}`).join(" ")}

Pi uses the native extension — exactly like the maintainer's own setup:
  git clone https://github.com/myusufalghifari10/pi-second-brain.git
  pi install /absolute/path/to/pi-second-brain`);
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
			`\nRe-run with --all or with specific flags, e.g.: pi-second-brain setup ${detected.join(" ") || "--pi"}`,
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
			const note =
				target.manualNote && (status === "manual" || status === "failed") ? `\n    ${target.manualNote}` : "";
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
