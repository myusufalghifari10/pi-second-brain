# pi-second-brain

**A local-first RAG knowledge base for the [Pi](https://pi.dev) coding agent — your agent's second brain.**

Index codebases, docs, PDFs, arXiv papers, URLs, and notes into persistent knowledge bases, then let your agent search them across sessions — by meaning, by exact symbol, by **formula**, or by **number**. 100% local: SQLite + FTS5, ONNX embeddings, zero API keys, zero telemetry.

```
577 passing tests · 48/48 golden-eval gate (recall@5 = 100%) · 22+ adversarial audit rounds · 13 tools
```

> **Provenance.** `pi-second-brain` is an independently maintained, heavily hardened fork of
> [nczz/pi-knowledge](https://github.com/nczz/pi-knowledge) (v0.10.1 base). The runtime namespace is kept for
> compatibility: environment variables stay `PI_KNOWLEDGE_*`, tools stay `knowledge_*`, storage stays `~/.pi/knowledge`.

---

## Why

Coding agents lose project context between sessions and cannot fit a repository into one prompt. pi-second-brain gives Pi durable, searchable project memory:

- **Search by meaning** — hybrid BM25 + vector embeddings with weighted score fusion; conceptual queries find code/docs even when the wording differs.
- **Search by evidence** — `fast` mode for exact symbols, identifiers, error codes, and numbers; `knowledge_symbol_search` for functions, classes, config keys, and headings.
- **Search science documents the way they're written** — math notation, chemical formulas, engineering units, LaTeX labels, and PDF tables are all first-class retrieval targets.
- **Stay private** — everything runs on your machine. No project file is ever modified; indexes live under `~/.pi/knowledge/`.

## What this fork adds over upstream

The fork started from a working core and went through three engineering campaigns:

**Science & math retrieval layer** (L1–L4)
- Math-aware chunking: display math (`$$`, ```` ```math ````, `\begin{equation}`, `\[..\]`), pipe tables, and fenced code are atomic — never split mid-structure.
- Cross-notation matching: `x²` ⇔ `x^2`, `α` ⇔ `\alpha`, `≤` ⇔ `\leq` — canonicalized symmetrically on index and query.
- **Formula retrieval**: a dedicated formula index matches query formulas like `$E=mc^{2}$` against indexed display formulas; exact and fuzzy matches boost results or inject formula-only chunks with `match_reason: "formula"`.
- **Chemistry**: `H2SO4` ≡ `H₂SO₄` ≡ `\ce{H2SO4}` — unicode subscripts, charges, hydrate dots, arrows, and parenthesized groups unify into one case-sensitive signature (`Co` never matches `CO`).
- **Units**: `N·m` ≡ `N m` in keyword search, over a frozen conservative SI unit list.
- **Numeric token symmetry**: `11.94` is one token; `shell-2` ≡ `shell 2`; `2,056` ≡ `2056` — numbers in tables and prose are now fast-mode searchable.
- **PDF table intelligence**: table blocks keep their introducing narrative sentence (`Context:` line) and every data row is stamped `Row: <label> |`, so a query for a bare number returns the row **with its method name**.
- **LaTeX label graph**: `\label`/`\ref` resolve through scope keys — a query naming a label retrieves or boosts the defining/referenced chunks; collisions resolve as *unresolved*, never wrong.
- Optional PDF sidecar (`marker` / `docling`, fail-open to `unpdf`), content-hash conversion cache, image persistence + optional tesseract OCR for caption-less figures.

**Retrieval & agent UX**
- `expand_neighbors` — opt-in adjacent-chunk context (`context[]` with `prev`/`next` relations) on the top hit.
- Adaptive context windows, MMR-style diversity reranking, optional cross-encoder reranking (`deep` mode), confidence gating against false positives.
- File watcher auto-reindexing (`PI_KNOWLEDGE_WATCH=true`), opt-in context auto-injection (`PI_KNOWLEDGE_AUTO_INJECT=true`), `knowledge_doctor` health scoring with concrete repair actions.
- Obsidian vault support: frontmatter `title`/`tags`/`aliases` and `[[wikilinks]]` become chunk metadata.

**Hardening & verification**
- **22+ adversarial audit rounds** run by independent AI reviewer/worker subagents: ≈120 defects found and fixed — including a silent reranker failure that collapsed every deep-mode score to 0, a watcher race that lost file changes, tokenization asymmetries (`H2O` unfindable in fast mode), and AST indexing holes (TS namespaces, C++ function-pointer members).
- **Feature verification campaign**: 56/56 checks across the full feature matrix (ingest, search, lifecycle, watcher, doctor, export/import).
- **Blind paper exams** (dogfood): three arXiv PDFs ingested *unread* — then 10 hard technical questions each, answered using retrieval only. Graded 8.5/10 on the first paper and 9.5/10 on the second, with every unverifiable claim flagged instead of guessed.
- A byte-deterministic **golden eval harness** (`npm run eval`, 48/48 queries, recall@5 = 100%) as a hard release gate: any indexing or ranking change that flips a golden result fails visibly.

## Highlights

- **Local-first** — indexes under `~/.pi/knowledge/`; local ONNX embeddings (no API key); explicit offline mode.
- **Hybrid retrieval** — lexical-anchored BM25 + dense vectors, normalized weighted score fusion, six modes (`fast` / `semantic` / `hybrid` / `deep` / `adaptive` / `auto`) plus intent aliases (`code`, `config`, `errors`, `docs`, `decision`).
- **Code-aware indexing** — recursive AST chunking (tree-sitter) for TypeScript/JavaScript, Python, Go, Rust, Java, Bash, GNU C, C++, and QML; symbol index for methods, classes, config keys, and headings.
- **Document-aware indexing** — Markdown headings/breadcrumbs, LaTeX sections, PDF (sidecar or text-layer), DOCX, URLs, plain text.
- **Large-project stability** — persisted indexing progress, capped batches, streamed vector scans, stuck-job detection, incremental updates.
- **Diagnosable** — per-result provenance (chunk id, match reason, score, freshness), ranking diagnostics, `knowledge_status`, `knowledge_doctor`.

## Quick Start

Requirements: Node ≥ 22. Model weights (~150 MB) download once and are cached locally.

```bash
# Install into Pi from a local clone
git clone https://github.com/myusufalghifari10/pi-second-brain.git
pi install /absolute/path/to/pi-second-brain
```

Then just talk to your agent:

```
> Index my project at ~/work/my-app as "my-app"
> Search my knowledge base for "authentication flow"
> What does the formula index say about \int_0^\infty e^{-x^2}dx ?
> Which table reports the 62.86 number, and for which method?
```

Optional integrations:

```bash
pip install marker-pdf        # or: pip install docling  — better PDF math extraction (auto-detected, fail-open)
sudo pacman -S tesseract      # or apt install tesseract-ocr — OCR for caption-less PDF figures
export PI_KNOWLEDGE_WATCH=true        # auto re-index watched directory KBs
export PI_KNOWLEDGE_AUTO_INJECT=true  # agent auto-searches relevant knowledge before answering
```

OMP compatibility is inherited through the same packaged `extension.js` entry (`omp install /path`).

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

Profiles (`low_token`, `precision`, `recall`, `long_context`) tune result count, snippet length, and rerank breadth; explicit parameters always win.

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
npm run eval -- --fixture       # deterministic golden gate (must be 48/48)
npm run test:e2e                # smoke; PDF/DOCX cases need fixture env vars
```

The release gate is explicit: `check` → `typecheck` → unit tests → build → golden eval → e2e. Any skipped gate must be reported, never assumed.

## Acknowledgments

Built on [nczz/pi-knowledge](https://github.com/nczz/pi-knowledge) — thank you for the excellent foundation. All science-layer, hardening, and verification work in this fork is independent.

## License

MIT
