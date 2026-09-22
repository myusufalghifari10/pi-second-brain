#!/bin/sh
# pi-second-brain installer — MCP harnesses (Claude Code, Codex, Cursor, Cline, Gemini CLI, OpenCode).
#
#   git clone https://github.com/myusufalghifari10/pi-second-brain.git
#   cd pi-second-brain
#   sh scripts/install.sh
#
# Auto-detects Linux, macOS, and Windows (Git Bash). For Pi run scripts/install-pi.sh instead.
set -eu

cd "$(dirname "$0")/.."

case "$(uname -s)" in
	Linux*) OS=linux ;;
	Darwin*) OS=macos ;;
	MINGW* | MSYS* | CYGWIN*) OS=windows ;;
	*) OS=unknown ;;
esac

printf '\033[1m  pi-second-brain installer\033[0m\n'
printf '\033[2m  MCP surface for Claude Code / Codex / Cursor / Cline / Gemini CLI / OpenCode\033[0m\n'
printf '  Detected OS: %s\n\n' "$OS"

node_ok=0
if command -v node >/dev/null 2>&1; then
	if node -e 'const [maj] = process.versions.node.split(".").map(Number); process.exit(maj >= 22 ? 0 : 1)' 2>/dev/null; then
		node_ok=1
	else
		printf 'error: Node.js 22 or newer required (found %s).\n' "$(node --version)"
	fi
else
	printf 'error: Node.js not found.\n'
fi
if [ "$node_ok" -ne 1 ]; then
	case "$OS" in
		windows) printf '       Install: winget install OpenJS.NodeJS.LTS   (or https://nodejs.org)\n' ;;
		macos) printf '       Install: brew install node@22   (or https://nodejs.org)\n' ;;
		*) printf '       Install: sudo apt install nodejs npm   (or https://nodejs.org)\n' ;;
	esac
	exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
	printf 'error: npm not found (it ships with Node.js — reinstall Node).\n'
	exit 1
fi

printf '[1/4] Installing dependencies (third-party install scripts disabled)...\n'
npm install --ignore-scripts

printf '[2/4] Fetching the better-sqlite3 prebuilt binary...\n'
# package.json#allowScripts permits exactly one install script in this tree: better-sqlite3's,
# which fetches its prebuilt binary.
if ! npm rebuild better-sqlite3; then
	printf '\nerror: better-sqlite3 could not fetch its prebuilt binary.\n'
	printf '  - It downloads from github.com — corporate proxy? npm config set proxy http://proxy:port\n'
	printf '  - Building from source instead needs:\n'
	case "$OS" in
		windows) printf '      Visual Studio Build Tools ("Desktop development with C++") + Python 3\n' ;;
		macos) printf '      xcode-select --install\n' ;;
		*) printf '      sudo apt install build-essential python3\n' ;;
	esac
	exit 1
fi

printf '[3/4] Building...\n'
npm run build

if [ "${PI_SECOND_BRAIN_SKIP_SETUP:-0}" = "1" ]; then
	printf '[4/4] Skipping harness registration (PI_SECOND_BRAIN_SKIP_SETUP=1).\n'
else
	printf '[4/4] Registering the MCP server into detected harnesses...\n'
	node dist/src/cli.js setup --all || printf 'warn: registration had warnings — retry with: node dist/src/cli.js setup --all\n'
fi

printf '\nDone. Verify: node dist/src/cli.js list\n'
printf 'Next: see "Connect your coding agent" in README.md — restart your harness, then ask it\n'
printf 'to call knowledge_status as a smoke test.\n'
