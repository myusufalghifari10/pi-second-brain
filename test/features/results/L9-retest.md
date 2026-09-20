# L9-retest — re-test of fix commit 4cf66f1 (D3 unit word-variants, F4 watcher no-op skip, H2 doctor vector-file check) + regressions

Lane: L9-retest · Tester: tester · Store: isolated `PI_KNOWLEDGE_DIR=/tmp/fx-L9-retest/run-<label>-<pid>` (fresh per probe)
Engine: REAL built engine `/home/yusuf/pi-knowledge/dist/src/engine.js` (EMSM ESM import, node v26.8.1; dist confirmed rebuilt — `dist/src/engine.js` 01:14 newer than `src/engine.ts` 01:05, all three fixes grep-verified in dist).
Offline: `PI_KNOWLEDGE_OFFLINE=true`, `PI_KNOWLEDGE_MODEL_CACHE_DIR=/home/yusuf/.pi/knowledge/models` (cached models, no network).
Probes kept at `/tmp/fx-L9-retest/` (`harness.mjs`, `probe-d3.mjs`, `probe-f4.mjs`, `probe-f4-midflight.mjs`, `probe-h2.mjs`, `probe-c4.mjs`, `probe-f1.mjs`).

## Verdicts

```
FEAT-ID | PASS/FAIL/SKIP | evidence
D3 | PASS | probe-d3.mjs: two single-variant docs (d3-km.md "5 km", d3-kilometers.md "3 kilometers"). fast "kilometers" -> hits BOTH ["d3-kilometers.md","d3-km.md"]; fast "km" -> hits BOTH (criterion met, both modes, hybrid bonus also both). Token-stream symmetry: preTokenizeForFTS("...5 km...") === preTokenizeForFTS("...5 kilometers...") === "The cycling stage is 5 km long entirely"; index ground truth via SQLite: d3-kilometers.md content_tokenized now contains "is 3 km long" (rewritten at index time). Adversarial case/plural variants fast "Kilometers"/"KILOMETERS"/"kilometer"/"kilometre" all hit BOTH docs. D3_RESULT PASS
F4 | PASS | (storm) probe-f4.mjs x3 runs: 5 rapid writes (0 ms spread) in one quiet window (baseline updates=0 each run) -> F4_UPDATE_CALL_COUNT 1 in ALL 3 runs, single update resolved {added:5, removed:0, unchanged:1}, all 5 files searchable (latency ~7.8 s), after {chunk_count:6, file_count:6}. The L6 no-op second update ({added:0,removed:0,unchanged:N}) is GONE — re-diff-before-invoke skips it deterministically. (mid-flight) probe-f4-midflight.mjs x2 runs: update #1 fires for base.md rewrite, midflight.md write lands +702 ms after fire (in-flight) -> update #2 resolved {added:1, removed:0, unchanged:1} carrying the mid-flight file, MFTWO token searchable (1.6 s), change NOT lost, no overlap rejection left pending. MF_RESULT PASS (both runs). PendingRetry always-fire path (round-11 guarantee) untouched per dist/src/watcher/file-watcher.js.
H2 | PASS | probe-h2.mjs: clause-1 sanity healthy store -> {health_score:100, issues:0, actions:0} (still clean). Clause 2: `rm vectors/<kbId>.bin` (present before, confirmed absent after) -> doctor: health_score 65, summary "1 blocking, 0 warning, 0 info issues.", blocking issue {severity:"blocking", kb_name:"h2-vec", message:"Vector file is missing; semantic search is degraded for this KB.", action_code:"rebuild_kb"} plus machine action {code:"rebuild_kb", target:"h2-vec"}; diagnose() exposes vector_file_missing:true. Score 65 < 100 and rebuild action present — both clause-2 criteria met. Degraded fast search after rm still returns the bm25 hit (no crash, graceful degradation intact).
C4 | PASS | probe-c4.mjs (regression): "anchored harbor network" fast limit 5 -> P1 5/has_more true (total 12), P2 5/true, P3 2/false; OVERLAP P1∩P2=P2∩P3=P1∩P3=0, UNIQUE_TOTAL 12; offset 20000 -> CAPPED_RESULTS 0, CAPPED_HAS_MORE false, CAPPED_WARNING exactly ["offset capped at 10000; results repeat past the cap"]. Byte-identical behavior to L3 baseline.
F1 | PASS | probe-f1.mjs (regression): quiet baseline 0 updates -> create beta.md -> exactly ONE update, resolved {added:1, removed:0, unchanged:1}, chunk searchable in 6816 ms (within 2s debounce + 2s poll window), after {chunk_count:2, file_count:2}.
WT-UNIT | PASS | `npx vitest --run test/unit/watcher.test.ts` -> "Test Files 1 passed (1)", "Tests 5 passed (5)", exit 0.
```

Summary: **6/6 PASS, 0 FAIL, 0 SKIP** (D3, F4 storm + F4 mid-flight, H2 clause 2, C4, F1, watcher unit suite).

## Commands (all run in this session)

- `node probe-d3.mjs` → D3_RESULT PASS (9 query/mode combinations, token symmetry, SQLite index ground truth)
- `node probe-f4.mjs 1` / `2` / `3` → F4_UPDATE_CALL_COUNT 1, F4_RESULT PASS (3/3)
- `node probe-f4-midflight.mjs` (x2) → MF_TOKEN_SEARCHABLE ok, MF_UPDATE_CALL_COUNT 2 (both change-carrying), MF_RESULT PASS (2/2)
- `node probe-h2.mjs` → H2_CLAUSE2_RESULT PASS (score 65, rebuild_kb issue+action, vector_file_missing flag)
- `node probe-c4.mjs` → C4_RESULT PASS
- `node probe-f1.mjs` → F1_RESULT PASS
- `npx vitest --run test/unit/watcher.test.ts` → 5 passed (5)

## Residual risks / notes

1. D3 rewrite scope: word-variant map covers a fixed unit list (km/m/cm/mm/kg/g/mg/s/ms/min/h/hz/kb/mb/gb, singular+plural+BE/AE spellings). Other units (e.g. "miles", "feet") are NOT canonicalized — acceptable per the matrix wording (kilometers/km is the contract), noting the boundary.
2. F4 mid-flight probe timing landed on the clean path (update #1 settled before update #2's debounce expired — update #2 resolved, no overlap rejection). The overlap-rejection → pendingRetry → retry path is covered by unit watcher.test.ts (5/5 green) and was verified live in L6's F5; the fix explicitly preserves "pendingRetry entries ALWAYS fire". No live re-run of the rejection variant was needed for this lane's criteria.
3. H2 score 65: the missing-vector issue is classified blocking with a rebuild_kb action, consistent with the existing coverage/orphan issue classes; degraded bm25 search still returns hits (H8 contract unchanged).
