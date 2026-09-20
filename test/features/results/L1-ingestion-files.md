# L1-ingestion-files — Feature Test Results (A1–A10)

Lane: L1-ingestion-files · Engine: real built `dist/src/engine.js` · Node v26.8.1
Isolated stores: `/tmp/fx-L1-ingestion-files/store-*` (fresh per probe, `PI_KNOWLEDGE_DIR` env)
Models: offline via `PI_KNOWLEDGE_OFFLINE=true` + `PI_KNOWLEDGE_MODEL_CACHE_DIR=~/.pi/knowledge/models`
Probe scripts (kept): `/tmp/fx-L1-ingestion-files/probe-A*.mjs`, `harness.mjs`, logs in `/tmp/fx-L1-ingestion-files/logs/`

## Verdicts

```
A1 | PASS | add(quantum-notes.md w/ frontmatter): status=ready, 3 chunks; metadata heading="# Overview/# Measurement/# Entanglement", breadcrumb=Overview/Measurement/Entanglement, title="Quantum Notes", tags, aliases=["QM crib sheet"]; hybrid search "Bell states maximally entangled two-qubit" -> 1 hit score 1.196 in Entanglement chunk (probe-A1.mjs, logs/A1.log)
A2 | PASS | add(field-manual.txt): status=ready source_type=file, 1 chunk, file_type=text (lines 1-11); hybrid search "manifold pressure sensor bleed valve calibration" -> 1 hit score 1.196 (probe-A2.mjs, logs/A2.log)
A3 | PASS | add(gauge-theory.tex): status=ready, 2 chunks file_type=latex; \begin{equation} S_YM...F^a_{\mu\nu}F^{a\mu\nu} fully inside ONE chunk and \[ D_\mu F^{\mu\nu}=J^\nu, D_[\alpha F_\beta\gamma] \] fully inside ONE chunk; hybrid query "F^{a\mu\nu} Yang-Mills action curvature" -> hit score 1.476 (probe-A3.mjs, logs/A3.log)
A4 | PASS | add(widgets.tsx): 3 per-symbol chunks with metadata symbol/symbol_kind/signature: WidgetProps(interface,"export interface WidgetProps"), WidgetRow(function,"export function WidgetRow("), WidgetPanel(class,"export class WidgetPanel"); engine.symbolSearch("WidgetPanel",{exact:true}) -> 1 row kind=class line=14; hybrid search -> 3 hits, top score 1.696 (probe-A4.mjs, logs/A4.log)
A5 | PASS | add(polyglot dir): status=ready file_count=9 chunk_count=15; language metadata exactly correct for all 9 files (javascript=util.js, python=parse.py, go=main.go, rust=lib.rs, java=App.java, bash=deploy.sh, c=vector.c, cpp=shape.cpp, qml=Gauge.qml), 0 chunks without language; no parse crash, cross-language search hits (probe-A5.mjs, logs/A5.log)
A6 | PASS | add(proj dir nested docs/ + src/deep/): recursive add, nested src/deep/util.ts + docs/design.md indexed; gitignored vendor/generated/ and debug.log (*.log) EXCLUDED; real 1x1 PNG (NUL bytes in sample) SKIPPED as binary, not in chunks; fast search "KESTREL_VERSION" hits src/deep/util.ts (probe-A6.mjs, logs/A6.log)
A7 | PASS | plan(proj dir): scannable_files=3, skipped total=3 with oversized=1 (huge.bin.txt 55MB) and binary=2 (logo.png, blob.dat), summary "Directory plan: 3 scannable files, 11.4 KB scannable text, skipped 3 (oversized: 1, binary: 2)"; engine.list() 0 KBs before AND after plan; single-file plan of 55MB file: "exceeds the 10 MB single-file cap; ingestion will fail"; no vectors dir created (probe-A7.mjs, logs/A7.log)
A8 | PASS | one 22,319-char paragraph -> 4 chunks with content lengths [6000,6000,6000,4319] (all <=6100, no content lost); 3 giant paragraphs -> 6 chunks start_line=[1,2,3,4,5,6] ascending, max len 6000 (probe-A8.mjs, logs/A8.log)
A9 | PASS | add(junk-huge.txt 12MB lines) threw: "File exceeds the 10 MB ingestion cap: .../junk-huge.txt — split it or add its directory instead"; add(junk-huge.pdf 11MB) threw same cap error; 0 KB rows left behind (probe-A9.mjs, logs/A9.log)
A10 | PASS | add 2-chunk KB then update() with zero file changes: {added:0, removed:0, unchanged:2} in 5ms; chunk_count stays 2; all chunk content_hashes byte-identical before/after (probe-A10.mjs, logs/A10.log)
```

10 PASS / 0 FAIL / 0 SKIP

## Environment & commands

- `node <probe>.mjs` per feature from `/tmp/fx-L1-ingestion-files/` (Node 26.8.1, ESM imports of `/home/yusuf/pi-knowledge/dist/src/engine.js` + `dist/src/storage/sqlite.js` for chunk metadata assertions).
- Each probe creates a fresh `PI_KNOWLEDGE_DIR` store under `/tmp/fx-L1-ingestion-files/` and calls `engine.dispose({disposeModels:true})` at exit. No src/, test/, or fixture files modified.

## Observations (non-blocking)

1. **Frontmatter list style**: YAML block lists (`tags:\n  - physics`) are NOT parsed by `parseFrontmatter` (src/indexer/math-text.ts) — only inline `tags: a, b` / `aliases: x` style and flat `title:` work. The matrix criteria pass using the supported inline format; block-list YAML silently yields empty tags/aliases. If users write standard Obsidian block-list frontmatter, tags/aliases metadata will be empty (title still parsed).
2. **`.png` is not in `BINARY_EXTENSIONS`** (src/indexer/chunker.ts): binary skip relies on a 0x00 byte appearing in the first 512 bytes. A real PNG always contains NUL bytes and IS skipped (verified); a hypothetical NUL-free `.png`-named text file would be indexed as text. Consistent with the documented fixed-size-sample contract; no action needed for the matrix criteria.
3. **`.gitignore` itself is indexed** as a normal text file (it is not matched by gitignore patterns). Not part of any pass criterion; noted for transparency.

## Failure diagnostics (RED phase artifacts)

None — no feature failed. Probe-harness bugs fixed during development (not engine bugs): missing `await` on `openStoreDb`, over-strict file_count checks, and an unrepresentative PNG fixture (junk filler without NUL bytes) replaced with a real 1x1 PNG.
