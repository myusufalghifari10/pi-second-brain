# Fix-worker brief — 3 verified feature failures (D3, F4, H2)

You are the ONLY writer in this repo. Context files: test/features/FEATURE-MATRIX.md (contract),
test/features/results/L4-science.md (D3 evidence), test/features/results/L6-watcher-ops.md (F4, H2 evidence).
Read the cited code first. Keep diffs minimal. Follow repo conventions (biome `npm run check`, tabs, fail-fast errors).

## FIX 1 — D3: missing unit word-variant normalization

Today only the cdot rewrite exists (N·m ≡ N m). Add SYMMETRIC unit word-variant canonicalization in the
shared tokenizer pipeline (the ONE path used by both index-side preTokenizeForFTS and query-side
tokenizeForSearch): map spelled-out forms to the symbol form at BOTH index and query time.

Bounded map (word-boundary exact, lowercase): kilometres/kilometre/kilometers/kilometer→km,
metres/meter/metres→m, centimeters→cm, millimeters→mm, kilograms→kg, grams→g, milligrams→mg,
seconds→s, milliseconds→ms, minutes→min, hours→h, hertz→hz, kilobytes→kb, megabytes→mb, gigabytes→gb.
Singular AND plural forms both rewrite. Do not mangle prose (use word boundaries; leave words like
"kilometerstone" alone if encountered).

Acceptance probe (run after build, fresh PI_KNOWLEDGE_DIR): add two md docs — one containing "5 km",
one containing "3 kilometers"; query "kilometers" must hit BOTH docs in fast mode; query "km" must hit
both too. Add unit tests for the rewrite (index+query symmetric) in the existing tokenizer/units test files.

## FIX 2 — F4: watcher no-op second update

In src/watcher/file-watcher.ts the poller can tick while a scheduled update is in-flight with a PRE-change
stored snapshot, re-scheduling a second update that runs after settle as a pure no-op
({added:0,removed:0,unchanged:N}).

Fix in scheduleUpdate's timer callback: before invoking onUpdate, re-diff scanSnapshot() against the STORED
snapshot; if identical AND pendingRetry does NOT have the kbId → skip the invocation entirely (clear timer
bookkeeping as usual). pendingRetry entries MUST always fire (round-11 change-loss guarantee).
All existing watcher tests must stay green — especially the coalescing test (one update per storm) and the
mid-flight-change re-detection test.

## FIX 3 — H2: doctor misses missing vector file

src/diagnostics/health.ts diagnose() has no vector-file existence check. Add one: a KB with chunk_count>0
whose vector file is missing from the vectors dir → an issue with an actionable code (DoctorActionCode
already has rebuild_kb) and a non-perfect health score; healthy stores stay 100. Follow the existing
issue/action shape exactly. Add/extend a unit test in the existing health/doctor test file: delete a vector
file → diagnose flags it with a rebuild_kb action.

## Acceptance gates (all must pass before reporting done)

1. npm run check → 0 issues
2. npm run typecheck → 0 errors
3. npx vitest --run test/unit/ --testTimeout=15000 → all green (re-run once if first run flakes under contention)
4. npm run -s build → OK
5. npm run eval -- --fixture → 46/46
6. The D3 acceptance probe above → PASS

Commit ALL changes as ONE commit: "fix: feature-campaign D3 unit word-variants, F4 watcher no-op skip, H2 doctor vector-file check".
Report: what you changed per fix, gate outputs, commit hash.
