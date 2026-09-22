# pi-second-brain installer (PowerShell) — MCP harnesses, native Windows shell.
#
#   git clone https://github.com/myusufalghifari10/pi-second-brain.git
#   cd pi-second-brain
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# Same steps as scripts/install.sh (which Windows users can also run in Git Bash).
$ErrorActionPreference = "Stop"

if (-not $PSScriptRoot) {
	# `irm | iex` runs with no script root; without the repo we would npm-install in the wrong folder.
	Write-Host "error: run this script from a cloned repo (it needs the source tree):" -ForegroundColor Red
	Write-Host "       git clone https://github.com/myusufalghifari10/pi-second-brain.git" -ForegroundColor Red
	Write-Host "       cd pi-second-brain" -ForegroundColor Red
	Write-Host '       powershell -ExecutionPolicy Bypass -File scripts\install.ps1' -ForegroundColor Red
	exit 1
}
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host ""
Write-Host "  pi-second-brain installer (Windows/PowerShell)" -ForegroundColor Bold
Write-Host "  MCP surface for Claude Code / Codex / Cursor / Cline / Gemini CLI / OpenCode" -ForegroundColor DarkGray
Write-Host ""

$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
	$major = [int]((node --version) -replace "^v(\d+)\..*", '$1')
	if ($major -ge 22) { $nodeOk = $true } else { Write-Host "error: Node.js 22 or newer required (found $(node --version))." -ForegroundColor Red }
} else {
	Write-Host "error: Node.js not found." -ForegroundColor Red
}
if (-not $nodeOk) {
	Write-Host "       Install: winget install -e --id OpenJS.NodeJS.LTS   (or https://nodejs.org)" -ForegroundColor Red
	exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
	Write-Host "error: npm not found (it ships with Node.js — reinstall Node)." -ForegroundColor Red
	exit 1
}

Write-Host "[1/4] Installing dependencies (third-party install scripts disabled)..."
npm install --ignore-scripts
if ($LASTEXITCODE -ne 0) { exit 1 }

# package.json#allowScripts permits exactly one install script in this tree: better-sqlite3's,
# which fetches its prebuilt binary.
Write-Host "[2/4] Fetching the better-sqlite3 prebuilt binary..."
npm rebuild better-sqlite3
$rebuildCode = $LASTEXITCODE
if ($rebuildCode -ne 0) {
	Write-Host ""
	Write-Host "error: better-sqlite3 could not fetch its prebuilt binary." -ForegroundColor Red
	Write-Host "  - It downloads from github.com — corporate proxy? npm config set proxy http://proxy:port" -ForegroundColor Red
	Write-Host "  - Building from source instead needs Visual Studio Build Tools ('Desktop development with C++') + Python 3." -ForegroundColor Red
	exit 1
}

Write-Host "[3/4] Building..."
npm run build
if ($LASTEXITCODE -ne 0) { exit 1 }

if ($env:PI_SECOND_BRAIN_SKIP_SETUP -eq "1") {
	Write-Host "[4/4] Skipping harness registration (PI_SECOND_BRAIN_SKIP_SETUP=1)."
} else {
	Write-Host "[4/4] Registering the MCP server into detected harnesses..."
	node dist/src/cli.js setup --all
	if ($LASTEXITCODE -ne 0) { Write-Host "warn: registration had warnings - retry with: node dist/src/cli.js setup --all" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "Done. Verify: node dist/src/cli.js list"
Write-Host 'Next: see "Connect your coding agent" in README.md - restart your harness, then ask it'
Write-Host "to call knowledge_status as a smoke test."
