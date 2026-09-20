# L6-watcher-ops — functional test report (features F1–F5, H1–H4)

Lane: L6-watcher-ops · Engine: `/home/yusuf/pi-knowledge/dist/src/engine.js` + real watcher module
`/home/yusuf/pi-knowledge/dist/src/watcher/file-watcher.js` (built dist, no mocks)
Store: isolated `PI_KNOWLEDGE_DIR=/tmp/fx-L6-watcher-ops/run-<feat>-<pid>` (fresh per probe) ·
Models: offline cache via `PI_KNOWLEDGE_MODEL_CACHE_DIR=/home/yusuf/.pi/knowledge/models`
Probes kept at `/tmp/fx-L6-watcher-ops/` (`harness.mjs`, `probe-f1..f5.mjs`, `probe-h1..h4.mjs`).
Watcher wiring mirrors production (`index.ts:426`): `startWatcher(kb.id, kb.source_path, (kbId) => engine.update(kbId))`.
DEBOUNCE_MS=2000, POLL_MS=2000; probes allow up to 15–25 s per probe and MEASURE actual fire times.
Every probe starts with a ≥3.5 s quiet-baseline assertion (watcher must NOT fire without changes).

## Verdicts

F1 | PASS | `probe-f1.mjs`: add 1-file dir KB → create `notes/beta.md` → update fired ONCE, chunk searchable via fast query in **2817 ms** (within 2s debounce + 2s poll window); `F1_QUIET_BASELINE_UPDATES 0` (no spurious fire); after: `{"status":"ready","chunk_count":2,"file_count":2}`; `F1_RESULT PASS`

F2 | PASS | `probe-f2.mjs`: rewrite `alpha.md` body → new token hit in **2816 ms**; old token `qzvvaaw` → 0 results (re-chunked); single update resolved `{added:1, removed:1, unchanged:0}`; `F2_QUIET_BASELINE_UPDATES 0`; `F2_RESULT PASS`

F3 | PASS | `probe-f3.mjs`: delete `gamma.md` → propagation in **2823 ms**, exactly 1 update, `G3DEADZZ` → 0 results, after: `{"chunk_count":1,"file_count":1}`; `F3_QUIET_BASELINE_UPDATES 0`; `F3_RESULT PASS`

F4 | FAIL | `probe-f4.mjs` (2 identical runs): 5 rapid writes (0 ms spread) → all 5 coalesced into update #1 `{added:5, removed:0, unchanged:1}` — BUT a second update fired **2007 ms later** as a pure no-op `{added:0, removed:0, unchanged:6}` → `F4_UPDATE_CALL_COUNT 2` (both runs, deterministic). Expected: exactly ONE update per the matrix criterion ("5 rapid writes in one quiet window → exactly ONE update (coalescing)"). Observed: one effective (change-carrying) update + one redundant no-op update. Mechanism: the poller tick lands while update #1 is still in-flight (update duration ≈ poll interval on small dirs), the stored snapshot is still the pre-change one → `checkForChanges` re-schedules; #2 runs after #1 settles and indexes nothing. The 5 writes themselves coalesce correctly; the violation is the extra no-op update invocation.

F5 | PASS | `probe-f5.mjs` (harness monkeypatch: first scheduled update rejects with "simulated transient lock"): ATTEMPTS `[{attempt:1, rejected: simulated transient lock}, {attempt:2, resolved, added:1}]` — retry was automatic (no re-trigger), change recovered in **4821 ms**, `retry.md` searchable, `file_count 2`; `F5_RESULT PASS` (pendingRetry re-detection path works)

H1 | PASS | `probe-h1.mjs`: status aggregation from real modules — `Knowledge bases: 1`, `Active watchers: 1`, per-KB `ready — 2 chunks, 2 files`, persisted job `add/succeeded — processed_files=2 processed_chunks=2 skipped=0 +2/-0/=0`, after manual update job `update/succeeded` `unchanged_chunks=2`, `coverage: 100% (2/2 files)`, no stale/orphans; all 8 H1_CHECKS true; `H1_RESULT PASS`

H2 | FAIL | `probe-h2.mjs`. Clause 1 (healthy store): `HEALTHY_DOCTOR {health_score:100, summary:"Knowledge system is healthy.", issues:[], actions:[]}` — clean ✓. Clause 2 (deleted vector file): `rm vectors/<kbId>.bin` (file confirmed present before deletion, `existed:true`) → doctor STILL reports `health_score:100, "Knowledge system is healthy.", issues:[], actions:[]` — **NOT flagged, no actionable code**. Expected per matrix: doctor FLAGS the deleted vector file with an actionable code. Observed vs expected mismatch: `diagnose()`/`doctor()` (src/diagnostics/health.ts, dist/src/engine.js `doctor()`) check only stuck-indexing/error-status/coverage/stale/orphan/skipped/symbols — there is no vector-file existence check, so silent bm25-only degradation goes undiagnosed (context: fast search still returned 1 hit after the delete). Clause 1 passes; clause 2 fails → feature FAIL.

H3 | PASS | `probe-h3.mjs`: `knowledge_show` rendering `• h3-dir — 2 chunks, 2 files (ready)` / `• h3-file — 1 chunks, 1 files (ready)`; `source_path` exact for dir and single-file KBs; counts cross-checked against raw SQLite (`SELECT COUNT(*) / COUNT(DISTINCT file_path) FROM chunks`) — `match:true` for both KBs; all 8 H3_CHECKS true; `H3_RESULT PASS`

H4 | PASS | `probe-h4.mjs` A+B (two separate node processes): A: `configureModelWorkerNodePath(process.execPath)` → `/usr/bin/node` written to `<store>/config.json` (`{"node_path":"/usr/bin/node",...}`); invalid path rejected pre-write (`spawnSync .../no-such-node ENOENT`); auto-discover works; B (fresh process): `readRuntimeConfig()`/`getConfiguredNodePath()` read back `/usr/bin/node` exactly; `A_RESULT PASS`, `B_RESULT PASS`

## Summary

9 features: 7 PASS, 2 FAIL (F4, H2), 0 SKIP.

### F4 — fix guidance for worker
Observed: poller tick during an in-flight watcher update re-schedules an update even though the in-flight run started AFTER the change and will store a fresh snapshot on settle (`dist/src/watcher/file-watcher.ts` `scheduleUpdate`/`checkForChanges`; snapshot is intentionally stored only post-run, so the mid-flight poller comparison always differs). Result: deterministic extra no-op update `{added:0,removed:0,unchanged:N}` ~2 s after the effective one (measured 2007 ms gap, both runs). Expected: exactly one update invocation for one quiet-window storm. Note `pendingRetry` only covers the overlap-rejected case, not this settled-then-rerun case.

### H2 — fix guidance for worker
Observed: after deleting `vectors/<kbId>.bin`, `doctor()` returns health_score 100, zero issues, zero actions (silent data-loss-adjacent degradation; search degrades to bm25 without any signal). Expected: an issue naming the missing/incomplete vector file with an actionable code (e.g. `run_update`/`rebuild_kb`), consistent with the update path which already detects `oldVectorReader === null` and rebuilds (`dist/src/engine.js` ~line 1276).

## Observations (non-blocking)

- Watcher fire latency measured ~2.8 s in F1–F3 (poller detection often beats the fs.watch check timer; both paths feed the same 2 s debounce). Within the stated 2s+2s window.
- The F5 success path leaves `pendingRetry` set, so the poller runs one extra no-op convergence update after the successful retry (by-design conservative behavior, ~0 changed); documented in file-watcher.ts comments. Did not affect the F5 criterion (change not lost, automatic retry).
