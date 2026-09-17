# Layer 3 — Formula Retrieval (query-by-formula, structural-lexical)

Status: APPROVED SPEC (supervisor-authored, Yusuf-ordered execution via subagents)
Date: 2026-09-18
Predecessors: Layer 1 (math-aware chunking, commits 99084cc..0297af5), Layer 2 (PDF sidecar, commits 4dbc9a2..f713d16)

## §0 Purpose & success

**Purpose.** L1 made formulas survive chunking and canonicalize notation for FTS. But retrieval is still
*lexical over chunk text*: a query `$\int_0^\infty e^{-x^2}dx$` competes with prose tokens and cosmetic
LaTeX variants (`\dfrac` vs `\frac`, `\le` vs `\leq`, `{x}` vs `x`, spacing, `\mathrm`) break matching.
L3 adds a **dedicated formula index**: formulas are extracted at index time, normalized into a canonical
token signature, stored in their own table+FTS, and queried when the query itself contains a formula.
Formula matches boost already-retrieved chunks and inject formula-only chunks with a new
`match_reason: "formula"`.

**Success (binding).** Adding a document containing `$$E = mc^2$$` and searching
`$E=mc^{2}$` (different spacing/braces) returns that chunk with `match_reason: "formula"`. Queries
without math produce **byte-identical** results to pre-L3. No new npm dependencies. No new env vars.

**Design posture.** Structural-LEXICAL, not AST. This follows the ARQMath lesson (Mansouri et al.):
symbolic n-gram / normalized-token baselines are competitive with full MathIR systems at a fraction of
the complexity — full SLT/SymPy parsing is brittle and dependency-heavy. *(External validation flagged
unverified-today: search engines degraded 2026-09-18; claim rests on L1 research notes + domain knowledge.)*

## §1 Scope

**In:**
- `src/indexer/formula-normalize.ts` (NEW): formula normalization + query-side formula extraction
- `src/storage/sqlite.ts`: SCHEMA_VERSION 5→6 (formulas table, formulas_fts, sync API, kb flag column)
- `src/engine.ts`: formula-row lifecycle on chunk add/remove, one-time backfill per KB, search fusion
- `src/engine.ts` result types: `match_reason` union += `"formula"`
- tests: `test/unit/formula-normalize.test.ts` (NEW), `test/unit/storage-formulas.test.ts` (NEW),
  `test/unit/engine-formula-search.test.ts` (NEW); existing suites must stay green
- docs: README, ADR-022, known-pitfalls, CHANGELOG

**Out (non-goals):**
- AST/skeleton structure matching, MathML, SymPy-style equivalence (deferred)
- Per-formula embeddings / vector index over formulas (chunk-level vector already carries formula text)
- New env vars, new config, new npm deps (`package.json` must remain untouched)
- Touching: `src/search/bm25.ts`, `src/search/query.ts`, `src/embedding/**`, `src/indexer/pdf-sidecar.ts`,
  `src/indexer/chunker.ts` (formulas already arrive via `metadata.formulas`), `src/indexer/math-text.ts`
  (imports only), `src/indexer/symbols.ts`

## §2 Current-world facts (verified 2026-09-18)

| Fact | Evidence |
|---|---|
| Chunk metadata already carries raw display formulas: `metadata.formulas: string[]` | `src/indexer/chunker.ts:726` (`if (formulas.length > 0) metadata.formulas = formulas`), populated per chunk by `pushMarkdownChunk`/math-block buffering (:644-677) |
| Chunk id is deterministic: sha256 of `filePath\0fileType\0startLine\0endLine\0metadataJson\0content` | `src/indexer/chunker.ts:444-454` (`chunkIdentityHash`) |
| Schema migrations are per-version TS blocks; JS work allowed inside a migration (v3 does PRAGMA checks) | `src/storage/sqlite.ts:346-415` (`runMigrations`) |
| FTS pattern: external-content fts5 + ai/ad/au triggers | `src/storage/sqlite.ts:165-185` |
| engine.search: `retrievalMode` = fast(bm25) / hybrid(bm25+vector); raw query passed post-Amendment-B | `src/engine.ts:1718-1795`, bm25 call sites :1767/:1791 |
| `match_reason` union: `"bm25" | "vector" | "hybrid" | "rerank" | "symbol" | "adaptive"` | `src/engine.ts:124` |
| `insertChunks` batch call site (add path) | `src/engine.ts:1129` |
| Unicode canonical maps exist and are exported (Greek word-forms, sup/sub folds, arrows/ops) | `src/indexer/math-text.ts:6,110,128` |
| `canonicalizeMathText` (L1) is TEXT canonicalization (prose-oriented); NOT formula-grade (case-folds Greek lowercase, splits letter-digit) | `src/indexer/math-text.ts:164` |
| Full vitest baseline: 317 passed + 1 skipped (E5 env-gated) | 2026-09-18 supervisor run at `546ec1e` |
| Baseline gates: `npm run check` clean, `npm run typecheck` clean | 2026-09-18 supervisor run |

## §3 Spec

### §3.1 Formula normalization — `src/indexer/formula-normalize.ts` (NEW)

```ts
export interface NormalizedFormula {
  raw: string;        // input, trimmed
  normalized: string; // canonical tokens, single-space joined
  tokens: string[];
  tokenCount: number;
}
export function normalizeFormula(raw: string): NormalizedFormula | undefined; // undefined = degenerate
export interface QueryFormulas { formulas: NormalizedFormula[]; cleanedQuery: string; }
export function extractQueryFormulas(query: string): QueryFormulas;
```

**`normalizeFormula` pipeline (normative, in order):**
1. Trim; strip outer math delimiters (repeatedly, while the whole remaining string stays wrapped): `$$…$$`, `$…$`, `\[…\]`, `\(…\)`, and bare `…` (no delimiters is fine).
2. Remove layout commands: `\displaystyle`, `\limits`, spacing `\,` `\;` `:` `\!` `\quad` `\qquad`, and `\left`/`\right`/`\big`/`\Big`/`\bigg`/`\Bigg` (keep the delimiter character itself).
3. Unwrap style wrappers, keeping the argument: `\mathrm \mathit \mathbf \mathsf \mathtt \mathcal \mathbb \mathfrak \text \textrm \operatorname \dfrac→frac \tfrac→frac \cfrac→frac`.
4. Unicode canonicalization (reuse L1 maps): superscripts → `pow<n>`/`powplus`/…, subscripts → `sub<n>`/`subminus`/`subeq`, Greek → word form (`α→alpha`, `Σ→sigma`…), operators/arrows per `MATH_UNICODE_MAP`.
5. TeX alias table → canonical form (frozen list; worker may add entries ONLY with a paired test vector):
   `\le`/`\leq`→`leq` · `\ge`/`\geq`→`geq` · `\ne`/`\neq`→`neq` · `\to`/`\rightarrow`→`to` · `\leftarrow`/`\gets`→`leftarrow` · `\Leftrightarrow`/`\iff`→`iff` · `\Rightarrow`/`\implies`→`Rightarrow` · `\land`/`\wedge`→`land` · `\lor`/`\vee`→`lor` · `\varepsilon`→`epsilon` · `\vartheta`→`theta` · `\varphi`→`phi` · `\varpi`→`pi` · `\varrho`→`rho` · `\varsigma`→`sigma` · `\dots`/`\ldots`/`\cdots`→`dots` · `\cdot`→`cdot`.
6. Tokenize: TeX commands (`\[a-zA-Z]+`), alnum runs, single non-alnum op chars. **Braces/brackets/parens are removed from the token stream** (structural grouping, not matched) — ratified: this makes `{x}`≡`x` and `\frac{a}{b}`→`frac a b` without brace parsing. Mismatched braces tolerated (tokens still extracted).
7. Join tokens with single space. Undefined when: zero tokens, or trimmed length > `MAX_FORMULA_CHARS` (2000, reuse L1 constant).
8. **Case is preserved** (math is case-sensitive: `E` ≠ `e`; contrast with L1 text canonicalization).

**`extractQueryFormulas` (normative):**
1. Pull math segments using the L1 scanner (`splitProtectedSegments`, mode `math`-aware): segments of kind `math` are formulas.
2. Bare-TeX detection (ratified via supervisor decision 2026-09-18, worker escalation): a non-math segment is a formula when it contains ≥ 2 TeX commands (`/\[a-zA-Z]+/g`), OR ≥ 1 TeX command directly followed by a braced argument (`/\[a-zA-Z]+\{/`). Rationale: a command WITH an argument is real math usage (`\frac{a}{b}`, `\sqrt{x}`); a bare command name in prose ("the \frac command") is a mention, stays text. Additionally, text segments are scanned for inline `$…$` spans (escaped-`\$` aware) — the L1 scanner's inline-dollar mode is file-mode-gated and queries have no file mode.
3. `formulas` capped at 5 (first 5), each normalized; normalization rejects (`undefined`) are dropped silently.
4. `cleanedQuery` = query with math segments removed (trimmed). If it would become empty, `cleanedQuery` = original query (the text leg must never starve).
5. Zero formulas ⇒ `{ formulas: [], cleanedQuery: query }` — the dormant path. NOTE (ratified at review): `cleanedQuery` is part of the extraction contract and F2-verifiable, but the engine currently runs all text legs on the raw `query` — boosted/injected formula evidence REQUIRES the raw text leg (stripping math would starve cross-notation retrieval), so cleanedQuery is intentionally unused by engine.search today.

### §3.2 Storage — `src/storage/sqlite.ts`

- `SCHEMA_VERSION` 5 → **6**.
- **v6 migration = PURE SQL only** (no imports from indexer — enables parallel worker B):
```sql
CREATE TABLE IF NOT EXISTS formulas (
  id TEXT PRIMARY KEY,               -- sha256(kb_id \0 chunk_id \0 ordinal \0 normalized)
  kb_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  raw TEXT NOT NULL,                 -- original formula text
  normalized TEXT NOT NULL,          -- canonical token string
  content_tokenized TEXT NOT NULL DEFAULT '',  -- = normalized; feeds formulas_fts
  token_count INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_formulas_kb_chunk ON formulas(kb_id, chunk_id);
CREATE INDEX IF NOT EXISTS idx_formulas_kb_norm ON formulas(kb_id, normalized);
CREATE VIRTUAL TABLE IF NOT EXISTS formulas_fts USING fts5(
  content_tokenized, content=formulas, content_rowid=rowid);
-- ai/ad/au triggers, same pattern as chunks_fts (:173-185)
ALTER TABLE knowledge_bases ADD COLUMN formula_index_built INTEGER NOT NULL DEFAULT 0;
-- (guarded: check PRAGMA table_info first, v3/v5 precedent)
```
- `id` hashing: local `createHash("sha256")` inside sqlite.ts (it already imports `node:crypto` — adding `createHash` keeps the storage→indexer import direction absent).
- New exports (frozen contract):
```ts
export function replaceFormulasForChunk(db, kbId: string, chunkId: string,
  rows: Array<{ ordinal: number; raw: string; normalized: string; tokenCount: number }>): void; // txn: DELETE by (kb,chunk) + INSERT each
export function deleteFormulasForChunks(db, chunkIds: string[]): void;           // chunked IN-list
export function markFormulaIndexBuilt(db, kbId: string): void;                   // formula_index_built = 1
export function listChunksForFormulaBackfill(db): Array<{ id: string; kb_id: string; metadata_json: string }>; // all chunks
export function findExactFormulas(db, kbId: string, normalizedList: string[]): Array<{ chunk_id: string; normalized: string }>;
export function searchFormulasFTS(db, kbId: string, ftsQuery: string, limit: number): Array<{ chunk_id: string; normalized: string; rank: number }>;
```
- `searchFormulasFTS` uses the same safe FTS query building discipline as `prepareFtsTerms` (quoted OR terms; never pass raw user text as FTS syntax).

### §3.3 Engine lifecycle + backfill — `src/engine.ts`

- **Backfill** `ensureFormulaIndex(db, kbId)`:
  - Guard: in-process `Set<string>` of already-ensured kbIds + persistent guard `knowledge_bases.formula_index_built`.
  - If built: no-op. Else: `listChunksForFormulaBackfill` → for each chunk parse `metadata_json.formulas` → `normalizeFormula` rows → `replaceFormulasForChunk` → `markFormulaIndexBuilt`. On parse errors: skip chunk, continue.
  - Called at the top of `engine.search` (before formula fusion) and at the top of the add path (before first `addChunks`). Must never throw (wrap: failure = formula features dormant this process, log nothing new — fail-open).
- **Add path:** wherever `insertChunks(db, kb.id, batch)` runs (:1129), the same batch loop computes formula rows per chunk (parse `metadata_json` → normalize → `replaceFormulasForChunk`). Idempotent: replace-on-unchanged is avoided — only run for chunks actually inserted (added set), NOT unchanged (id equality ⇒ rows already correct).
- **Remove path:** wherever chunk deletion by id happens (`deleteChunksByIds` callers), call `deleteFormulasForChunks` with the same id set.
- **`kb delete`** (LOCKED — mirrors the existing explicit-delete pattern, sqlite.ts:469-474): `deleteKB` gains `DELETE FROM formulas WHERE kb_id = ?` before the `chunks` delete.

### §3.4 Search fusion — `src/engine.ts` (inside `engine.search`, post-merge, pre-threshold)

1. `const qf = extractQueryFormulas(query)` — BEFORE any other work. `qf.formulas.length === 0` ⇒ skip everything (zero behavioral/byte difference).
2. `ensureFormulaIndex(db, kbId)`.
3. Candidate collection:
   - Exact: `findExactFormulas(db, kbId, qf.formulas.map(normalized))` → score **1.0** per chunk (max over formulas).
   - Fuzzy: `searchFormulasFTS(db, kbId, quoted-OR-joined formula tokens, limit 50)` → score = `0.8 * (topRank - rank + 1) / topRank` (rank-normalized, monotone).
   - Combine per chunk: `formulaScore = max(exactScore, ftsScore)`.
4. **Boost leg:** for every already-retrieved result present in the map: `score += 0.35 * formulaScore` (constant `FORMULA_BOOST = 0.35` defined in `src/search/ranking.ts`, exported).
5. **Injection leg:** map entries absent from results → fetch chunk rows (existing row-fetch helper used by bm25/vector legs), build result objects, `match_reason: "formula"`, sorted by formulaScore desc, **filters applied first, then capped at 5** (post-review hardening: cap-then-filter under-filled results when top-5 candidates all failed a filter — filter-then-cap is the ratified order). Must respect `kb_id` and `filters` (esp. `file_type`) exactly like other legs. The kb trust multiplier applied to retrieved legs applies to injected scores too (post-review hardening).
6. `match_reason` union (LOCKED: grep confirms engine.ts is the only definition/consumer site — engine.ts:124 plus the result-construction sites inside engine.ts) += `"formula"`.
7. Rerank leg: injected formula results participate as normal inputs (they are real results; rerank may reorder — accepted).
8. Threshold: injected results bypass `MIN_HYBRID_SCORE` (their evidence is formula-exact, not lexical-prose) — ratified.

## §4 Frozen worker contracts (parallel wave)

| Worker | Owns (files) | Depends on | Git |
|---|---|---|---|
| A | `src/indexer/formula-normalize.ts`, `test/unit/formula-normalize.test.ts` | nothing | none (orchestrator commits) |
| B | `src/storage/sqlite.ts`, `test/unit/storage-formulas.test.ts` | nothing (pure SQL + API taking pre-normalized rows) | none |
| D (docs) | `README.md`, `docs/technical-decisions.md` (ADR-022), `docs/known-pitfalls.md`, `CHANGELOG.md` | spec only | none |
| C (wave 2) | `src/engine.ts`, `src/search/ranking.ts`, `test/unit/engine-formula-search.test.ts` | A + B merged | none |

Interface pin: B's `replaceFormulasForChunk` receives **already-normalized** rows (normalization is A's job; C composes). Gates per worker: `npx biome check --write <own files>` then `npx biome check .` (read-only verify), `npm run typecheck`, **scoped** vitest (`npx vitest --run test/unit/<own-test-file>`). NOTE: full `typecheck` may transiently fail while the sibling worker is mid-edit — retry once, then move on; the orchestrator re-runs all gates authoritatively between waves. Orchestrator runs FULL gates between waves (no concurrent full-suite runs).

## §5 Criteria → tests

- **F1** normalizeFormula vectors (≥20): `E=mc^2` ≡ `$E = mc^{2}$` ≡ `\mathrm{E}\!=\!mc^2`; `\dfrac{a}{b}`≡`\frac{a}{b}`≡`\frac a b`; `\le`≡`\leq`; `α`≡`\alpha`; `ε`≡`\varepsilon`≡`\epsilon` (all → `epsilon`); **`α` ≠ `ε`** (different base words); case: `E` ≠ `e`; brace removal: `{x}+{y}` ≡ `x+y`; `\left( x \right)` ≡ `(x)`; `{x}` ≡ `x`; `\frac{a}{b}` → tokens `frac a b`.
- **F2** extractQueryFormulas: `"solve $x^2=4$ fast"` → 1 formula + cleaned `"solve fast"`; plain text → `[]` + cleaned===input; bare-TeX `"use \frac{a}{b} here"` → 1 formula; >5 formulas → capped 5; degenerate `$…$` dropped.
- **F3** schema: fresh open ⇒ `schema_version`=6, tables+triggers exist, `formula_index_built` column exists.
- **F4** backfill+sync: seed chunks via `insertChunks` with formula-bearing metadata → `ensureFormulaIndex` → rows exist, kb marked built, second call no-ops; add-unchanged does not duplicate; delete removes rows.
- **F5** (ratified via supervisor decision 2026-09-18, worker escalation — live probe showed `$E=mc^{2}$` is always bm25-retrieved because the L1 metadata prefix indexes `E = mc pow2`, so injection can never fire for it): (i) query `$E=mc^{2}$` ⇒ correct chunk with a **measurable formula boost**: its score exceeds the same chunk's score for the plain-text equivalent query `e=mc^2` (no delimiters, no TeX commands ⇒ no fusion; ratified baseline — the earlier `E = mc pow2` literal returns zero fast-mode results because the letter-digit split renders `{mc, pow}` which strict-AND misses the indexed composite `pow2`; `e=mc^2` yields exactly the formula query's bm25 terms so the delta isolates the boost leg) by exactly `FORMULA_BOOST` (0.35); match_reason stays the normal leg's value. (ii) query `\mathrm{E}\!=\!mc^2` (F1-ratified ≡ `E=mc^2`, same normalized signature) in **fast** mode ⇒ bm25 strict-AND provably misses (term `mathrm` unindexed) ⇒ **injection fires**: `match_reason: "formula"`, correct chunk, respects filters before the cap (post-review hardening, see §3.4.5) and the cap itself.
- **F6** filters: formula injection respects `kb_id` + `filters.file_type` (pdf fixture from L2 re-usable).
- **F7** regression: full suite ≥ 317 passed + 1 skipped, plus new tests; `npm run check`/`typecheck` clean.
- **F8** resilience: query with formula on empty index (backfill marked built with zero formulas / fresh kb) ⇒ no crash, plain results.

## §6 Tasks & waves

| # | Task | Worker | Wave | Acceptance |
|---|---|---|---|---|
| T1 | formula-normalize.ts + tests | A | 1 | F1, F2, scoped gates |
| T2 | sqlite v6 + formula sync API + tests | B | 1 | F3, F4 (API-level), scoped gates |
| T3 | docs: ADR-022, README, known-pitfalls, CHANGELOG | D | 1 | matches spec §0/§3 wording |
| T4 | engine lifecycle + backfill + fusion + match_reason | C | 2 | F4, F5, F6, F8 |
| T5 | full gates + commits per wave | orchestrator | between | F7 |
| T6 | parallel review (fidelity + correctness) | 2 reviewers | 3 | 0 blockers |
| T7 | fix loop ≤ 3 rounds | fix worker | 4 | all blockers resolved |
| T8 | dogfood: index a real math PDF/md, query across notations | orchestrator | final | sensible hit |

## §7 Verification protocol

Per wave (orchestrator): `npm run check` → `npm run typecheck` → `npx vitest --run test/unit/ --testTimeout=15000` → `node --experimental-strip-types -e "import('./index.ts')"`. Blast-radius diff review before each commit (explicit-path staging only; `package.json` and L2 files never staged).

## §8 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Normalizer regressions on exotic LaTeX | Medium | alias table frozen + test-vector-gated; undefined-not-throw on degenerate input |
| Double-counting formula boost on hybrid hits | Low | boost applied once per chunk (max), capped 0.35 |
| Backfill cost on large KBs (one-time, synchronous) | Medium | runs once per KB (flag); acceptable local scale; fail-open wrap |
| FTS query injection from formula tokens | Low | quoted-term building, reuse bm25 discipline |
| Chunk id churn when metadata changes (formulas list itself) | Low | add path writes rows for added chunks only; replace API is idempotent |
| `deleteKB` missing formula cleanup | Low | mirror existing chunk-deletion pattern in deleteKB |
| Concurrent full vitest suites flaking | Medium | workers run scoped vitest; orchestrator owns full suite |
| `match_reason` consumers (TUI) on new value | Low | additive union; verify display path handles unknowns gracefully |

## §9 Effort

~1000–1200 lines total incl. tests. Wave 1 ≈ 30–45 min (parallel), wave 2 ≈ 45–60 min, reviews ≈ 20 min. Single session.
