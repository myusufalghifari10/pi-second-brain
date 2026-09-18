# Layer 4 Implementation Report — Fidelity & Breadth

Date: 2026-09-18 · Range: `4abdbc7..0136e71` (13 commits) · Spec: `docs/layer4-fidelity-breadth-plan.md`
Scope: chemistry normalization, engineering units, eval harness, PDF images + OCR, label graph (schema v7).

## Execution shape

- **Wave 1** (3 parallel workers): A chem (`650512b`), B eval harness (`dfaec2e`), C label extraction (`19f6ed4`).
- **Wave 2** (4 parallel workers): D units (`d5604a2`), E label schema v7 + dependency leg (`c977804`), F images/OCR (`89f84c9`), G docs (`3ee1594`).
- **Review** (2 parallel read-only reviewers): fidelity 0 blockers / 11 notes; correctness 2 blockers / 7 notes.
- **Fix round** (`125f1cc`, `0136e71`): both blockers + notes N5/N6/N7 + doc ratifications, executed by the orchestrator with red-green proof.

Worker escalations ratified mid-flight: eval fixture authoring (option A), `MATH_UNICODE_MAP` 92→95 with
stale count-test update, token-space `UNIT_TOKENS` derivation. All recorded in the respective
`WAVE*-*-REPORT.md` files (transient, removed after this report).

## Review findings disposition

**Blockers (both fixed, `125f1cc`):**
1. ReDoS in `MOLECULAR_RE` — digit-run partition ambiguity between an element's greedy `\d*` and the
   bare `\d+` alternative caused exponential backtracking (repro: `H` + 48×`2` + `z` hung > 30 s).
   Fixed with the reviewer's lookbehind (`(?<![A-Za-z0-9)])\d+`), a defensive ≥25-digit-run rejection
   in `isMolecularFormula`, and a timing regression test. Post-fix: 64-digit run rejected in ~7 ms;
   `H2O`/`(NH4)2SO4` acceptance unchanged.
2. Duplicate result rows — a chunk formula-injected AND dependency-targeted was injected twice.
   Fixed by skipping `formulaInjectedChunkIds` in the dependency injection loop. Red-green proof:
   guard disabled → 2 rows; guard enabled → 1 row, `match_reason: "formula"`.

**Notes fixed:** `findResolvedLabelEdges` full-scan → `idx_label_edges_src` index (v7 migration amended
pre-release); OCR env folded into the conversion cache key (toggling OCR no longer serves stale
markdown; no `ADAPTER_VERSION` bump needed); `localeCompare` → byte-stable codepoint ordering for
edge caps; `units.ts` docblock surface-count corrected (31 surface forms → 34 token forms).

**Notes ratified/documented:** formula-injected triggers contribute `depends_on` provenance only and
triggers come from the pre-threshold retrieved set (conservative, ADR-025 + plan §3.5); `SO₄²⁻`
fold-order artifact locked deterministic in tests; per-update full-DB label rebuild documented as a
local-scale cost; `so`/`ce` token semantics of `\ce{…}` queries documented via the F8 overlap test.

## Gates (final, at `0136e71`)

- `npm run check`: 85 files, clean · `npm run typecheck`: clean
- `vitest test/unit/`: **480 passed + 1 skipped** (baseline 396+1 → +84 across L4)
- `npm run eval -- --fixture`: **46/46 queries, recall@5 100%**, two consecutive runs byte-identical
- `npm run eval -- --kb llm-papers`: 5/5 dogfood anchors at rank 1 (advisory live mode)
- Smoke import + `npm pack --dry-run` posture unchanged; zero new npm dependencies; `package.json`
  diff = exactly the ratified `scripts.eval` line.

## Live dogfood on the real corpus (`llm-papers`, 635 chunks, production dir)

- `\ce{H2SO4}` fast query → formula-leg injection fired (`match_reason: "formula"`).
- Plain `H2SO4`, `$H2SO4$` queries → bm25 hits (prose-mixed segments correctly not chem-routed).
- Units query `N·m` retrieved through the rewritten tokens (hybrid).
- Label/dependency path correctly dormant on this corpus (no `.tex` refs — zero edges, zero work).
- Regression: all five L2-era dogfood queries return identical top hits at path level (F9 ✓).

## Residuals (honest)

- E5-style honest skip carried over: live tesseract OCR untested on this machine (no binary);
  covered via `PI_KNOWLEDGE_OCR_CMD` fake-binary tests (I3/I4/I5).
- Image store grows unbounded by design; reset hatch documented (`rm -rf <knowledge-dir>/image-store`);
  deleting stored images dead-links already-indexed chunks until re-index.
- Per-update label rebuild is O(all DB chunks) — acceptable at local scale, kb-scoping deferred.
- Prose molecular formulas intentionally not indexed (precision stance, query-side compensated).
- `Nm` single-token spelling stays asymmetric by design (L1 alnum-run invariant).
