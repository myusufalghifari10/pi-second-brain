# FEATURE-MATRIX — pi-second-brain (pi-knowledge) functional feature inventory

Campaign contract: every feature below MUST be verified working against the REAL engine
(`dist/`, not mocks) before the campaign ends. Statuses: `PASS` / `FAIL` / `SKIP(justified)`.

## How to test (rules for every tester)

1. Work in an ISOLATED store: `export PI_KNOWLEDGE_DIR=/tmp/fx-<lane>$$` (fresh per run).
2. Drive the REAL built engine: `node -e "const {KnowledgeEngine} = await import('<repo>/dist/src/engine.js'); ..."`
   (EMSM ESM import; repo root `/home/yusuf/pi-knowledge`). Use `--experimental-strip-types` only if
   importing `src/*.ts` directly.
3. Never modify `src/`, `test/`, or existing fixtures. Scratch files go in `/tmp/fx-<lane>/`.
4. Embedding/reranker models are ALREADY cached in `~/.pi/knowledge/models` — offline works.
   Do NOT hit the network except where the feature itself is a URL fetch (lane L7).
5. Evidence per feature: the command(s) you ran + the decisive output line(s). No evidence = FAIL.
6. Report format (inline, final message AND `test/features/results/<lane>.md`):
   `FEAT-ID | PASS | <one-line evidence>` / `FEAT-ID | FAIL | observed vs expected` / `FEAT-ID | SKIP | why env-unavailable`
7. A feature PASSES only if the OBSERVED behavior matches the stated pass criteria — not "code looks right".

## A. Ingestion — files & directories

- **A1 add-single-md**: `engine.add()` a markdown file with frontmatter (`title`, `tags`, `aliases`) → KB ready, chunks >0, chunk metadata carries heading/breadcrumb; search finds body text.
- **A2 add-single-txt**: plain `.txt` file → chunked, searchable (plain-text path).
- **A3 add-latex**: `.tex` file with `\begin{equation}` and `\[ ... \]` → math segments atomic (one chunk contains the full equation), searchable by LaTeX token.
- **A4 add-code-tsx**: TypeScript file with class + exported function → chunks per symbol, `symbol`/`symbol_kind`/`signature` metadata present.
- **A5 add-code-10lang**: JS, Python, Go, Rust, Java, Bash, C, C++, QML files each add cleanly → chunk count >0, `language` metadata correct per file, no parse crash.
- **A6 add-directory**: directory with nested subdirs → recursive add, per-file chunks, `.gitignore`d paths excluded, binary files (`.png`) skipped.
- **A7 plan**: `engine.plan()` (knowledge_plan) on a dir reports planned files, oversized flags, and does NOT mutate the store.
- **A8 oversized-text**: file with a single >6,000-char paragraph → multiple chunks, each ≤6,100 chars, coordinates ascending.
- **A9 single-file-cap**: a >10 MB junk file → add rejects/flags with the 10 MB cap error (and a >10MB junk `.pdf` too).
- **A10 dedupe-unchanged**: `engine.update()` right after add with no file changes → chunk count unchanged (content-hash skip), update reports 0 changed.

## B. Ingestion — KB lifecycle

- **B1 update-reindex**: modify a file → `update()` re-chunks it (old chunk content gone, new present).
- **B2 update-delete-file**: delete a source file → `update()` removes its chunks.
- **B3 export-jsonl**: `engine.exportKB()` writes JSONL with header + chunk lines; line count ≈ chunk_count+1.
- **B4 import-roundtrip**: import the B3 file into a NEW KB → same chunk count; search in the clone finds the same text.
- **B5 import-integrity**: import a JSONL whose header declares MORE chunks than present → import FAILS with incomplete-import error, no partial KB left.
- **B6 remove**: `engine.remove()` → KB gone from list, vector file deleted from disk.
- **B7 clear**: `engine.clear()` → all KBs gone, store dir has no leftover vectors.
- **B8 remove-stops-watcher**: after `remove()` of a watched KB, editing its source file must NOT trigger another update (no job activity).
- **B9 concurrent-kbs**: two KBs in one store, search in one never returns chunks of the other.

## C. Search modes & ranking

- **C1 fast-mode**: mode `fast` on a KB → results non-empty, top hit relevant, `match_reason` bm25-ish, no embedding required error.
- **C2 hybrid-mode**: mode `hybrid` → results ranked by fused score; a paraphrase query (different words, same meaning) still hits the right chunk (vector leg working).
- **C3 deep-mode**: mode `deep` → reranker runs (scores in [0,1], NOT all equal), order changes vs fast on a discriminating query.
- **C4 pagination**: `offset`/`limit` paginate without overlap; `has_more` flips false at the end; `offset: 20000` returns the capped window WITH the cap warning.
- **C5 empty-suggestions**: query with zero hits on one-KB store → suggestions field present, no crash.
- **C6 ranking-diagnostics**: result details include score + ranking info consistent with `adjusted_score === score` on non-deep paths.
- **C7 min-score-floor**: a nonsense query on a real KB returns nothing below `PI_KNOWLEDGE_MIN_HYBRID_SCORE` floor (or results justify scores).
- **C8 kb-filter**: search with `kb` scoping never leaks other KBs' chunks.

## D. Math / science features

- **D1 formula-inject**: KB with `$E = mc^2$` and other physics — query "mass energy equivalence" in hybrid → an injected formula result with `match_reason: "formula"` appears (or formula reasons reported).
- **D2 chem-query**: docs mentioning "H2O" and "C6H12O6" — queries `H₂O` (subscript) and `water formula` both hit the chem doc (normalization symmetric).
- **D3 units-query**: doc with "5 km" and "3 kilometers" — query "kilometers" matches the "km" doc segment; unit variants normalize.
- **D4 math-notation-query**: doc with `x^2 + y^2 = r^2` — queries `x²` and `x^2` both hit it (caret/superscript normalization).
- **D5 label-graph**: two md files, B links `[[A]]` — after add, searching B's chunk reports `depends_on`/label provenance including A.
- **D6 adaptive-context**: `PI_KNOWLEDGE_ADAPTIVE_CONTEXT_LINES` set → result context expands with neighboring lines (feature flag honored).

## E. Symbol search

- **E1 symbol-search-ts**: `knowledge_symbol_search` for a TS class/function name → symbol row with file, line, kind, signature.
- **E2 symbol-kinds-python**: python def/class symbols with correct `symbol_kind`.
- **E3 symbol-scope**: nested symbol (method in class) reports `parent_symbol`/scope.
- **E4 symbol-exact-miss**: search for a nonexistent symbol → clean empty result (no crash, helpful message).

## F. Watcher & auto-updates

- **F1 watcher-add**: `engine` add KB from dir + watcher started (via extension startWatcher path or engine watcher API) → create a new file in dir → within debounce+poll window an update fires (chunk for new file appears).
- **F2 watcher-change**: edit existing watched file → content change picked up within window.
- **F3 watcher-delete**: remove watched file → its chunks disappear after update.
- **F4 watcher-change-storm**: 5 rapid writes in one quiet window → exactly ONE update (coalescing).
- **F5 watcher-retry**: if an update is made to fail once (e.g. transient lock via monkeypatched engine in a harness), the change is re-detected and retried after settle (not lost).

## G. PDF & URL ingestion

- **G1 pdf-unpdf-fallback**: real small PDF (test/fixtures/fixture-paper.pdf) with NO marker/docling installed → add succeeds via unpdf fail-open, text searchable, KB ready.
- **G2 pdf-sidecar-cmd**: with `PI_KNOWLEDGE_PDF_SIDECAR_CMD` pointing at a fake converter script (echo valid JSON/markdown to output) → sidecar metadata (`converter`) lands on chunks. (Real marker/docling: SKIP unless installed — `which marker docling` first and note it.)
- **G3 pdf-oversized**: >10 MB junk `.pdf` → cap error (not unbounded read).
- **G4 url-fetch**: `engine` URL add of a real https URL (e.g. https://example.com) → chunks from page text, source recorded.
- **G5 url-caps**: URL responding >10 MB or non-text content-type (`application/pdf` from a real file URL or a local http server) → rejected with clear cap/type error, KB not corrupted.
- **G6 ocr-image**: an image-bearing PDF with `PI_KNOWLEDGE_OCR_ENGINE=tesseract` (fake sidecar emitting an image + OCR'd caption text) → caption text searchable. (True end-to-end OCR needs a scanned-PDF fixture; fake-sidecar path is acceptable evidence, real-tesseract bonus.)

## H. Diagnostics, config & lifecycle

- **H1 status**: `knowledge_status` lists KBs with chunk/vec coverage, indexing job state.
- **H2 doctor**: `knowledge_doctor` on a healthy store → no actionable failures; on a store with a deleted vector file → doctor FLAGS it with an actionable code.
- **H3 show**: `knowledge_show` on a KB → accurate metadata (name, path, counts).
- **H4 configure**: `knowledge_configure` set → persisted; new engine instance reads it back.
- **H5 fresh-migrations**: brand-new `PI_KNOWLEDGE_DIR` → engine boots, schema at latest version, no migration errors.
- **H6 worker-lifecycle**: after several searches, model worker memory does not grow unbounded; `dispose()` kills worker processes (no orphan `model-worker` processes after exit).
- **H7 auto-inject**: `PI_KNOWLEDGE_AUTO_INJECT=true` + engine inject API → context injection contains KB hits (documented opt-in contract).
- **H8 stale-vector-heal**: delete a KB's vector file manually → next search degrades gracefully (bm25-only or explicit rebuild guidance), doctor flags it; `update` rebuilds vectors.

## Lane assignments

| Lane | Features | Wave |
|---|---|---|
| L1-ingestion-files | A1–A10 | 1 |
| L2-ingestion-ops | B1–B9 | 1 |
| L3-search-modes | C1–C8 | 1 |
| L4-science | D1–D6 | 2 |
| L5-symbols | E1–E4 | 2 |
| L6-watcher-ops | F1–F5, H1–H4 | 2 |
| L7-pdf-url | G1–G6 | 3 |
| L8-lifecycle | H5–H8 + re-check A7/A9 edge cases | 3 |
