# L2-ingestion-ops results (B1–B9)

Runner: functional probes against the REAL built engine (`/home/yusuf/pi-knowledge/dist/src/engine.js` + `dist/src/watcher/file-watcher.js`), isolated `PI_KNOWLEDGE_DIR`-style stores under `/tmp/fx-L2-ingestion-ops/store-*`. Models offline-cached; no network. Probes kept at `/tmp/fx-L2-ingestion-ops/probe-*.mjs`. No `src/`, `test/`, or fixture files modified.

```
B1 | PASS | probe-b1-b2.mjs: edit file OLDSENTINEL->NEWSENTINEL then update() -> {"added":1,"removed":1,"unchanged":0}; search OLDSENTINEL hits=0, NEWSENTINEL hits=1 (old chunk content gone, new present)
B2 | PASS | probe-b1-b2.mjs: rm gone.md then update() -> {"added":0,"removed":1,"unchanged":1}; search DoomedPineapple hits=0 (was 1 pre-delete), keep.md still hits=1
B3 | PASS | probe-b3-b5.mjs: exportKB('b3', out) -> exported=2, JSONL has 3 lines = header(chunk_count=2, keys name,description,source_type,chunk_count) + 2 chunk lines; lineCount==chunkCount+1 true
B4 | PASS | probe-b3-b5.mjs: importKB into NEW store-b4 -> kb b3 status=ready chunks=2 (same count); search "boron counterweight" hits=1 with original body text, 1 vector file on disk
B5 | PASS | probe-b3-b5.mjs: header chunk_count inflated 2->7 -> import throws "Import file is incomplete: declared 7 chunks but only 2 were present"; list()=0 KBs, store-b5/vectors/ empty (no partial KB)
B6 | PASS | probe-b6-b7.mjs: remove('b6') -> true; list()=0; vectors/<kbId>.bin gone (existsSync=false, vectors dir empty)
B7 | PASS | probe-b6-b7.mjs: clear() with 2 KBs -> list()=0; vectors dir empty (was 2 .bin files)
B8 | PASS | probe-b8.mjs: real watcher wiring startWatcher->update; watched edit fires exactly 1 onUpdate; then remove()+stopWatcher (knowledge_remove path) -> watchers=0; post-remove edit over 6s window (>2s debounce + 2s poll): fired delta=0, update-error delta=0; eng.update('b8') throws "Knowledge base not found: b8" (no ghost KB)
B9 | PASS | probe-b9.mjs: 2 KBs in one store; A-query hits only kb_name=kb-alpha, B-query only kb-beta; scoped search kb_id=kb-alpha for B-term hits=0 (and vice versa); A-only unscoped query returns no kb-beta chunk
```

## Summary
- PASS: 9/9 (B1–B9), FAIL: 0, SKIP: 0.

## Execution log
- `node probe-b1-b2.mjs` — exit 0, lines B1 add/update/after + B2 add/update/above.
- `node probe-b3-b5.mjs` — exit 0, B3 line-count check true, B4 roundtrip search hit, B5 incomplete-import error + clean store.
- `node probe-b6-b7.mjs` — exit 0, vector files deleted on remove and clear.
- `node probe-b9.mjs` — exit 0, zero cross-KB leakage.
- `node probe-b8.mjs` — exit 0, zero watcher activity after remove over a 6s quiet window.

## Notes / caveats
- B8 harness mirrors the extension's real remove path (`index.ts` knowledge_remove: `engine.remove(target)` then `watcher.stopWatcher(kbId)`), using the same shipped modules; it is not a Pi-TUI end-to-end run.
- B4 imported store rebuilt vectors via the cached offline embedding model (1 vector file observed); the import roundtrip is not text-only.
