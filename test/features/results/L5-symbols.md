# L5-symbols — functional test report (features E1–E4)

Lane: L5-symbols · Engine: `/home/yusuf/pi-knowledge/dist/src/engine.js` (real built dist)
Store: isolated `PI_KNOWLEDGE_DIR=/tmp/fx-L5-symbols/store` · Models: offline via
`PI_KNOWLEDGE_MODEL_CACHE_DIR=/home/yusuf/.pi/knowledge/models` + `PI_KNOWLEDGE_OFFLINE=true`
Probes kept at `/tmp/fx-L5-symbols/` (`run.sh`, `setup.mjs`, `probe-e1-ts-symbols.mjs`,
`probe-e2-python-kinds.mjs`, `probe-e3-scope.mjs`, `probe-e4-miss.mjs`).
Corpus: one directory KB `symkb` (status ready, 6 chunks, 2 files): `code-utils.ts`
(class + 2 methods + 2 top-level functions + interface/type/const) and `stats.py`
(class + 2 methods + 2 module-level defs). All runs reproduced twice (individual probes +
full clean `run.sh all` re-run from a fresh store, exit 0).
API surface verified from built types before probing: `symbolSearch(query, options?, signal?)
→ SymbolSearchResponse {results[{name,kind,file_path,file_type,kb_name,start_line,end_line,
signature?,container_name?,text,indexed_at}], total_count, has_more}`.

## Verdicts

E1 | PASS | `run.sh e1`: `symbolSearch("HttpClient",{kind:"class"})` → row `HttpClient` kind "class", file_path code-utils.ts, start_line 10 === actual file line of `export class HttpClient`, signature `export class HttpClient`, kb_name symkb; `symbolSearch("formatDuration")` → kind "function", start_line 26 === actual line, signature `export function formatDuration(ms: number): string`; kind filter integrity: `kind:"function"` returns only function kinds; E1_SUMMARY PASS failures=0

E2 | PASS | `run.sh e2`: `symbolSearch("SampleStats")` → kind "class", file_type "python"; `variance`/`stddev` → kind "function" with `def variance(values, ddof=0):` / `def stddev(values, ddof=0):` signatures at lines 16/21 (actual fixture lines); all 7 stats.py symbol rows have kind in {class, function}; E2_SUMMARY PASS failures=0

E3 | PASS | `run.sh e3`: TS method `request` → container_name "HttpClient"; Python method `mean` → container_name "SampleStats" (scope evidence on the API response); top-level `formatDuration` → container_name undefined (no bogus parent); read-only sqlite peek of knowledge.db symbols table: AST rows carry metadata `parent_symbol="HttpClient"` scope `["HttpClient","request"]` ast_path `program/class_declaration/method_definition` (TS) and `parent_symbol="SampleStats"` scope `["SampleStats","mean"]` ast_path `module/class_definition/function_definition` (Python); E3_SUMMARY PASS failures=0

E4 | PASS | `run.sh e4`: `symbolSearch("ZqxWidgetNonexistentBlorp")` in fuzzy, `exact:true`, and kind-scoped variants → each returns normally (no throw) with exactly `{"results":[],"total_count":0,"has_more":false}` and shape keys results,total_count,has_more; sanity guard `symbolSearch("SampleStats",{kind:"class"})` on the same engine instance → total_count 1 (empty result is not an engine-wide failure); E4_SUMMARY PASS failures=0

## Observations (non-blocking, not contract violations)

- Duplicate rows for class methods: `symbolSearch("mean")` returns TWO rows — the AST-extracted row (container_name "SampleStats") and a regex-fallback row (container_name null, metadata `{}`); the dedupe key includes container_name so both survive by design (dist/src/indexer/chunker.js dedupeSymbols). Consumers of the tool see a duplicate entry; harmless, worth awareness only.
- E4 "helpful message": the engine API itself returns a clean empty response with no message field; the user-facing fallback text ("No symbols found. This may mean the symbol is absent, symbol metadata is missing/stale, or the lightweight extractor does not cover this syntax…") is produced by the `knowledge_symbol_search` tool wrapper (index.ts:645). Engine-level cleanliness verified by executed probe; the wrapper message verified by static code read only (needs Pi runtime to exercise end-to-end).
- Symbol extraction for TS/Python runs through the tree-sitter AST path (installed grammars); regex extractor is the fallback. Both paths exercised via the corpus above.

## Environment

- node v26.8.1; engine booted from dist with fresh schema (setup created store from empty dir); no network access (PI_KNOWLEDGE_OFFLINE=true, models local cache; symbol search needs no embeddings).
- No repo files modified; probes and scratch corpus live entirely under /tmp/fx-L5-symbols/. Store DB opened read-only for the metadata peek in E3.
