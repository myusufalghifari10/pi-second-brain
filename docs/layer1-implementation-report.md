# Layer 1 — Math & Science-Aware Chunking: Implementation Report

Status: COMPLETE — all T1–T10 implemented, all gates green
Base: `9d117a3` (chore: release 0.10.1) · Branch: `main` · 5 commits
Spec: `docs/layer1-math-science-chunking-plan.md` (APPROVED, amended with the two supervisor-approved corrections: ς→sigma entry; superscript fold count 15)

---

## 1. Per-task acceptance criteria → named tests

All tests live under `test/unit/`. Status is from the final full-suite run (287/287 green).

### T1 — math-text module (`src/indexer/math-text.ts`, `test/unit/math-text.test.ts`)
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) every §3.2 test vector exact | `canonicalizeMathText > x² + y² = r² → …`, `α ≤ β → …`, `x^2 + y^{ij} → …`, `\frac{a}{b} unchanged`, `E = mc² → …`, `a_{ij} unchanged`, `a₁ → a sub1`, `snake_case_and_more unchanged`, `∫₀^∞ f(x)dx → …` | pass |
| (b) identity fast-path returns unchanged string for non-math input | `identity fast-path returns the same string reference for non-math input` (implementation returns the input by reference; JS string `===`/`toBe` is value-identical, verified also via `non-alphanumeric braced exponent → bare pow` negatives) | pass |
| (c) exactly 92 map entries + 15 sup + 14 sub folds | `has exactly 92 entries`, `has exactly 15 superscript folds`, `has exactly 14 subscript folds`, `fold sets and map do not overlap`, `folds are plain alphanumeric words (FTS unicode61 safe)` | pass |
| (d) loop test over every entry/fold | `every map entry folds its char to its word`, `every superscript/subscript fold yields its composite token` | pass |
| (e) check + typecheck clean | gate outputs (§2) | pass |

Additional verification beyond the plan: a one-off node script compared all 92 map keys/words and all 29 fold chars codepoint-by-codepoint against the plan doc enumeration — exact match.

### T2 — `preTokenizeForFTS` wiring (`src/indexer/chunker.ts`)
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) all 7 existing `preTokenizeForFTS` tests pass unchanged | existing `preTokenizeForFTS` describe (untouched — `git diff` shows zero removed expectation lines) | pass |
| (b) `x² + y²`→pow2, `α ≤ β`→alpha/leq, `\alpha \leq \beta`→alpha/leq symmetry | `folds superscripts into pow composite tokens`, `folds greek letters and relations into canonical words`, `keeps LaTeX command input symmetric at the token level` | pass |
| (c) full unit suite green | gate outputs (§2) | pass |

### T3 — region scanner (`splitProtectedSegments`, `splitOversizedProtected`)
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) `$$` block with blank line = ONE math segment | `keeps $$ block with internal blank line as exactly ONE math segment` | pass |
| (b) unclosed `$$` → plain text | `unclosed $$ stays plain text (fail-open)` | pass |
| (c) ```math fence → math; ```js fence with pipes = ONE code, zero table | `` ```math fence → math segment ``, `` ```js fence with pipe lines inside is ONE code segment with zero table segments `` | pass |
| (d) 3-line pipe table, correct line numbers | `3-line pipe table → one table segment with correct line numbers` | pass |
| (e) `\begin{align}…\end{align}` in md and latex modes | `\begin{align}…\end{align} is math in markdown mode`, `\begin{align}…\end{align} is math in latex mode` | pass |
| (f) oversized align splits only at `\\`; oversized table only at rows | `splits oversized math only at top-level \\ row separators`, `does not split at \\ inside braces`, `splits oversized tables only at row boundaries` | pass |
| (g) contiguity / line-number reconstruction property test | `segments are contiguous and line numbers reconstruct the input exactly` | pass |

Extra coverage: single-line `$$…$$` atomic, escaped `\$` never opens, unclosed code fence/equation fail-open, single pipe row is not a table, `\[ … \]` display math, `tabular` table only in latex mode, piece line-number consistency.

### T4 — metadata extractors
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) frontmatter valid + malformed fail-open | `parses title, tags list, and aliases`, `parses comma-string and bare values`, `returns empty + bodyStartLine 1 for missing frontmatter`, `…unclosed frontmatter`, `…malformed list values`, `ignores non-allowlisted keys` | pass |
| (b) wikilinks targets, deduped, caps | `extracts targets from plain, aliased, and heading links, deduped`, `caps at MAX_LINKS` | pass |
| (c) `\label{eq:mass}` | `extracts label values` | pass |
| (d) formulas from math segments only, capped 10×2000 | `extracts only math segments verbatim`, `caps at MAX_FORMULAS entries of MAX_FORMULA_CHARS with ellipsis truncation` | pass |

### T5 — `chunkMarkdown` rewrite
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) all existing chunkMarkdown tests pass unchanged | existing `chunkMarkdown` describe (zero removed expectation lines; the only removed diff line is a duplicated `import { chunkFile }` consolidated into the top import block for biome) | pass |
| (b) `$$` block with blank line lands intact in exactly one chunk | `keeps a $$ block containing blank lines intact inside exactly one chunk` | pass |
| (c) >6000-char pipe table splits at row boundaries only | `splits oversized pipe tables only at row boundaries` (asserts every chunk starts with `|` or heading text, ≤6000 chars, rows whole) | pass |
| (d) frontmatter → metadata + `Title:`/`Tags:`/`Aliases:` embedding lines | `strips frontmatter and carries title/tags/aliases into metadata and embedding text` | pass |
| (e) wikilinks → `Links:` embedding line | `extracts wikilinks into metadata and embedding text` | pass |
| (f) `content_tokenized` of β-chunk contains `beta` | `canonicalizes math unicode into content_tokenized` (also asserts chunk content stays verbatim `β²`) | pass |

### T6 — `chunkText` protection
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) existing chunkText tests pass unchanged | existing `chunkText` describe (untouched) | pass |
| (b) `.txt` `$$…blank…$$` → single intact chunk | `keeps a $$ block with blank lines intact in a single chunk with formulas metadata` | pass |
| (c) `formulas` metadata present | same test (`metadata.formulas` equality assertion) | pass |

### T7 — `chunkLaTeX` + `detectFileType` + routing
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) `detectFileType("a.tex")` → `"latex"` | `routes .tex files through chunkFile as latex chunks` — `detectFileType` is module-private (not exported pre-change; plan did not list an export), so the criterion is proven through the public routing contract: `chunkFile(content, "paper.tex")` stamps `file_type: "latex"` on every chunk, which only the new detection entry produces | pass |
| (b) preamble + 2 sections + equation with blank line → ≥3 chunks, equation intact verbatim, breadcrumbs, `Preamble` label | `splits preamble and sections with breadcrumbs and keeps equations intact` | pass |
| (c) `chunkFile(…, "f.tex")` routing proof | `routes .tex files through chunkFile as latex chunks` | pass |
| (d) labels in metadata_json + `Labels:` prefix | same test as (b): `labels` metadata equality + `buildChunkEmbeddingText` contains `Labels: eq:motion` | pass |

Extra: `falls back to a single chunk for tiny latex content` (§4.4.5 fallback).

### T8 — symbols + filter aliases + doc boost
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) tex `\section{Methods}` → one `heading` symbol `Methods` | `extracts latex sectioning commands as heading symbols with depth metadata` (chapter/section/subsubsection depths 1/2/4 also asserted) | pass |
| (b) `normalizeFileTypeFilter("tex")` → `"latex"` | `normalizes latex file type aliases` (tex/ltx/latex) | pass |
| (c) guide-intent doc boost parity on `docs/*.tex` | `boosts guide-intent queries on latex documentation identically to markdown` (`documentation_boost === 0.35` for both; equal adjusted scores) | pass |

### T9 — end-to-end retrieval proof (engine-less FTS; `test/unit/math-retrieval.test.ts`)
| Criterion | Test name(s) | Status |
|---|---|---|
| (a) index `$$E = mc^2$$` doc; fast-mode query `mc²` hits it | `finds an indexed $$E = mc^2$$ doc from the unicode query mc² (fast mode)` | pass |
| (b) query `α` finds `\alpha` doc | `finds a \alpha doc from the unicode query α` | pass |
| (c) query `x^2` finds `x²` doc via `pow2` (canonicalize-last proof) | `finds an x² doc from the ASCII query x^2 via the pow2 token (canonicalize-last proof)` — asserts `normalizedQueryText("x^2") === "pow2"` (not shredded `pow`) | pass |
| (d) query `Ω` finds `\Omega` doc | `finds a \Omega doc from the unicode query Ω (case-folded canonical name)` | pass |

### T10 — docs & contracts (file-content verification, not unit tests)
| Criterion | Verification | Status |
|---|---|---|
| (a) AGENTS.md contract line | `grep -c "Math/table-aware chunking is a behavior contract" AGENTS.md` → 1 (exact plan text, Extension Development section) | pass |
| (b) README capability paragraph + `latex` file type | Highlights bullet + "Research-Backed Retrieval" paragraph mentioning `latex` file type (`.tex`/`.ltx`/`.latex`) | pass |
| (c) CHANGELOG entry | `[Unreleased]` Added ×4 + Changed (re-index note) | pass |
| (d) chunking-strategies.md region rules + canonical map summary | new §9 (保護區域 / 正規化 / metadata), matches 繁體中文 file style | pass |
| (e) technical-decisions.md ADR | ADR-020: canonicalize-last + single-letter-variable limitation + pow/sub composite-token rationale, 繁體中文 ADR format | pass |

---

## 2. Gate outputs (final tree, run before commit 4)

| Gate | Command | Result |
|---|---|---|
| Lint/format | `npm run check` | clean — zero warnings/errors, "Checked 55 files", no fixes needed |
| Types | `npm run typecheck` | clean — no errors |
| Unit suite | `npx vitest --run test/unit/ --testTimeout=15000` | 20 files, **287/287 passed** (baseline 217 + 70 new), ~104s |
| Startup smoke | `node --experimental-strip-types -e "import('./index.ts')"` | pass, no output (startup-light intact) |
| Diff review | `git diff 9d117a3..HEAD --stat` | only allowed files (see §3); zero changes in `src/engine.ts`, `src/search/query.ts`, `src/search/bm25.ts`, `src/embedding/*`, `src/storage/*`, `package.json` |

Every intermediate commit state was gate-verified with the same command set before its commit: commit-1 tree 271/271, commit-2 tree 281/281, commit-3/final tree 287/287 — each with clean check + typecheck.

---

## 3. Commits (5 on main, none pushed)

| # | Hash | Message |
|---|---|---|
| 0 | `99084cc` | `docs: add layer 1 math-aware chunking execution plan` (amended to carry the two supervisor-approved spec corrections; previously `9c59059`) |
| 1 | `a9accd1` | `feat: add math text canonicalization and protected-region scanner` (T1–T4) |
| 2 | `870bc71` | `feat: math and table aware markdown/text chunking with vault metadata` (T5, T6, T9) |
| 3 | `491efba` | `feat: latex-aware chunking, symbols, and file-type filters` (T7, T8) |
| 4 | `374c2e4` | `docs: document math-aware chunking contracts` (T10) |

`git diff 9d117a3..HEAD --stat`: 15 files, +1959/−79 — all within the allowed list. Blast-radius grep (engine/query/bm25/embedding/storage/package.json) clean.

---

## 4. Deviations from plan

1. **Commit 0 amended** (approved): the previously committed plan doc (`9c59059`) contained the stale 18-superscript enumeration; the supervisor-approved corrections (ς→sigma entry, 15 sup folds) existed only in the working tree. Folded into commit 0 via `git commit --amend` to keep the exact 5-commit contract while making the committed spec current-truth.
2. **chunker.test.ts import consolidation**: the new T7 tests needed `chunkFile`/`chunkLaTeX` imports; biome flagged the pre-existing standalone `import { chunkFile }` line as a duplicate (`noRedeclare`/`noUnusedImports`). Consolidated into the top import block — 2 removed lines are an import statement only; zero test expectations changed.
3. **T7(a) via routing proof**: `detectFileType` is module-private and the plan's file list doesn't add an export, so criterion (a) is tested through the public `chunkFile` file-type stamping instead of a direct call.
4. **Dogfood not run**: plan §7 marks the `pi -e ./index.ts` one-shot as post-merge sanity, not a release gate — not executed here, to be recorded post-merge.

## 5. Residual risks (per plan §8, accepted)

- Region-scanner false positives on prose containing literal `$$` (fail-open caps damage at one larger chunk).
- `pow2`-style tokens appear in `content_tokenized` for code content containing `^` (lexical-only, symmetric, never in returned content).
- ASCII `_` subscripts stay asymmetric with unicode subscripts by design (snake_case safety).
- Markdown/LaTeX chunks re-embed on first `knowledge_update` after upgrade (intended; bounded to md/tex files; CHANGELOG documents the step).

## 6. Out-of-band finding

- `package.json` carries a **pre-existing, uncommitted** `allowScripts` block (native build allowlist) that predates this task. It is a forbidden file for this run: it was left byte-identical, never staged, and is not part of any commit. Decision on committing it belongs to the supervisor.
