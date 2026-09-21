# Changelog

## [1.0.0] - 2026-09-21

### Added
- Added table-narrative coupling for PDF text-layer extraction (unpdf path): detected table blocks (3+ consecutive column-gap or pipe-delimited lines) carry their nearest preceding narrative sentence as a `Context:` line, so concept queries about a table ("Table 5 shows …") and number queries about its cells retrieve the same chunk. The transform is idempotent, stops at headings and neighboring tables, applies only to the PDF text-layer path (sidecar markdown keeps its own heading provenance), and oversized tables carry the context in their first chunk.
- Extended PDF table-narrative coupling with row-label stamping: every data row of a detected table block is prefixed `Row: <label> | ` (first cell via the same pipe/2+-space column heuristics, whitespace-collapsed, max 60 chars truncated at a word boundary; stamped only when the first cell contains an ASCII letter and a digit appears later in the line, so headers, `---` separators, and pure-numeric rank cells stay unstamped; already-stamped lines pass through byte-stable), so a numeric hit like `62.86` arrives on a line that also carries its method name.
- Added chemistry-aware formula matching: `\ce{…}` inputs and plain molecular formulas (for example `H2SO4`) route through a dedicated chemistry normalizer inside the single formula-normalization entry point, unifying unicode subscripts, charges, hydrate dots, state suffixes, arrows, and parenthesized groups into one case-sensitive token signature (`Co` never matches `CO`). Plain chemistry queries like `H2SO4` now work without a TeX wrapper; prose-level molecular formula detection stays intentionally out of scope.
- Added engineering-unit matching in keyword search: a middle dot between two recognized unit tokens is rewritten in the shared FTS tokenizer, so `N·m` and `N m` produce identical index and query terms, symmetrically for indexed chunks and queries. The unit set is a frozen conservative list of SI units and common prefixed forms; single-token forms like `Nm` are intentionally not split, and non-unit pairs are untouched.
- Added a golden-query evaluation harness (`npm run eval`) with per-domain golden files (math notation, formulas, chemistry, units, code, prose, LaTeX labels). The default `--fixture` mode builds an ephemeral knowledge base from committed fixtures as a byte-deterministic hard gate — two consecutive runs produce identical recall reports and any miss exits non-zero; `npm run eval -- --kb <name>` runs the same goldens read-only against a real knowledge base as an advisory live-corpus report.
- Added PDF image persistence and optional OCR captions for sidecar-converted PDFs: referenced images are stored content-addressed under `<knowledge-dir>/image-store/<sha256>.<ext>` with chunk links rewritten to the stored paths, and caption-less images are OCR'd through an optional user-installed tesseract binary, appending searchable `*OCR:*` paragraphs. Missing image files drop the reference, OCR failures fail open, and `PI_KNOWLEDGE_OCR_ENGINE` / `PI_KNOWLEDGE_OCR_CMD` mirror the PDF sidecar configuration; reset the store with `rm -rf <knowledge-dir>/image-store`.
- Added a LaTeX label graph: `.tex` chunks record `\ref`-family targets (`\ref`, `\eqref`, `\cref`, `\Cref`, `\autoref`) alongside existing `\label` metadata, references resolve by scope key (sha256 of relative path + label; same-file preferred; collisions and missing labels resolve as unresolved, never guessed) into a `label_edges` table (schema v7, backfilled once per KB), and a query naming a label boosts chunks it references or injects them with `match_reason: "dependency"` at a fixed 0.25 base score under the same filter and threshold-bypass rationale as formula evidence. KBs without label edges keep byte-identical results.
- Added query-by-formula retrieval for math knowledge bases. Display formulas indexed from chunk metadata are normalized into a lexical-structural token signature (layout commands, style wrappers such as `\dfrac`/`\mathrm`, spacing, braces, math unicode, and TeX aliases like `\le`/`\leq` canonicalized; no AST parsing or symbolic equivalence), stored in a dedicated formula table with its own FTS index (schema version 6, backfilled lazily once per knowledge base on the first formula-bearing query), and matched when the query itself contains a formula. Exact and fuzzy formula matches boost already-retrieved chunks and inject up to 5 formula-only chunks with `match_reason: "formula"` that bypass the hybrid confidence gate by design; queries without math keep byte-identical results, with no new dependencies or environment variables.
- Added optional PDF extraction through an external converter sidecar (marker primary, docling alternative; `pip install marker-pdf` / `pip install docling`). Scientific PDFs are converted to Markdown with `$$…$$` math and flow through the math-aware chunking pipeline with formula blocks, headings, and table protection intact; chunks keep `file_type: pdf` for filters and record their converter in chunk metadata and a `Converter:` context line. The sidecar is strictly optional and fail-open: when absent, failing, or timing out, extraction falls back silently to the previous text-layer path, and failed conversions are reported as `pdf_sidecar_failed` scan statistics. Configure via `PI_KNOWLEDGE_PDF_ENGINE`, `PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS`, `PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD`, `PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD`, and the `PI_KNOWLEDGE_PDF_SIDECAR_CMD` argv-template escape hatch.
- Added a content-hash conversion cache under `<knowledge-dir>/pdf-cache/` keyed by PDF bytes, engine, adapter version, and the OCR setting, so `knowledge_update` never re-runs an expensive conversion for an unchanged PDF. Reset with `rm -rf <knowledge-dir>/pdf-cache`.
- Added math and science-aware chunking for Markdown and LaTeX knowledge bases. Display math (`$$`, ` ```math ` fences, `\begin{equation}`-family environments, `\[..\]`), pipe tables, and fenced code are atomic chunking units that are never split mid-structure, and oversized blocks split only at row/line boundaries.
- Added cross-notation math matching: `preTokenizeForFTS` canonicalizes math unicode (Greek letters, operators, relations, arrows, super/subscripts) onto LaTeX command words, so `x²`, `x^2`, `α`, and `\alpha` all hit the same FTS terms, symmetrically for index and query.
- Added Obsidian-style vault metadata for Markdown chunks: frontmatter `title`/`tags`/`aliases`, `[[wikilinks]]`, and per-chunk display-formula excerpts become chunk metadata and embedding context lines.
- Documents whose first line is `---` are parsed as frontmatter (Obsidian/gray-matter semantics): the block is stripped from chunk content and its values become `title`/`tags`/`aliases` chunk metadata.
- Added a dedicated `latex` file type (`.tex`, `.ltx`, `.latex`) with `\chapter`/`\section`/`\subsection`/`\subsubsection` breadcrumb chunking, `\label` metadata, LaTeX heading symbols, and `file_type: latex` filter support (`tex`/`ltx`/`latex` aliases).

### Changed
- LaTeX chunk metadata now includes `\ref`-family reference targets. Because chunk metadata feeds the chunk identity hash, LaTeX-bearing chunks re-hash and re-embed on the first `knowledge_update` after upgrading; non-LaTeX chunks keep their existing hashes and vectors.
- Markdown and LaTeX chunks hash differently after this change; run `knowledge_update` once after upgrading so affected Markdown/LaTeX files re-chunk and re-embed. Other file types keep their existing chunk hashes and vectors.

### Fixed
- Fixed C++ pointer-to-function data members (`int (*cb)(int);`) still classified as methods (tree-sitter aliases the top-level declarator to function_declarator; the parenthesized inner declarator is the giveaway), C++ nested template headers falling outside the chunk span, TS ambient `declare module "x"` names keeping their quote characters, and python header re-anchoring that could match inside a decorator string literal.
- Fixed AST code indexing silently skipping TypeScript `namespace`/`module` members (they landed in no chunk and no symbol row in any mixed file), unnamed Go `type` declarations, C++ namespace free prototypes misclassified as methods, function-pointer data members classified as methods, C++ `template <...>` header lines falling outside the chunk span, duplicate chunks for multi-declarator `export const a = () => …, b = () => …`, missing Java `record`/compact-constructor symbols, and python signatures under multi-line-wrapped decorators.
- Fixed chunk-provenance line drift in markdown and plain-text chunking: oversized text blocks now anchor slices to their own start line instead of the section end, the first normal block after an oversized block re-anchors its buffer, blank-line counts between a heading and its content are reconstructed from the real source instead of a hard-coded two-line layout, and oversized paragraph slices in plain text count raw lines (mirror of the markdown fix).
- Fixed AST-packed code chunks silently including draft-less source between packed functions (imports, loose declarations, comments) — the packed span is now capped at the 6,000-char chunk bound — and fixed annotated Python signatures being cut at the first colon (`def f(x: int):` kept its full header).
- Fixed local/HF cross-encoder reranking silently producing constant scores: the default path fed `{text, text_pair}` to the text-classification pipeline, which has no pair-input support in @huggingface/transformers 3.8.1, so query/candidate pairs never reached the model and every candidate scored ~0 (identity order). Reranking now tokenizes pairs directly through the shared tokenizer machinery and scores single-logit cross-encoders with sigmoid (softmax-max for genuine multi-class classifiers); `PI_KNOWLEDGE_RERANKER_RAW_LOGITS` still reports raw logits.
- Fixed single-line `\[ x \]` display math swallowing subsequent prose up to an unrelated later `\]` during segmentation: a same-line close is now detected as a single-line atomic region, mirroring the `$$` handling.
- Fixed PDF sidecar diagnostics losing the numeric exit code: `execFile` rejects with a numeric `err.code` for normal non-zero exits, so every real sidecar failure reported "exited with code unknown"; the message now carries the actual exit code. Unwritable temp dirs and `$&`-style sequences in alt text or file paths no longer corrupt conversions or rewritten image links, and a failed vector-file reopen during an update closes already-open handles instead of leaking them.
- Fixed watcher-triggered updates silently losing file changes: overlapping same-KB updates now reject loudly ("already running") instead of coalescing into the in-flight run's stale-scan promise, the watcher records the rejection as a pending retry and re-runs after the in-flight update settles (its settle path no longer consumes disk state the rejected run never indexed), scan failures inside watcher timers fail open instead of crashing the process, and the native-watch error handler closes its own instance rather than whatever watcher currently occupies the KB slot.
- Fixed `knowledge_search` fast and hybrid BM25 modes dropping canonical math composite tokens: queries were normalized twice, so `mc²` collapsed to `mc pow` instead of matching `mc pow2` in the index. Math-notation queries (for example `mc²` finding `E = mc^2`) now work through the engine search path; direct `searchBM25` callers were unaffected.
- Hardened chemistry formula matching against catastrophic regex backtracking: the molecular-formula grammar now uses a lookbehind-guarded digit alternative (linear backtracking) and rejects degenerate 25+ digit runs before matching; a crafted formula in a query or indexed document could previously stall the process.
- Fixed duplicate search rows when a chunk matched both the formula evidence and the label-graph dependency leg: dependency injection now skips chunks already injected by the formula leg, so every chunk appears at most once with a single `match_reason`.
- Fixed cancelled URL/PDF knowledge updates being misclassified as failures (knowledge base stuck in `error`): aborts are now recognized as cancellations, restoring the prior knowledge-base status and recording a cancelled job. A broken embedding configuration can likewise no longer leave a permanently "running" indexing job.
- Fixed Markdown chunking treating `#` lines inside fenced code blocks as headings: fenced code stays atomic and fake headings no longer leak into chunk breadcrumbs; plain-text chunks after a mid-section flush now carry real start/end line coordinates instead of collapsed ones.
- Fixed a crash window in `knowledge_remove` where a failure between the delete statements could leave a half-deleted knowledge base: the six deletes now run in one transaction. Opening a database written by a newer schema version now fails with a clear error instead of proceeding against an unknown schema.
- Fixed formula and label-graph backfills scanning every knowledge base's chunks on each add/update and search-path ensure: both are knowledge-base-scoped now, and the formula delete path gained a `chunk_id` index while adaptive context gained a `(kb_id, file_path)` index (schema v8, additive).
- Fixed `knowledge_search` silently returning empty results for an unknown `kb_id` (now the same "Knowledge base not found" error as symbol search), negative `offset` values counting from the end of results, and search diagnostics reporting pre-boost scores for formula/dependency-boosted chunks (injected chunks now publish explicit injected ranking diagnostics).
- Fixed NaN `limit`/`offset` values binding as NULL in SQLite (LIMIT NULL is unbounded) in formula FTS and symbol search, and a cancelled export leaving an unhandled stream error when its temp file was removed before the async open completed.
- Fixed the eval harness leaking its ephemeral fixture directory when validation failed mid-run (failure now throws through the cleanup path instead of exiting early), and added response-shape validation for OpenAI-compatible embedding endpoints with descriptive errors.
- Removed dead code: `reciprocalRankFusion`, `getChunkHashesByKB`, the never-emitted `rebuild_vectors`/`check_source` doctor action codes, and the inert `quantized` pipeline flag (the local load contract is frozen at fp32 and documented).

## [0.10.1] - 2026-09-10

### Fixed
- Repaired `knowledge_update` recovery for knowledge bases whose SQLite chunks are ahead of a short or truncated vector file; update now rebuilds or re-embeds missing vectors instead of leaving the KB in `error` (#13).
- Aligned the published Tree-sitter runtime and grammar dependency graph so clean npm installs no longer emit peer override warnings for `tree-sitter@0.25.1` incompatibilities (#14).

## [0.10.0] - 2026-08-27

### Added
- Added Bash AST indexing for `.sh` and `.bash` scripts, including both `name() {}` and `function name {}` forms with bounded fallback chunking (#12).
- Added GNU C AST indexing for `.c` source files, covering functions, prototypes, structs, unions, enums, typedefs, reliable preprocessor symbols, and `static` metadata (#12).
- Added C++ AST indexing for `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, and `.hxx` files, covering namespaces, classes, methods, constructors, destructors, enums, templates, and access visibility where the parser reports it reliably (#12).
- Added QML AST indexing for `.qml` files, covering imports, component/object hierarchy, ids, properties, signals, handlers, bindings, and embedded JavaScript functions (#12).

### Changed
- Kept ambiguous `.h` headers classified as text by default; use typed C++ header extensions for C++ AST indexing (#12).
- Parser errors in Bash, C, C++, and QML now intentionally fall back to existing text chunking instead of indexing partial structural claims (#12).

## [0.9.0] - 2026-08-26

### Added
- Added recursive AST chunking for supported code files, including same-parent sibling packing, bounded oversized leaf fallback, and structural chunk metadata for language, symbol kind, scope, parent symbol, signature, export state, AST path, and source line range (#11).
- Added AST-backed symbol extraction for supported code files so method symbols remain searchable independently from retrieval chunk boundaries (#11).
- Added metadata-driven AST-aware adaptive context expansion so `adaptive` search can prefer same-file parent/sibling chunks while preserving bounded context and clean returned source.

### Changed
- Code indexing now analyzes supported source files once for both retrieval chunks and symbols, while preserving regex/text fallbacks for unsupported or unparsable content.
- Searchable embedding/FTS text now includes richer deterministic code structure; existing KBs should be updated or rebuilt to benefit from the new metadata.


## [0.8.1] - 2026-08-08

### Fixed
- Declared host approval tiers for public knowledge tools so read-only search no longer defaults to exec approval in OMP headless sessions (#10).

## [0.8.0] - 2026-08-04

### Added
- Added Hugging Face Text Embeddings Inference reranker API format support through `PI_KNOWLEDGE_RERANKER_API_FORMAT=tei`.


## [0.7.0] - 2026-07-28

### Added
- Added `PI_KNOWLEDGE_RERANKER_RAW_LOGITS` for trusted single-logit local/Hugging Face cross-encoder rerankers whose sigmoid scores flatten near 1.0.

### Fixed
- Preserved the default reranker config shape when raw logits are unset.
- Rejected multi-logit and non-finite raw reranker outputs instead of guessing a relevance score.

## [0.6.0] - 2026-07-25

### Added
- Added configurable local/Hugging Face reranker selection through `PI_KNOWLEDGE_RERANKER`, including revision, dtype, and trusted mirror settings.
- Added API reranker support for `deep` search with Cohere/Jina-compatible requests and declarative custom JSON response mapping.
- Added embedding metadata signatures and dimensions so knowledge bases can detect incompatible vector spaces after provider, API base URL, preprocessing, or dimension changes.

### Changed
- Document embedding batches now surface OpenAI-compatible API failures instead of falling back to local embeddings during add, update, or import, preventing mixed-provider vector files.
- `knowledge_search` skips incompatible or legacy unsigned vectors with warnings, while hybrid search can fall back to BM25-only results until `knowledge_update` rebuilds vectors.

### Fixed
- Rebuilds unchanged chunks during `knowledge_update` when embedding metadata is missing or incompatible, rather than reusing stale vectors.
- Resets Transformers.js remote model settings before embedding loads so custom reranker mirrors do not affect the embedding pipeline.

## [0.5.6] - 2026-07-23

### Added
- Added runtime search tuning profiles (`auto`, `low_token`, `precision`, `recall`, `long_context`, `code`, `docs`, `balanced`) with diagnostics that report the applied result limit, snippet length, hybrid threshold, candidate pool, adaptive context, and deep rerank breadth.

### Changed
- Added bounded environment overrides for search defaults so slow local model users can reduce result count, lengthen snippets, tighten hybrid precision, or tune candidate breadth without editing source.

## [0.5.5] - 2026-07-23

### Added
- Added `knowledge_configure` so agents can validate and persist a Node 22+ executable for the isolated local model worker without relying on environment variables injected after OMP startup.

### Fixed
- Auto-discovers Codex bundled Windows Node runtimes under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*\bin\node.exe` for OMP sessions without global `node` on `PATH`.
- Reuses persisted runtime config before falling back to process or PATH discovery, so one successful configuration survives future OMP sessions.

## [0.5.4] - 2026-07-23

### Fixed
- Prevented missing Windows `node.exe` from surfacing as an uncaught `uv_spawn 'node'` failure by resolving Node before worker startup and wrapping synchronous spawn failures with model-worker diagnostics.
- Expanded Windows Node discovery to common Node, Volta, and NVM install locations, and stripped accidental surrounding quotes from `PI_KNOWLEDGE_NODE_PATH` paths with spaces.


## [0.5.3] - 2026-07-23

### Fixed
- Added a Windows-safe model-worker transport fallback so OMP hosts without `child_process.fork().send()` can still build local embedding knowledge bases through a stdin/stdout JSONL worker protocol.
- Validated the isolated worker Node 22+ executable and worker file before local model startup, with clearer `PI_KNOWLEDGE_NODE_PATH` diagnostics.
- Hardened OMP/Windows storage-path detection for `omp.exe` hosts and Windows-style home path casing.

### Changed
- Documented Windows OMP local embedding startup requirements, transport fallback behavior, and troubleshooting guidance.

## [0.5.2] - 2026-07-19

### Fixed
- Updated `better-sqlite3` to 12.11.1 so Node 26 installs and native SQLite loading work (#4).

## [0.5.1] - 2026-07-07

### Fixed
- Indexed PDF/DOC/DOCX files discovered during directory add and update through the document extractors instead of treating them as binary skips.
- Skipped failed directory document extraction as `extraction_failed` without failing the whole knowledge base.
- Required explicit `confirm: true` for public destructive `knowledge_remove` and `knowledge_clear` tool calls.
- Aligned `path_pattern` documentation and tool guidance with the implemented substring filter behavior.

## [0.5.0] - 2026-07-07

### Added
- Added route symbol extraction and exact route lookup support through `knowledge_symbol_search`.
- Added structured `details` payloads for search diagnostics and doctor actions so agents can consume provenance and remediation codes without parsing text.

### Fixed
- Deleted vector files when knowledge bases are removed or cleared, including orphan detection in diagnostics.
- Guarded destructive and long-running operations with stronger mutation and shutdown lifecycle checks.
- Preserved ready knowledge bases when update cancellation happens before mutation starts, and kept partial update state from polluting symbol search.
- Propagated cancellation through search, export, import, diagnostics, and external embedding API requests.

### Changed
- Reworked JSONL import/export around streaming I/O and bounded batches for large portable knowledge bases.
- Improved watcher exclusions so generated, vendor, and runtime artifacts do not trigger unnecessary scans.
- Expanded Pi/OMP release coverage with lifecycle, cancellation, watcher, symbol, tool-contract, and model-worker regressions.

## [0.4.7] - 2026-07-04

### Fixed
- Avoided live SQLite statement iterators in chunk row scans so search, diagnostics, and vector rebuild paths cannot leave the database connection busy before `knowledge_update`.
- Coalesced overlapping `knowledge_update` calls per knowledge base so watcher-triggered updates, manual updates, retries, and shutdown do not re-enter the same update flow.

### Changed
- Increased SQLite busy timeout to tolerate short-lived external contention during long indexing/update work.
- Updated npm-facing README and package metadata to show Pi and OMP (`omp.sh`) coding-agent support.

## [0.4.6] - 2026-06-26

### Fixed
- Split oversized Markdown paragraphs and code blocks into bounded chunks so external embedding servers do not receive single over-context Markdown chunks.
- Added OpenAI-compatible embedding base URL support via `PI_KNOWLEDGE_EMBEDDING_BASE_URL` / `OPENAI_BASE_URL`.
- Added configurable API embedding input truncation via `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS` as a final context-window safety guard.
- Surfaced embedding API failures by default instead of silently falling back to local embeddings; explicit local fallback is available with `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local`.
- Included model worker stderr in startup/exit failures to make `knowledge_add` worker crashes diagnosable.

### Changed
- Documented all runtime environment variable overrides in `docs/configuration.md`.
- Documented Pi and OMP support boundaries, storage path resolution, and release validation expectations.
- Wired `PI_KNOWLEDGE_OFFLINE` to disable remote Transformers.js model downloads when using a pre-populated local model cache.

## [0.4.5] - 2026-06-24

### Fixed
- Deferred extension runtime imports so OMP plugin validation does not resolve native dependencies during install.
- Added Bun-binary-safe `better-sqlite3` loading fallback for hoisted plugin dependencies.
- Hardened lazy runtime shutdown so in-flight extension startup is disposed before Pi or OMP exits.

## [0.4.4] - 2026-06-23

### Fixed
- Simplified the packaged `extension.js` entry shim while preserving the built `dist/` first, source `index.ts` fallback behavior for local development.

## [0.4.3] - 2026-06-23

### Fixed
- Added a packaged `extension.js` entry shim that loads built `dist/` output when available and falls back to source during local development.
- Fixed packaged model-worker startup so built JavaScript loads `dist/src/model-worker.js` without TypeScript strip flags while source development still uses `model-worker.ts`.
- Added OMP-aware knowledge storage path resolution with explicit `PI_KNOWLEDGE_DIR` / `OMP_KNOWLEDGE_DIR` overrides and legacy Pi knowledge-dir preservation for the default home OMP root.
- Fixed strict TypeScript build issues in the extension entry, engine indexing path, AST chunker, and model worker.

### Changed
- Added a real `typecheck` release gate and made `prepack` run typecheck plus build before npm packaging.
- Updated contributor and architecture docs for the packaged `extension.js` entry, `dist/` package contents, and release validation flow.

## [0.4.2] - 2026-06-18

### Changed
- Added the `pi-package` npm keyword so the published package can be discovered by Pi's package catalog.
- Published the updated product positioning metadata introduced after v0.4.1, including local-first RAG, hybrid code/doc search, reranking, diagnostics, and large-project indexing keywords.

## [0.4.1] - 2026-06-16

### Fixed
- Isolated local Transformers.js embedding and reranker models in a model worker process so Pi's TUI process no longer loads `onnxruntime-node`, fixing macOS arm64 `/quit` aborts after knowledge-base tool usage.
- Removed the custom `knowledge_search` TUI renderer and switched warning output to plain text to avoid Pi TUI line-width render crashes.
- Kept native ONNX idle disposal opt-in only, prioritizing stable session shutdown over aggressive memory reclamation.

### Changed
- Documented the native model lifecycle contract, the onnxruntime teardown pitfall, and the worker-based shutdown strategy in contributor and architecture docs.

## [0.4.0] - 2026-06-16

### Added
- Added persisted indexing job state for long-running `knowledge_add`, `knowledge_update`, and `knowledge_import` operations. `knowledge_status` now reports operation, phase, last progress message, last progress age, processed files/chunks, skipped count, and add/remove/unchanged counts so large indexing runs do not look frozen after transient tool updates disappear.
- Added metadata-only directory planning and chunk throughput in indexing progress so large repositories show total scannable files, skipped counts, chunks/sec, and file ETA before expensive embedding starts.
- Added `knowledge_plan` as a no-write indexing scope inspection tool so agents can show scannable files, suggested exclusions, and technical skips before asking the user to confirm risky or low-signal text.
- Added contextual indexing for rebuilds: embeddings and FTS now include file path, file type, heading breadcrumbs, and code symbols while keeping returned chunk content readable.
- Added more focused rebuild-time chunking for Markdown and plain text, with reduced overlap to avoid near-duplicate retrieval units.
- Added adaptive search mode with query-time contextual window expansion around relevant seed chunks.
- Added balanced/strong/off diversity controls for search result reranking to reduce near-duplicate chunk clusters.
- Added query-aware snippets so search results show the matched context instead of always showing the chunk prefix.
- Added vector-aware redundancy scoring and overlapping adaptive window collapse for higher-diversity top results.
- Replaced hybrid RRF scoring with normalized weighted score fusion to preserve meaningful score spread.
- Added file-level result interleaving so README-style overview files cannot dominate top results with repeated chunks.
- Added confidence gating for hybrid search so low-evidence garbage queries return no results instead of unrelated matches.
- Strengthened source-file intent scoring so named modules and core implementation files outrank overview and test files when appropriate.
- Demoted localization catalogs for implementation-oriented queries while preserving them for explicit translation or locale intent.
- Suggested excluding generated knowledge-base evaluation reports from default directory indexing to prevent self-referential retrieval pollution, while allowing confirmed inclusion through scope overrides.

### Changed
- Reworked directory indexing policy from hard text-file blocking to suggested exclusions plus confirmed scope overrides. Risky or low-signal text such as `.env`, secret/credential-named text, generated reports, lockfiles, vendor text, build output text, and runtime/cache text is skipped by default but can be included after user confirmation with `include_suggested_text` or focused `include_paths`. Unsupported binary/non-text, oversized, unreadable, inaccessible, and unextractable files remain technical skips.
- Persisted confirmed include/exclude scope options so `knowledge_update` preserves the same directory indexing scope instead of silently dropping user-confirmed text files.

## [0.3.5] - 2026-06-15

### Fixed
- Prevented idle model disposal from running during active embedding or reranking batches, fixing `Session already disposed` during large `knowledge_add` operations.
- Avoided ONNX native disposal during Pi `session_shutdown`, preventing macOS onnxruntime mutex crashes on session exit.
- Allowed `knowledge_search` `kb_id` to accept either a KB UUID or exact KB name.
- Truncated custom TUI render lines to prevent Pi crashes when search result snippets exceed terminal width.

### Changed
- Added `PI_KNOWLEDGE_EMBEDDING_IDLE_MS` for lifecycle stress testing of embedding idle disposal.

## [0.3.4] - 2026-06-15

### Fixed
- Reject duplicate `knowledge_add` names with an actionable message instead of silently creating multiple same-name knowledge bases.
- Strengthened default directory indexing ignores for build outputs and common secret/config files.

### Changed
- Updated `knowledge_add` tool guidance to prefer one directory-level indexing call and avoid per-file indexing loops.

## [0.3.3] - 2026-06-15

### Changed
- Added a mandatory async lifecycle review contract for timers, event handlers, dispose, and shutdown paths.
- Clarified review requirements for overlap analysis, guard-state updates before await points, idempotent cleanup, and recreate-after-dispose behavior.

## [0.3.2] - 2026-06-15

### Fixed
- Made local embedding and deep reranker model disposal idempotent to avoid concurrent native ONNX session teardown from idle timers and Pi `session_shutdown`.

### Changed
- Updated the onnxruntime exit-crash pitfall notes with the double-dispose race mitigation.

## [0.3.1] - 2026-06-15

### Fixed
- Made watcher shutdown cover both native watchers and polling fallbacks without mutating the collection being iterated.
- Clarified the startup-safe render component shim contract without overclaiming Pi internals.

### Changed
- Documented the difference between e2e smoke runs and release-grade PDF/DOCX fixture coverage.
- Added agent/contributor contracts for verification-level reporting, private fixture handling, documentation alignment, and the release/publish flow.

## [0.3.0] - 2026-06-15

### Fixed
- Corrected BM25 fast-mode score semantics so higher scores are consistently better after search fusion/sorting.
- Made URL knowledge bases a first-class source type and allowed `knowledge_update` to re-fetch URL sources.
- Threaded `AbortSignal` into incremental update embedding.
- Fixed stale diagnostics for single-file knowledge bases.
- Normalized `unpdf` page-array output before chunking PDF text.
- Made JSONL import cleanup partial KBs on failure and import exported KBs as portable text sources.
- Removed root extension runtime dependency on Pi virtual modules so Node strip-only startup smoke tests can run outside Pi.
- Restored `knowledge_search` custom rendering with a startup-safe local TUI component shim.
- Added polling fallback for file watching when native `fs.watch` is unavailable or fails with resource limits.
- Updated Biome 2 configuration so `npm run check` is a working quality gate.

### Added
- Regression coverage for BM25 score direction, URL update, update cancellation, single-file diagnostics, import failure cleanup, and portable import/export behavior.
- E2E coverage for deep rerank, external PDF/DOCX fixtures, and watcher updates without committing private fixture data.
- Development contract notes for Pi runtime imports, source-type update behavior, portable exports, and release gates.

## [0.2.2] - 2026-06-15

### Fixed
- AbortSignal now threads end-to-end (tool → engine → embedding loop)
- Cancellation actually works during long embedding operations

### Added
- TUI custom rendering for knowledge_search (renderCall + renderResult)
- All DESIGN.md phases complete (30/30 checkboxes)

## [0.2.1] - 2026-06-15

### Fixed
- README lists all 9 tools (was missing export/import)
- npm package includes .pi/skills/ for skill distribution

## [0.2.0] - 2026-06-15

### Added
- URL indexing (fetch → HTML strip → chunk)
- PDF text extraction (via unpdf, pure JS)
- DOCX text extraction (via mammoth, pure JS)
- Import/export knowledge bases (JSONL format, git-friendly)
- Performance benchmarks (BM25: 0.05ms, hybrid: 2.1ms)
- Pi Skill: /skill:search-docs
- 9 tools total

## [0.1.4] - 2026-06-15

### Added
- Vector memory cache (search no longer re-reads disk per query)
- AbortSignal support in embedding (cancellable long operations)
- Schema migration infrastructure (future-proof DB upgrades)
- Model mismatch warning on search (suggests re-index)
- Engine regression tests (+6, total 34)
- README Data Storage section
- URL indexing (knowledge_add with http/https URLs, auto HTML strip)
- Performance benchmarks (BM25: 0.05ms, hybrid: 2.1ms, semantic: 2.0ms)
- Pi Skill: `/skill:search-docs` for guided knowledge search

### Fixed
- walkDir skips permission-denied directories
- DESIGN.md phases corrected

## [0.1.3] - 2026-06-14

### Fixed
- Short files index correctly (single chunk fallback)

## [0.1.2] - 2026-06-14

### Fixed
- Short files (<50 chars) now index correctly as a single chunk

## [0.1.1] - 2026-06-14

### Added
- Java AST chunking (6 languages total: TS, JS, Python, Go, Rust, Java)

## [0.1.0] - 2026-06-14

### Added
- Project scaffold and design document
- Extension entry point with 7 tools: knowledge_add, knowledge_search, knowledge_update, knowledge_status, knowledge_show, knowledge_remove, knowledge_clear
- SQLite storage with FTS5 full-text search (WAL mode, content-sync triggers)
- Markdown-aware and paragraph-based chunking with camelCase/CJK pre-tokenization
- Local embedding via @huggingface/transformers (multilingual-e5-small, 384d, lazy load + idle dispose)
- Hybrid search: BM25 + vector cosine + Reciprocal Rank Fusion (RRF)
- Cross-encoder reranking (mode: "deep") via ms-marco-MiniLM-L-4-v2
- Incremental re-indexing (content-hash diff, only embeds changed chunks)
- File watcher (fs.watch recursive + debounce, opt-in PI_KNOWLEDGE_WATCH=true)
- Auto-injection per turn (opt-in PI_KNOWLEDGE_AUTO_INJECT=true, BM25 fast search)
- Metadata filters in search (file_type, path_pattern)
- Pagination (offset/limit)
- Vector binary storage (save/load Float32Array[])
- 25 unit tests (chunker + search pipeline)
- Comprehensive docs: competitive analysis, kiro parity mapping, embedding models, search pipeline, chunking strategies, FTS5 tokenization, offline mode, technical decisions (ADRs), Pi extension architecture
