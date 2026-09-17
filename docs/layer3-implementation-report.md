# Layer 3 Implementation Report — Formula Retrieval

Date: 2026-09-18 · Spec: `docs/layer3-formula-retrieval-plan.md` · Base: `67283a4`

## Delivered commits

| Commit | Content |
|---|---|
| `67283a4` | plan (approved spec) |
| `659f4a0` | feat: formula normalizer (`formula-normalize.ts`, 59 tests) |
| `a9b2410` | feat: schema v6 `formulas` + `formulas_fts` + sync API (10 tests) |
| `87093f6` | docs: ADR-022, README, pitfalls, CHANGELOG + ratified spec amendments |
| `738262a` | feat: engine fusion — backfill, lifecycle sync, boost, injection (8 tests) |
| `d794598` | docs: our ADR-020/021/022 + pitfall sections translated to English |
| `934a861` | fix: injection filters-before-cap + kb trust multiplier (2 tests) |
| `1830fa3` | docs: AGENTS.md contract line + ratified spec hardening |

## Execution model (subagents, supervisor-orchestrated)

Wave 1: 3 parallel workers (A normalizer / B storage / D docs), disjoint file contracts, zero git.
Wave 2: worker C (engine fusion), depends on A+B.
Reviews: 2 parallel fresh read-only reviewers (fidelity + correctness/regression).
Fix loop: 1 worker, 2 dispositioned findings. Two mid-flight escalations resolved via supervisor
channel and ratified directly into the spec (bare-TeX trigger rule; F5 test shape).

## Review disposition (0 blockers, 17 notes)

| Note | Disposition |
|---|---|
| Injection cap applied before filters (under-fill when top-5 fail a filter) | **Fixed** `934a861` — filters first, then cap; regression test added |
| Injected results skipped kbTrustMultiplier | **Fixed** `934a861` — real multiplier semantics (incl. source_type factor) mirrored, exported + tested |
| known-pitfalls "retries next query" false in-process | **Docs fixed** — retry only after process restart |
| Spec F5(i) baseline `E = mc pow2` unreachable | **Spec amended** — ratified baseline `e=mc^2` (identical bm25 terms) |
| cleanedQuery dead in engine | **Ratified + documented** — raw query required for boost/injection design |
| Backfill scans all KBs (no kbId scope) | **Deferred** — frozen contract, local scale, documented in pitfalls |
| `ranking: undefined` on injected (isWeakAutoResponse coverage 0) | **Deferred** — safe today, flagged for future fallback changes |
| Cross-form arrow artifacts (⇒ vs \Rightarrow), bare-TeX prose precision | **Deferred** — frozen-table consequences, documented |
| `content_tokenized` invariant API-level only | **Deferred** — contract documented |
| AGENTS.md missing L3 line | **Added** `1830fa3` |

## Final gates (orchestrator-run, at `934a861`)

`npm run check` clean (63 files) · `npm run typecheck` clean · vitest **396 passed + 1 skipped** (E5) ·
startup smoke OK · `npm pack --dry-run` OK (60 files).

## Dogfood (real end-to-end, KB "dogfood", physics.md with 3 display formulas)

| Query | Result |
|---|---|
| `$E=mc^{2}$` (hybrid) | mass-energy chunk, reason `hybrid` (bm25 prefix match + boost) |
| `\mathrm{E}\!=\!mc^2` (fast) | **reason `formula`, score 1.04 = exact 1.0 × kb trust multiplier 1.04** — injection + multiplier live |
| `$\int_0^\infty e^{-x^2} dx$` | gaussian chunk via bm25 |
| `quadratic formula roots` (plain) | normal bm25, zero formula reasons (dormant path) |

## Residual (documented, accepted)

E5 real-binary sidecar test still env-gated (marker not installed); backfill kbId scoping deferred;
formula evidence invisible to `isWeakAutoResponse` (no lossy path today); Chinese remains in
upstream-original docs (ADR-001–019 et al.) by ownership.
