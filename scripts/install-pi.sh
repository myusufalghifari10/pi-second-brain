#!/bin/sh
# pi-second-brain installer — for Pi (native extension + skill; no MCP involved).
#
#   git clone https://github.com/myusufalghifari10/pi-second-brain.git
#   cd pi-second-brain
#   sh scripts/install-pi.sh
#
# Auto-detects Linux, macOS, and Windows (Git Bash). This is the exact setup the maintainer runs.
set -eu

cd "$(dirname "$0")/.."

case "$(uname -s)" in
	Linux*) OS=linux ;;
	Darwin*) OS=macos ;;
	MINGW* | MSYS* | CYGWIN*) OS=windows ;;
	*) OS=unknown ;;
esac

printf '\033[1m  pi-second-brain installer (Pi)\033[0m\n'
printf '\033[2m  Native extension + skill for Pi — no MCP involved\033[0m\n'
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
		windows) printf '       Install: winget install -e --id OpenJS.NodeJS.LTS   (or https://nodejs.org)\n' ;;
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
if ! npm_config_allow_scripts="better-sqlite3" npm rebuild better-sqlite3; then
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

if ! command -v pi >/dev/null 2>&1; then
	printf 'error: pi not found. Install it first:  curl -fsSL https://pi.dev/install.sh | sh\n'
	exit 1
fi

printf '[4/4] Installing the native extension into Pi...\n'
pi install "$PWD"

printf '\nDone. Restart Pi — the knowledge_* tools and the packaged skill are now available.\n'
printf 'Verify: ask Pi "jalankan knowledge_status".\n'
