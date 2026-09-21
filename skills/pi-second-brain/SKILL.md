---
name: pi-second-brain
description: Local-first RAG knowledge base for coding agents. Use when the user asks to index, remember, or learn from files, docs, code, PDFs, arXiv papers, or URLs; to search indexed knowledge by meaning, exact symbol, formula, chemistry, engineering units, numbers, or table rows; or to manage knowledge bases (status, update, doctor, export, import, remove). Triggers include "index this", "second brain", "knowledge base", "search my papers", "ingest this PDF", "what does my corpus say about".
---

# pi-second-brain

A local-first RAG knowledge base: index anything (code with AST chunking, Markdown, LaTeX, scientific
PDFs with math, DOCX, URLs, Obsidian vaults, plain notes) into persistent knowledge bases under
`~/.pi/knowledge`, then search them with hybrid BM25 + local ONNX embeddings. Everything runs on the
user's machine — no API keys, no cloud.

## Bootstrap (only if the tools are not available)

First try calling `knowledge_status`. If the tool is unknown or missing, install the engine and
register its MCP server into this harness, then re-check:

```bash
npm install -g github:myusufalghifari10/pi-second-brain
pi-second-brain setup --all      # registers into detected harnesses (Claude Code, Codex, Cursor, Cline, Gemini CLI, OpenCode)
pi-second-brain list             # verify detection
```

After registering, tell the user to restart the harness so the MCP server loads, then retry
`knowledge_status`. On Pi, the native extension is used instead: `pi install /path/to/pi-second-brain`.
To undo registration: `pi-second-brain remove --all`.

## Core workflow

1. `knowledge_plan` before broad indexing — inspect scannable counts, suggested exclusions, and
   technical skips; show the user and confirm scope for risky or low-signal text (`.env`, credentials,
   lockfiles, vendor, build output). After confirmation, re-run `knowledge_add` with
   `include_suggested_text` or focused `include_paths`.
2. `knowledge_add` with a descriptive KB name — one call for a directory root with
   `include_paths`/`exclude_paths`, not one call per file. Pass `http(s)://` sources directly.
3. `knowledge_search` to answer; `knowledge_symbol_search` first for exact symbols, config keys,
   env vars, routes, and headings.
4. `knowledge_update` refreshes source-backed KBs incrementally; `knowledge_doctor` diagnoses
   staleness, orphans, stuck jobs, and missing vectors with concrete actions.

## Search-mode decision

| Mode | Use when |
|------|----------|
| `fast` | Exact symbols, filenames, commands, error codes, config keys, numbers (`11.94`, `H2O`) |
| `hybrid` (default) | Most questions with lexical anchors — BM25-anchored + vector fusion |
| `semantic` | Conceptual queries where wording differs; fallback when hybrid returns nothing |
| `adaptive` | The answer needs neighboring chunks / surrounding implementation context |
| `deep` | High-stakes answers — hybrid + cross-encoder reranking |
| `auto` | Engine picks and retries alternate modes on weak results |

If results are empty or weak but the KB should contain the answer, retry once with a different mode
before concluding the corpus lacks it. If top results are repetitive, retry with
`diversity: "strong"` or mode `adaptive` before raising `limit`. Add `expand_neighbors: 1-2` to
attach adjacent chunks of the top hit when the answer needs surrounding context.

## Science layer (why this brain reads papers well)

- Math notation matches across spellings: `x²` ⇔ `x^2`, `α` ⇔ `\alpha`, `≤` ⇔ `\leq`.
- Chemistry: `H2SO4` ≡ `H₂SO₄` ≡ `\ce{H2SO4}`; case-sensitive (`Co` ≠ `CO`).
- Units: `N·m` ≡ `N m`. Numbers: `11.94` is one token; `2,056` ≡ `2056`; `shell-2` ≡ `shell 2`.
- PDF tables carry their introducing sentence and `Row: <label> |` stamps, so a bare number returns
  the row with its method name. For a table hit, follow up with `expand_neighbors: 1` to pull the
  narrative context.
- Query-by-formula works: `$E=mc^{2}$` matches indexed display formulas (`match_reason: "formula"`).
- LaTeX labels: a query naming a `\label` retrieves or boosts the defining/referenced chunks.

## Retrieval discipline

1. Definition-first: for "what is X" questions about notation or terms, retrieve the definition
   before interpreting.
2. Verification questions need two independent chunks; one hit is a lead, not an answer.
3. Quote numbers verbatim with their units and source line; never reconstruct digits from memory.
4. Before interpreting any comparison, state the triplet: A = number (source), B = number (source),
   therefore A>B/A<B — if a mapping is not verified, the direction is UNKNOWN; say so.
5. Destructive tools (`knowledge_remove`, `knowledge_clear`) require explicit user confirmation and
   `confirm: true` — prefer `knowledge_export` first for backup.
