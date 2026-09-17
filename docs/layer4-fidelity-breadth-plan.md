# Layer 4 — Fidelity & Breadth (chemistry, units, eval harness, images, label graph)

Status: DRAFT SPEC v1 (supervisor-authored; Yusuf-approved scope + Q1–Q5 answers)
Date: 2026-09-18
Predecessors: L1 math chunking (`99084cc..0297af5`), L2 PDF sidecar (`4dbc9a2..f713d16`),
L3 formula retrieval (`67283a4..cc9c413`).
Successor preview: L5 "Verifiable Research Substrate" (epoch ledger, closure invalidation, calibrated
ignorance) — grounded on this layer's schema v7; spec written after L4 merges (§10).

## §0 Purpose & success (binding)

**Purpose.** Close the remaining domain gaps (chemistry, engineering units, images, cross-document
math structure) and — for the first time — make quality **measurable**. After L4, the claim
"professor-grade retrieval" is backed by a runnable benchmark, not opinion.

**Success (all binding):**
- S1 `H2SO4` ≡ `H₂SO₄` ≡ `\ce{H2SO4}` retrieve the same chunks; `Co` ≠ `CO` (case-sensitive chemistry).
- S2 `N·m` ≡ `N m` in FTS, symmetric index/query.
- S3 `npm run eval` green: ≥ 45 golden queries across 6 domains; fixture mode is byte-deterministic
  (two consecutive runs produce identical recall/report).
- S4 Images referenced by sidecar markdown are persisted under a content-addressed store, links are
  rewritten live, and caption/OCR text is searchable.
- S5 A query naming a LaTeX label retrieves the defining chunk; chunks it references (depth 1) are
  boosted/injected with `match_reason: "dependency"`.
- S6 Full suite stays green; queries without chemistry/units/labels/OCR produce byte-identical results
  to pre-L4; **zero new npm dependencies**.

## §1 Scope

**In:**
- `src/indexer/chem-normalize.ts` (NEW) + a chemistry branch inside `normalizeFormula`
  (`src/indexer/formula-normalize.ts`) + query-side chem detection in `extractQueryFormulas`
- `src/indexer/units.ts` (NEW) + a token-rewrite hook in `preTokenizeForFTS` (`src/indexer/chunker.ts:424`)
- `eval/` (NEW: `golden/*.json`, `run.ts`) + one `package.json` **scripts** line (§3.3 — ratified
  exception; dependencies/other scripts untouched)
- `src/indexer/pdf-sidecar.ts` image persistence + OCR sidecar (tesseract, user-installed binary)
- `src/indexer/math-text.ts` `extractTexRefs()` + `src/indexer/label-resolve.ts` (NEW) +
  `metadata.refs` threading in `src/indexer/chunker.ts` + `label_edges` schema v7 +
  dependency fusion leg in `src/engine.ts`
- tests: `test/unit/chem-normalize.test.ts`, `test/unit/units.test.ts`,
  `test/unit/label-graph.test.ts`, `test/unit/pdf-images.test.ts` (all NEW), plus golden files

**Out (non-goals):**
- CLIP / image-embedding retrieval (L6, gated by Q4-approval: approved, but sequenced after L5)
- RDKit / SMILES structural equivalence (needs heavy dep — permanent defer until explicit decision)
- OCR of handwriting (tesseract = printed text only)
- Structural table parsing; bio/med synonym layer; `Nm` single-token units (documented asymmetric)
- Prose-level molecular formula detection (precision trap — math segments + `\ce{}` only, §3.1)
- Doctor debt-ledger / audit reports (L5); invalidation cascades (L5)

## §2 Current-world facts (verified 2026-09-18 at `cc9c413`)

| Fact | Evidence |
|---|---|
| SCHEMA_VERSION = 6; additive per-version migrations; formulas pattern (table + external-content FTS + ai/ad/au triggers + flag-guarded backfill) | `src/storage/sqlite.ts:81`, `:84-119`, `runMigrations` |
| Formula rows written from chunk `metadata.formulas` via `formulaRowsFromMetadataJson` → `normalizeFormula` (single normalization entry point) | `src/engine.ts:916-940`, `:951`, backfill `:1057-1076` |
| `preTokenizeForFTS` lives in chunker (applies `canonicalizeMathText` last, per L1 ADR-020) | `src/indexer/chunker.ts:424`, `math-text.ts:164` |
| `SUBSCRIPT_FOLDS` already map `₂→sub2` etc.; `MATH_UNICODE_MAP` covers Greek/ops/arrows | `src/indexer/math-text.ts:128-143` |
| Query-side bare-TeX rule catches `\ce{…}` (≥1 command + braced argument) — ratified L3 | `formula-normalize.ts:188-191`, spec L3 §3.1.2 |
| Sidecar markdown images ignored today (adapter reads only the largest `*.md`) | `src/indexer/pdf-sidecar.ts:369` |
| `extractTexLabels` exists (deduped, `MAX_LABELS = 20`); chunk `metadata.labels` already threaded | `math-text.ts:555-556`, `chunker.ts` LaTeX section path |
| `match_reason` union currently ends at `"formula"`; FORMULA_BOOST = 0.35, MIN_HYBRID_SCORE = 0.18 | `engine.ts:132`, `ranking.ts:5,9` |
| Real corpus exists: KB `llm-papers`, 635 chunks / 19 docs (10 arXiv foundation PDFs + 6 arXiv 2026-model PDFs + 3 official md pages), status ready in `~/.pi/knowledge` | dogfood 2026-09-18; 5/5 probe queries hit correct docs |
| No eval infrastructure exists anywhere in the repo | grep `eval` — none |
| Full-suite baseline: 396 passed + 1 skipped (E5), check/typecheck clean | supervisor run at `934a861` |
| package.json scripts currently: build/check/prepack/test/test:e2e/typecheck/bench | `package.json` |

## §3 Spec

### §3.1 Chemistry — `chem-normalize.ts` (NEW) + routing in `normalizeFormula`

**Routing (single entry point, ratified):** inside `normalizeFormula`, after delimiter stripping:
if the formula contains `\ce{` OR (it contains NO TeX commands AND matches the anchored
MOLECULAR_RE, §3.1.1) → delegate to `chemNormalize()`. Both index side (via
`formulaRowsFromMetadataJson` → `normalizeFormula`, engine.ts:916) and query side
(`extractQueryFormulas`) therefore share one deterministic path.

**§3.1.1 MOLECULAR_RE:** anchored full-match over the 118 element symbols, case-sensitive
(`H|He|Li|…` longest-first), between tokens allowing: digits (counts), optional `_` separators
(LaTeX subscript style: `H_2SO_4`), parenthesized groups (nested ≤ 2), `+`/`-`/`^{n±}`/`^n±`
charges, `·`/`*` hydrate dots, and state suffixes `(s)|(l)|(g)|(aq)` (stripped). Arrows (`->`,
`→`, `\rightarrow`, `\leftrightarrow`) split species into one signature sequence (species order
preserved; no per-species splitting in v1). A molecule match REQUIRES ≥ 2 element tokens AND at
least one uppercase letter — kills prose words ("No", "At", "In") unless anchored full-match.

**§3.1.2 chemNormalize pipeline (normative, ordered):**
1. Strip `\ce{`/`}` wrapper and states `(s)|(l)|(g)|(aq)`.
2. Unicode subscripts → ASCII digits (reuse `SUBSCRIPT_FOLDS`, then drop the `sub` marker inside
   chem signatures only: `H sub2 S O sub4` → `H2 S O4`). Superscript charges `²⁺` → `^2+`.
3. Unify arrows → `->`; unify charges to trailing `^n+`/`^n-` form (`+2` ≡ `^2+` ≡ `2+`).
4. Hydrate dot `·`/`*` → `.` token (distinct from arrow).
5. Emit token list: element-count runs kept intact per species (`H2`, `S`, `O4`). **Paren groups
   are flattened WITH multiplier distribution**: a trailing group count multiplies every inner
   element count (`Ca(OH)2` → `Ca O2 H2`; `(NH4)2SO4` → `N2 H8 S O4`); nested groups compose
   multiplicatively. Mismatched parens tolerated (never throws; unterminated group = flatten to
   end with multiplier 1).
6. Join with single space; **case preserved throughout** (`Co` cobalt ≠ `CO`).
7. Undefined on: zero species, > 2000 chars (reuse `MAX_FORMULA_CHARS`).

**Test vectors (minimum, F1):** `H2SO4` ≡ `H₂SO₄` ≡ `\ce{H2SO4}` ≡ `\ce{H2SO4(aq)}`;
`\ce{SO4^2-}` ≡ `\ce{SO4^{2-}}` ≡ `SO4 2-`… exact expected signatures locked in tests;
`Co` ≠ `CO`; `\ce{Ca(OH)2}` single signature; arrow forms unify; `e^{i\pi}` NOT chemistry.

**Query side (F2):** `extractQueryFormulas` gains: text segments are additionally tested with
MOLECULAR_RE full-match → treated as one chem formula (this makes the plain query `H2SO4` work;
bare-TeX rule already covers `\ce{…}`). Cap and reject semantics unchanged (L3 §3.1).

### §3.2 Units — `units.ts` (NEW) + hook in `preTokenizeForFTS`

- `UNIT_TOKENS`: frozen curated set (~40 entries, enumerated in `units.ts` with paired test
  vectors): base + common derived SI (`N m kg s A K mol cd Hz J W V C Ω S F T H Pa bar eV L`)
  plus frequent prefixed forms (`kN MPa GPa kPa kW MJ kWh mm cm km mg µg`). Prefixes are part of
  the token (never split); `/` stays its own token.
- Rule (single, conservative): in the token stream produced by `preTokenizeForFTS`, a `cdot` token
  BETWEEN two UNIT_TOKENS is rewritten to nothing (`N cdot m` → `N m`). Applied iteratively
  (left-to-right, adjacent pairs). This makes `N·m` ≡ `N m` symmetric for index and query because
  `preTokenizeForFTS` is the shared stage (chunker.ts:424).
- Unicode unit glyphs: verify `µ`, `Å`, `Ω`, `°` in `MATH_UNICODE_MAP`; missing ones are added with
  paired test vectors (L1 map extension is the L1-sanctioned surface).
- `Nm` (single alnum run) is NOT split — documented asymmetric (splitting alnum runs is forbidden,
  L1 invariant).
- Hook = one function call inside `preTokenizeForFTS` after canonicalization
  (`rewriteUnitTokens(tokens)`), pure and total.

### §3.3 Eval harness — `eval/` (NEW)

- `eval/golden/*.json` (per-domain files: `math-notation.json`, `formula.json`, `chem.json`,
  `units.json`, `code.json`, `prose.json`, `labels.json`): entries
  `{ id, query, mode, kb?, expect: { file_path | path_prefix, min_score?, must_reason? } }`.
- `eval/run.ts` runner, two modes:
  - `--fixture` (default, the hard gate): builds an ephemeral KB from `test/fixtures` + small new
    L4 fixtures (chem/units/label markdown), runs all golden queries, prints recall@k + per-domain
    table. **Byte-determinism: two consecutive runs must produce identical reports** (S3).
  - `--kb llm-papers` (live-corpus report): read-only queries against the real KB, recall report,
    advisory only (corpus evolves).
- `npm run eval` → `node dist/eval/run.js` (runner included in `tsconfig.build` — extend its
  `include` with `"eval/**/*.ts"`). **package.json edit ratified for the `scripts.eval` line ONLY**
  — dependencies and every other script untouched.
- Determinism requirements: fixture KB built with pinned embedding signature (assert matches
  warm-cache model), sorted iteration everywhere, no timestamps in report.
- Golden v1 (Wave 1, ≥ 45 queries): math-notation ×10 (from L1/L3 ratified vectors incl. `mc²`
  family), formula ×6 (L3 dogfood), code ×5, prose ×8 (from llm-papers probe queries — the 5
  verified dogfood queries included), chem ×8, units ×5, labels ×3 (Wave-2 workers extend their own
  domain file; the runner globs all files).

### §3.4 Images v1 — `pdf-sidecar.ts` extension

- After reading the adapter's markdown (before validation): parse image refs `![alt](rel)`; for each
  existing file under the tmpdir: copy to `<knowledge-dir>/image-store/<sha256>.<ext>`, rewrite the
  markdown link to that absolute path. Missing files → drop the ref (fail-open).
- OCR sidecar: images with empty alt AND no adjacent non-empty caption line are OCR'd via
  tesseract. Two env vars (mirroring the PDF sidecar): `PI_KNOWLEDGE_OCR_ENGINE=auto|off` (default
  `auto`; availability probe `tesseract --version`, 10 s budget, cached per process) and
  `PI_KNOWLEDGE_OCR_CMD` (argv template override for tests/custom binaries — same substitution
  rules as `PI_KNOWLEDGE_PDF_SIDECAR_CMD`). OCR text appended as a paragraph `*OCR:* <text>` right
  after the image line. OCR failure = no caption, never an error. Images with captions skip OCR
  (cost).
- Store growth documented; reset hatch `rm -rf <knowledge-dir>/image-store` (same posture as
  pdf-cache). No schema change (captions live in chunk content; store is filesystem-only).
- unit tests: fake sidecar fixture extended to emit an image + link; assert store file exists
  (hash-named), link rewritten, caption chunk content contains it; tesseract-absent path stays green.

### §3.5 Label graph — `extractTexRefs` + `label-resolve.ts` + schema v7 + dependency leg

- `extractTexRefs(text): string[]` in `math-text.ts` (beside `extractTexLabels`, dedup, cap
  `MAX_REFS = 40`): matches `\ref{x}`, `\eqref{x}`, `\cref{x}`, `\Cref{x}`, `\autoref{x}`.
- Chunker LaTeX path writes `metadata.refs` (alongside existing `labels`). NOTE: `metadata_json`
  is an input to `chunkIdentityHash` (chunker.ts:557) — adding refs re-hashes every LaTeX-bearing
  chunk → **planned re-embed on affected KBs** (same rebuild-boundary precedent as L1 ADR-020);
  documented in CHANGELOG + known-pitfalls.
- `label-resolve.ts` (NEW, pure): `resolveLabelTarget(filePath, label, candidatePaths)` encoding
  the scoping rule: scope-key = `sha1(relPath + "\0" + label)`; same-file match preferred; on
  collision (same label defined in > 1 file) or zero matches → `unresolved` (never guessed).
- Schema v7 (pure SQL, formulas-pattern clone): `label_edges` (`id` = sha256(kb,src_chunk,scope_key),
  `kb_id`, `src_chunk_id`, `target_label`, `scope_key`, `resolved_chunk_id` NULLABLE,
  `target_content_hash` NULLABLE, `kind` ∈ ref|label|link, `indexed_at`) + indexes
  `(kb_id, src_chunk_id)`, `(kb_id, scope_key)` + `knowledge_bases.label_graph_built INTEGER
  DEFAULT 0` (PRAGMA-guarded ALTER). Backfill `listChunksForLabelBackfill` clone +
  `ensureLabelGraphsBuilt` (flag + in-process Set + fail-open wrap — verbatim L3 pattern).
- **Dependency leg** (engine.search, post-merge pre-threshold, beside formula fusion): when a
  retrieved/injected chunk carries resolved outgoing edges → walk depth 1 (cap 2, candidate budget
  10), boost already-retrieved referenced chunks by `FORMULA_BOOST`-style constant
  `DEPENDENCY_BOOST = 0.25` (ranking.ts), inject absent ones with base score = `DEPENDENCY_BOOST`
  (LOCKED: injected dependency chunks score exactly 0.25 before trust multiplier),
  `match_reason: "dependency"`, filters respected, bypass threshold — same ratified rationale as
  formula evidence, provenance gains `depends_on: [{label, chunk_id, pinned}]`. Zero edges ⇒ zero
  work (dormant path).
- Refusal semantics: unresolved edges are recorded, never guessed; they surface in v1 as
  `unresolved: true` on the edge (auditability deferred to L5).

## §4 Worker contracts & waves

| Wave | Worker | Owns (files) | Depends on | Git |
|---|---|---|---|---|
| 1 | A chem | `formula-normalize.ts`, `chem-normalize.ts` (NEW), `test/unit/chem-normalize.test.ts` (NEW) | — | none |
| 1 | B eval | `eval/**` (NEW), `package.json` (scripts.eval line ONLY), `tsconfig.build.json` (include), `scripts/eval` helpers if any, `test/eval/*` fixtures | — | none |
| 1 | C label-extraction | `math-text.ts` (extractTexRefs only), `label-resolve.ts` (NEW), `chunker.ts` (metadata.refs threading), `test/unit/label-graph.test.ts` (NEW) | — | none |
| 2 | D units | `units.ts` (NEW), `chunker.ts` (one hook line), `math-text.ts` (map additions if missing), `test/unit/units.test.ts` (NEW), `eval/golden/units.json` | W1 merged | none |
| 2 | E label-schema+leg | `sqlite.ts` (v7), `engine.ts` (backfill + dependency leg + match_reason), `ranking.ts` (DEPENDENCY_BOOST), `test/unit/label-graph.test.ts` (extend), `eval/golden/labels.json` | W1-C | none |
| 2 | F images | `pdf-sidecar.ts`, `test/unit/pdf-images.test.ts` (NEW), `eval/golden/prose.json` (image query), fake-sidecar fixture extension | — | none |
| 2 | G docs | README, ADR-023/024/025, known-pitfalls, CHANGELOG (English) | spec only | none |
| 3 | orchestrator | full gates + per-wave commits (explicit paths) | each wave | all |

**Wave-1 collision check:** A (formula-normalize), B (eval/**+package.json), C (math-text+chunker+
label-resolve) — disjoint ✓. **Wave-2:** D (chunker hook — AFTER C's chunker edits merged; 1-line),
E (sqlite+engine+ranking), F (pdf-sidecar), G (docs) — disjoint ✓.
**Gates per worker:** scoped `biome check --write <own files>` → `biome check .` → typecheck
(retry-once rule for sibling races) → scoped vitest + `npm run eval --fixture` (B owns making this
command exist; D/E/F extend goldens in their files and run it). Orchestrator runs FULL gates
(check/typecheck/full vitest/eval/smoke) between waves and owns all commits.

## §5 Criteria → tests

- **F1** chem vectors (≥ 18): per §3.1 (incl. `Co`≠`CO`, states, charges, arrows, parens, non-chem
  rejection `e^{i\pi}`, `x^2` rejection).
- **F2** chem query routing: `\ce{H2SO4}` query and plain `H2SO4` query both produce chem formulas;
  cap/reject semantics unchanged.
- **F3** units: `N cdot m` rewrite (≥ 6 unit-pair vectors), non-unit pairs untouched
  (`a cdot b` unchanged), `Nm` documented asymmetric (locked by test), glyph vectors (`µ`, `Å`, `Ω`).
- **F4** harness: `npm run eval --fixture` green; two runs byte-identical; `--kb llm-papers` mode
  runs read-only; ≥ 45 golden queries across ≥ 6 domain files.
- **F5** images: fake-sidecar emits image → store file (sha256 name), link rewritten, caption text
  searchable via search; missing image file = dropped ref, no error.
- **F6** OCR: probe-miss path green (no tesseract on this machine); env `off` honored; OCR text
  lands as `*OCR:*` paragraph when a binary is present — tested via `PI_KNOWLEDGE_OCR_CMD` override
  pointing at a fake tesseract fixture (same escape-hatch pattern as `PI_KNOWLEDGE_PDF_SIDECAR_CMD`).
- **F7** labels: extractTexRefs vectors (5 ref macros, dedup, cap 40); resolveLabelTarget
  same-file/collision/unresolved table; v7 migration (fresh + v6→v7 upgrade, flag column exists).
- **F8** dependency leg: backfill populates edges; query naming a label → defining chunk + referenced
  chunks boosted/injected (`match_reason: "dependency"`, `DEPENDENCY_BOOST` exact delta);
  kb/file filters respected; dormant path (no edges) byte-identical.
- **F9** regression: full suite ≥ 396+1 + new; the 5 llm-papers dogfood queries return identical
  top hits at path level (golden-anchored; none of them contains unit sequences so the units
  rewrite cannot touch them); check/typecheck/smoke clean.
- **F10** scope discipline: diff review per commit — only owned files; `package.json` diff limited
  to the one scripts line; zero dependency changes.

## §6 Rebuild boundary & migrations

- v6→v7 additive (label_edges + flag column); formulas table untouched.
- metadata.refs changes `metadata_json` → re-hash of LaTeX-bearing chunks → one
  `knowledge_update` on affected KBs re-embeds those files (ADR-020 precedent). Non-LaTeX KBs:
  zero churn. Documented in CHANGELOG + known-pitfalls + ADR.
- Image store & OCR: filesystem-only; reset hatch documented.

## §7 Verification protocol

Per wave (orchestrator): `npm run check` → `npm run typecheck` →
`npx vitest --run test/unit/ --testTimeout=15000` → `npm run eval --fixture` (from Wave 1-B on) →
smoke `node dist/src/engine.js` import → blast-radius `git diff --stat` review → explicit-path
commits. `package.json`/docs never staged by workers.

## §8 Risks

| Risk | L | Mitigation |
|---|---|---|
| MOLECULAR_RE false positives | Med | anchored full-match + ≥2 elements + math-segment-only + F2 negative vectors |
| Unit pair-rewrite false positives | Low | frozen conservative UNIT_TOKENS; negative vectors (`a cdot b`) |
| Label collision / `\input`-split docs | High | scope-key + unresolved-not-guessed (locked tests); L5 audit |
| metadata.refs re-hash churn | Med | documented rebuild boundary; non-LaTeX KBs unaffected |
| OCR garbage polluting FTS | Low | opt-out env; only caption-less images; fail-open |
| eval nondeterminism (model/tie-breaks) | Med | pinned embedding signature; sorted iteration; double-run assertion |
| Worker collision on shared files | Med | wave partition (§4); scoped biome; orchestrator merges |
| tesseract absent on this machine | Certain | probe + fake-binary fixture override (F6); E5-style honest skip |

## §9 Effort

~2,000–2,400 lines incl. tests and goldens. Wave 1 ≈ 60 min (3 parallel), Wave 2 ≈ 75 min
(4 parallel), reviews ≈ 25 min, fix loop ≤ 3 rounds. Single session target.

## §10 L5 preview (separate spec, post-L4 merge — NOT in this scope)

Three v8-sibling pillars from the upper-bound study, each grounded on L4: **Epistemic Ledger**
(epoch snapshots of vector file + manifest, version/errata metadata, replayable retrieval receipts),
**Proof-closure audit** (hash-pinned closure over `label_edges`, invalidation flags in doctor,
lineage `origin: source|derived` trust class), **Calibrated Ignorance** (`retrieval_gaps` table,
coverage probe graph, expected-absence golden leg). Dependencies: L4 label graph (edges exist),
eval harness (determinism gate), pdf-sidecar store patterns. Spec drafted only after L4 lands.
