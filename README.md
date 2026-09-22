# pi-second-brain

**A local-first RAG knowledge base for [Pi](https://pi.dev) — your agent's second brain: a research assistant that answers from your sources, not from its memory.**

One local index that can hold **anything** — codebases, documentation, scientific papers, LaTeX, PDFs, websites, Obsidian vaults, plain notes — and search it the way you actually think: by **meaning**, by **exact symbol**, by **formula**, by **number**, by **table row**, or by **reference label**. SQLite + FTS5 + ONNX embeddings on your machine. No API keys, no telemetry, no cloud.

*Code · Docs · PDFs · arXiv papers · LaTeX · URLs · Obsidian · Math · Chemistry — one private index.*

> **Provenance.** `pi-second-brain` is an independently maintained fork of
> [nczz/pi-knowledge](https://github.com/nczz/pi-knowledge) (v0.10.1 base), extended with a science/math
> retrieval layer and a much broader ingestion pipeline. The runtime namespace is kept for compatibility:
> environment variables stay `PI_KNOWLEDGE_*`, tools stay `knowledge_*`, storage stays `~/.pi/knowledge`.

---

## Why

Large language models are confident writers and unreliable researchers. They misremember numbers, invent citations, and blur one paper into the next — and no prompt fixes it, because the knowledge simply isn't there.

pi-second-brain fixes the part that *can* be fixed: it gives your agent a private corpus — arXiv papers, LaTeX, PDFs, websites, docs, code — and grounds every claim in a real, retrievable chunk of it. Ask about a formula, a table cell, a reagent, a benchmark number: the agent retrieves the exact passage, with provenance attached (which file, which chunk, why it matched), and answers from that — not from the fog of its training data.

**A research assistant that shows its work:**

- **Grounded by construction** — hybrid BM25 + vector retrieval finds passages by meaning *and* by evidence; when confidence is low it returns nothing rather than a plausible guess.
- **Research-grade ingestion** — scientific PDFs keep their math, tables, figures, and labels; nothing degrades into glyph soup.
- **Numbers and formulas are first-class evidence** — query by formula, by chemical species, by a bare benchmark digit; the passage that contains it comes back — with its row label.
- **Private by default** — everything runs locally: SQLite + ONNX embeddings, no API keys, no cloud, no telemetry. Your unpublished research stays yours.

## Index anything

| You have | What the indexer does |
|----------|----------------------|
| **Source code** | Recursive AST chunking (tree-sitter) for TypeScript/JavaScript, Python, Go, Rust, Java, Bash, GNU C, C++, and QML — functions, classes, and namespaces become retrievable units with symbol metadata |
| **Markdown & notes** | Heading breadcrumbs, atomic fenced code and tables, Obsidian frontmatter (`title`/`tags`/`aliases`) and `[[wikilinks]]` as metadata |
| **Scientific PDFs** | Optional `marker`/`docling` sidecar converts to Markdown **with `$$…$$` LaTeX math**, cached by content hash; fail-open to built-in text-layer extraction; figures are persisted and caption-less images get OCR'd (optional tesseract) |
| **PDF tables** | Table blocks keep their introducing narrative sentence, and every data row is stamped `Row: <label> |` — a query for a bare number returns the row *with its method name* |
| **LaTeX** | First-class `.tex` support: section breadcrumbs, `\label` metadata, and a **label graph** that resolves `\ref`/`\eqref`/`\cref` targets per scope — collisions resolve as *unresolved*, never wrong |
| **Websites** | URL ingestion with re-index support |
| **DOCX / plain text** | Extracted and chunked like everything else |

Every KB keeps provenance: chunk ids, match reasons, file freshness, per-result diagnostics.

## Search it any way you think

- **By meaning** — *"how does the watcher handle overlapping updates?"* finds the right code even with different wording.
- **By symbol** — `knowledge_symbol_search` pins down functions, classes, config keys, and env vars before broader search.
- **By formula** — query `$E=mc^{2}$` or `\int_0^\infty e^{-x^2}dx` against a dedicated formula index; exact and fuzzy matches boost results or inject formula-only chunks.
- **By chemistry** — `H2SO4` ≡ `H₂SO₄` ≡ `\ce{H2SO4}`; unicode subscripts, charges, hydrate dots, and arrows unify into one case-sensitive signature (`Co` never matches `CO`).
- **By number** — `11.94` is one token, `shell-2` ≡ `shell 2`, `2,056` ≡ `2056`; numbers inside PDF tables arrive together with their row label.
- **By math notation** — `x²` ⇔ `x^2`, `α` ⇔ `\alpha`, `≤` ⇔ `\leq`, matched symmetrically on index and query.
- **By unit** — `N·m` ≡ `N m` over a conservative frozen SI unit list.
- **By reference** — *"what does eq. 11 depend on?"* rides the LaTeX label graph to the defining chunk.

## Highlights

- **Hybrid retrieval, six modes** — `fast` / `semantic` / `hybrid` / `deep` / `adaptive` / `auto`, plus intent aliases (`code`, `config`, `errors`, `docs`, `decision`) and tuning profiles (`low_token`, `precision`, `recall`, `long_context`).
- **Ranking quality built in** — optional cross-encoder reranking (`deep`), MMR-style diversity reranking, adaptive context windows, confidence gating that returns *nothing* instead of unrelated chunks.
- **Context on demand** — `expand_neighbors` attaches adjacent chunks (`prev`/`next`) to the top hit when the answer needs surrounding context.
- **Always current** — file watcher auto-reindexing (`PI_KNOWLEDGE_WATCH=true`), incremental updates, opt-in auto-injection of relevant knowledge before every answer (`PI_KNOWLEDGE_AUTO_INJECT=true`).
- **Self-diagnosing** — `knowledge_status` and `knowledge_doctor` report staleness, orphans, stuck jobs, and missing vectors with concrete repair actions.
- **Large-project stability** — persisted indexing progress, capped batches, streamed vector scans, ETA reporting.
- **Portable** — export any KB to JSONL, re-embed on import.
- **Local models** — ONNX embeddings (~118 MB, cached once) and an optional local cross-encoder reranker; or point at any OpenAI-compatible API if you prefer.

## Feature Comparison

| Feature | pi-second-brain | pi-knowledge (upstream) | kiro-cli knowledge | pi-memory |
|---------|:---:|:---:|:---:|:---:|
| **Math notation matching** (`x²` ⇔ `x^2`) | ✅ | ❌ | ❌ | ❌ |
| **Query-by-formula retrieval** | ✅ | ❌ | ❌ | ❌ |
| **Chemistry normalization** (`H2SO4` ≡ `H₂SO₄` ≡ `\ce{}`) | ✅ | ❌ | ❌ | ❌ |
| **Engineering unit matching** (`N·m` ≡ `N m`) | ✅ | ❌ | ❌ | ❌ |
| **Numeric token search** (`2,056` ≡ `2056`) | ✅ | ❌ | ❌ | ❌ |
| **PDF math sidecar (marker/docling) + cache** | ✅ | ❌ | ❌ | ❌ |
| **PDF table→narrative coupling + row labels** | ✅ | ❌ | ❌ | ❌ |
| **PDF image persistence + OCR captions** | ✅ | ❌ | ❌ | ❌ |
| **LaTeX-aware chunking + label graph** (`\ref` resolution) | ✅ | ❌ | ❌ | ❌ |
| **Obsidian frontmatter/wikilink metadata** | ✅ | ❌ | ❌ | ❌ |
| **Adjacent-chunk context expansion** (`expand_neighbors`) | ✅ | ❌ | ❌ | ❌ |
| Index arbitrary files/dirs/URLs | ✅ | ✅ | ✅ | ❌ |
| Multiple named knowledge bases | ✅ | ✅ | ✅ | ❌ |
| Semantic (vector) search | ✅ | ✅ | ✅ | ✅ (via qmd) |
| BM25 keyword search | ✅ | ✅ | ✅ | ✅ (via qmd) |
| Hybrid search + weighted score fusion | ✅ | ✅ | ❌ | partial |
| Cross-encoder reranking | ✅ | ✅ | ❌ | ❌ |
| Adaptive contextual search | ✅ | ✅ | ❌ | ❌ |
| Diversity reranking (MMR-style) | ✅ | ✅ | ❌ | ❌ |
| Incremental re-indexing | ✅ | ✅ | ❌ | ❌ |
| File watcher (auto-update) | ✅ | ✅ | ❌ | ❌ |
| Code-aware chunking (10 languages) | ✅ | ✅ | ❌ | ❌ |
| Symbol/config/heading lookup | ✅ | ✅ | ❌ | ❌ |
| Local embeddings (zero API) | ✅ | ✅ | ❌ | ✅ (via qmd) |
| Index quality diagnostics + health score | ✅ | ✅ | ❌ | ❌ |
| Metadata filters in search | ✅ | ✅ | ❌ | ❌ |
| Progress reporting + stuck-job detection | ✅ | ✅ | partial | ❌ |
| Portable JSONL export/import | ✅ | ✅ | ❌ | ❌ |
| Cross-session persistence | ✅ | ✅ | ✅ | ✅ |
| Pi extension native | ✅ | ✅ | N/A | ✅ |
| Context injection per turn | ✅ | ✅ | ❌ | ✅ |
| RPC mode support | ✅ | ✅ | N/A | N/A |

*The `pi-knowledge` column reflects the upstream v0.10.1 feature set this fork started from; other columns reflect each tool's public documentation.*

## Install

Two scripts — pick your surface. Both auto-detect **Linux, macOS, or Windows** and install
everything needed: dependencies, the one native binary fetch, the build, and registration into the
coding agents they find. All surfaces share the same brain (`~/.pi/knowledge`).

```bash
git clone https://github.com/myusufalghifari10/pi-second-brain.git
cd pi-second-brain

# On Pi — native extension + skill (the maintainer's own setup):
sh scripts/install-pi.sh

# Everywhere else — MCP server + skill (Claude Code, Codex, Cursor, Cline, Gemini CLI, OpenCode):
sh scripts/install.sh
```

On Windows run the same commands in **Git Bash** (ships with [Git for Windows](https://git-scm.com/download/win)),
or use the PowerShell twin:

```powershell
scripts\install.ps1
```

Requirements: Node.js ≥ 22 and git — the script checks both and prints the exact fix per OS if
anything is missing. It installs dependencies with `--ignore-scripts` and then rebuilds only
`better-sqlite3` (the single dependency that fetches a prebuilt binary), so third-party install
scripts can never break your install — the failure mode that plagues Windows npm installs.

<details>
<summary>Manual registration (if you skipped setup)</summary>

```bash
node dist/src/cli.js setup --all    # or: --claude --codex --cursor --cline --gemini --opencode
node dist/src/cli.js list           # verify what was detected
node dist/src/cli.js remove --all   # undo
```

Claude Code only:

```bash
claude mcp add --scope user pi-second-brain -- node /absolute/path/to/pi-second-brain/dist/src/cli.js mcp
```

Codex only — append to `~/.codex/config.toml`:

```toml
[mcp_servers.pi-second-brain]
command = "/path/to/node"
args = ["/path/to/pi-second-brain/dist/src/cli.js", "mcp"]
```

</details>

## Connect your coding agent

The install script already wired everything it found. Installed a new harness later? Re-run
`node dist/src/cli.js setup --all` — it is idempotent and never duplicates entries.

| Agent | What got wired | How to verify |
|---|---|---|
| **Pi** | Native extension via `pi install` (no MCP) + packaged skill | Restart Pi, ask: `jalankan knowledge_status` |
| **Claude Code** | `claude mcp add --scope user` | Restart, run `/mcp` — pi-second-brain shows ✔ |
| **Codex** | `[mcp_servers.pi-second-brain]` in `~/.codex/config.toml` | Restart, ask: `call knowledge_status` |
| **Cursor** | `~/.cursor/mcp.json` | Settings → MCP shows pi-second-brain |
| **Cline** | `cline_mcp_settings.json` (read-only tools auto-approved) | MCP tab in Cline |
| **Gemini CLI** | `~/.gemini/settings.json` | Restart, ask: `call knowledge_status` |
| **OpenCode** | `opencode.json` | Restart, ask: `call knowledge_status` |

**Smoke test (any agent):** ask it to call `knowledge_status` — you should see the storage path and
`Knowledge bases: 0`. Then `knowledge_add` a folder of papers or docs and start asking questions.

> **Not on the list?** Any MCP-capable client works — point it at
> `node /path/to/pi-second-brain/dist/src/cli.js mcp`. And if your agent can read a file, just paste
> this:
>
> ```text
> git clone https://github.com/myusufalghifari10/pi-second-brain.git && cd pi-second-brain && sh scripts/install.sh
> ```
> (On Pi, run `sh scripts/install-pi.sh` instead.) Then restart me and call `knowledge_status` to
> verify.

## Usage

Requirements: Node ≥ 22. Model weights (~150 MB) download once and are cached locally.

Then just talk to your agent:

```
> Index my project at ~/work/my-app as "my-app"
> Search my knowledge base for "authentication flow"
> Find the formula \int_0^\infty e^{-x^2}dx in my papers
> Which table reports the 62.86 number, and for which method?
```

Optional extras:

```bash
pip install marker-pdf        # or: pip install docling — better PDF math extraction (auto-detected, fail-open)
sudo pacman -S tesseract      # or: apt install tesseract-ocr — OCR for caption-less PDF figures
export PI_KNOWLEDGE_WATCH=true        # auto re-index watched directory KBs
export PI_KNOWLEDGE_AUTO_INJECT=true  # agent auto-searches relevant knowledge before answering
```

## Tools

| Tool | Description |
|------|-------------|
| `knowledge_plan` | Inspect an indexing source before writing a KB: scannable counts, suggested exclusions, technical skips |
| `knowledge_add` | Index files, directories, URLs, PDFs, DOCX, or inline text |
| `knowledge_search` | Fast / semantic / hybrid / deep / adaptive search across one or all KBs, with filters, profiles, diagnostics, and `expand_neighbors` |
| `knowledge_symbol_search` | Exact or substring lookup for code symbols, route-like handlers, headings, config keys, env vars |
| `knowledge_update` | Incrementally re-index changed files in source-backed KBs |
| `knowledge_status` | Engine status: staleness, orphans, coverage, indexing jobs |
| `knowledge_doctor` | Health score + concrete repair actions (stale data, missing vectors, stuck jobs) |
| `knowledge_export` / `knowledge_import` | Portable JSONL export / re-embed on import |
| `knowledge_remove` / `knowledge_clear` | Remove one KB or everything (explicit `confirm: true` required) |
| `knowledge_configure` | Persist runtime prerequisites (e.g. Windows `node.exe` path) |
| `knowledge_show` | List all knowledge bases with stats |

### Search-mode contract

| Mode | Use when |
|------|----------|
| `fast` | Exact symbols, filenames, commands, error codes, config keys, numbers (`11.94`, `H2O`) |
| `hybrid` *(default)* | Most project questions with lexical anchors — BM25-anchored + vector fusion |
| `semantic` | Conceptual queries where wording differs; fallback when hybrid returns nothing |
| `adaptive` | When the answer needs neighboring chunks / surrounding implementation context |
| `deep` | High-stakes answers — hybrid + cross-encoder reranking |
| `auto` | Lets the engine pick and retry alternate modes on weak results |

## Configuration

Full reference: [docs/configuration.md](docs/configuration.md). Common knobs:

| Area | Variables |
|------|-----------|
| Storage | `PI_KNOWLEDGE_DIR`, `PI_CODING_AGENT_DIR` |
| Models | `PI_KNOWLEDGE_MODEL_CACHE_DIR`, `PI_KNOWLEDGE_NODE_PATH`, `PI_KNOWLEDGE_OFFLINE` |
| Embedding | `PI_KNOWLEDGE_EMBEDDING=local:multilingual-e5-small` (default) or `openai:<model>` + `OPENAI_API_KEY` |
| Reranker | `PI_KNOWLEDGE_RERANKER`, `PI_KNOWLEDGE_RERANKER_DTYPE`, `PI_KNOWLEDGE_RERANKER_API_*` |
| Behavior | `PI_KNOWLEDGE_WATCH`, `PI_KNOWLEDGE_AUTO_INJECT`, `PI_KNOWLEDGE_SEARCH_PROFILE`, `PI_KNOWLEDGE_MIN_HYBRID_SCORE` |
| PDF / OCR | `PI_KNOWLEDGE_PDF_ENGINE`, `PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS`, `PI_KNOWLEDGE_OCR_ENGINE`, `PI_KNOWLEDGE_OCR_CMD` |

## Data & Safety

```
~/.pi/knowledge/
├── knowledge.db      ← SQLite: metadata + chunks + FTS5 (+ formula/label/symbol tables)
├── vectors/          ← binary embedding vectors per KB
└── models/           ← cached ONNX models
```

- Read-only on your project — nothing in indexed directories is ever written.
- Backup = copy the knowledge directory; reset = delete it; relocate = `PI_KNOWLEDGE_DIR`.
- Schema migrations run automatically on upgrade; embedding-model changes are detected and vector retrieval skips incompatible KBs with a warning instead of returning garbage.

## Development

```bash
npm install
npm run typecheck
npm test                        # unit suite
npm run build
npm run eval -- --fixture       # deterministic golden-eval release gate
npm run test:e2e                # smoke; PDF/DOCX cases need fixture env vars
```

## Acknowledgments

Built on [nczz/pi-knowledge](https://github.com/nczz/pi-knowledge) — thank you for the excellent foundation.

## License

MIT
