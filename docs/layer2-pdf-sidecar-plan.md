# Layer 2 — PDF Scientific-Document Sidecar: Technical Execution Plan

Status: DRAFT SPEC — awaiting approval (implementation baseline after approval)
Date: 2026-09-17
Depends on: Layer 1 (math-aware chunking, `docs/layer1-math-science-chunking-plan.md`) — already implemented and merged (commits `99084cc..0297af5`).

---

## 0. Purpose & Success Definition

Today, PDFs are extracted with **unpdf's raw text layer**, which turns formulas into glyph soup and destroys structure. Layer 2 makes `pi-knowledge` index scientific PDFs through an **optional external converter sidecar** (`marker` primary, `docling` alternative) that outputs **Markdown with `$$…$$` LaTeX math** — which then flows into the existing Layer 1 pipeline (math-aware `chunkMarkdown`, canonicalization, protected regions).

1. A scientific PDF (formulas, tables, sections) is chunked with **formula blocks intact** and searchable across notations (query `mc²` finds `E = mc^2` printed in a PDF).
2. The sidecar is **strictly optional at runtime**: not installed / failing / timing out ⇒ silent fail-open to today's unpdf path. Zero behavior change when absent.
3. **No new npm dependencies** — sidecars are external binaries (pip-installed by the user), invoked as subprocesses.
4. Conversion results are **cached** in the knowledge dir keyed by file bytes, so `knowledge_update` never re-runs an expensive conversion for an unchanged PDF.
5. Provenance preserved: chunks of a PDF keep `file_type: "pdf"` (filters keep working) and record which converter produced them.

**Success is measured by the acceptance criteria in §6/§7.** This document is the verification baseline; deviations require explicit re-approval.

## 1. Scope

### In scope
- NEW module `src/indexer/pdf-sidecar.ts`: config resolution, sidecar detection, subprocess adapters (marker/docling), content-hash cache, output validation, timeout/abort handling.
- `src/engine.ts`: `.pdf` branch of `extractSourceFileContent` tries sidecar → falls back to unpdf; `ExtractedSourceFile` carries optional `sourceFormat`/`converter`; new skipped-scan reason.
- `src/indexer/chunker.ts`: `chunkFile` gains an optional file-type override; `chunkMarkdown` gains optional `fileType` + `extraMetadata` params (backward-compatible defaults).
- Tests: NEW `test/unit/pdf-sidecar.test.ts`, extended `test/unit/chunker.test.ts`, NEW engine-level e2e with a committed fixture PDF + a fake sidecar script; real-binary e2e **env-gated** (skipped unless the binary exists and `PI_KNOWLEDGE_TEST_SIDECAR` is set).
- Docs: `docs/configuration.md`, `docs/technical-decisions.md` (ADR-021), `docs/known-pitfalls.md`, `README.md`, `CHANGELOG.md`, `AGENTS.md`.

### Out of scope (explicit non-goals — do NOT implement)
- Shipping/bundling any Python converter (user installs `marker-pdf` or `docling` themselves; model weights are never downloaded or redistributed by us).
- OCR quality tuning, VLM mode selection beyond a pass-through flag.
- A second-class docling feature parity (docling = same adapter contract, minimal args).
- DOCX re-extraction via docling (mammoth stays; additive later).
- Formula-to-formula structural retrieval (Layer 3), reranking changes, Obsidian mirror export (optional Layer 2.5).
- URL-sourced PDFs (chunkUrl stays HTML-only; a URL ending in `.pdf` is a non-goal this layer).
- Changes to embedding, vector storage, FTS schema, ranking.

## 2. Current-World Facts (verified by static read — the contracts we build on)

| Fact | Location | Consequence |
|---|---|---|
| `.pdf` extraction is a single branch: dynamic-import `unpdf`, `extractText(Uint8Array)` → `{ content, fileType: "pdf" }` | `src/engine.ts:729-742` (`extractSourceFileContent`) | The sidecar hooks in **exactly one place**; unpdf stays as fallback and for `engine: off` |
| Heavy parsers are loaded lazily (comment: "keep parser loading out of extension startup") | `src/engine.ts:731-733` | Sidecar must follow the same rule: dynamic import, zero startup cost, detection cached per process |
| `analyzeIndexableContent(content, filePath, fileType = detectFileType(filePath))` already accepts an explicit fileType; non-code types pass it to `extractSymbols`, but `chunkFile(content, filePath)` **re-detects by extension internally** | `src/indexer/chunker.ts:647-712` | Threading requires one additive override param on `chunkFile`; `engine.ts` call sites already pass `extracted.fileType` (single-file add: `engine.ts:1123`, update loop passes `extracted.fileType`) |
| `chunkMarkdown` hardcodes `"markdown"` in its `makeChunk` calls | `src/indexer/chunker.ts:664-668` (`pushMarkdownChunk`) | To keep `file_type: "pdf"` on converted chunks, `chunkMarkdown` needs an optional fileType param (default preserves behavior) |
| With `fileType: "pdf"` today, `chunkFile` routes `.pdf` to the `chunkText` fallback | `src/indexer/chunker.ts:690-700` | This is the exact defect Layer 2 replaces for sidecar-converted PDFs |
| Scan pipeline enforces `MAX_FILE_SIZE = 10 MB` and records skipped reasons (`oversized`, `extraction_failed`, …) | `src/indexer/chunker.ts:11,333`; `engine.ts:796-806` | Sidecar failures integrate with the existing skipped-scan stats; >10 MB PDFs never reach the sidecar |
| Knowledge dir resolution honors `PI_KNOWLEDGE_DIR` / `OMP_KNOWLEDGE_DIR` | `src/storage/sqlite.ts` (`resolveKnowledgeDir`), `docs/configuration.md:9-10` | Cache dir = `<knowledge-dir>/pdf-cache/`, same env plumbing |
| Env config convention is `PI_KNOWLEDGE_*` with documented default column | `docs/configuration.md` | New vars follow the same table + naming |
| `knowledge_update` re-extracts every scanned file on each run (mtime staleness is reported, extraction is unconditional) | `engine.ts:1345-1466` (scanning loop) | Without a cache, every update would re-run marker on every PDF — **cache is mandatory**, not optional |
| Layer 1 gives us, for free: `$$`/```math/`\begin{equation}` atomicity, canonical tokens (`x²`⇔`x^2`), frontmatter, heading breadcrumbs, `Formulas:`/`Title:` prefix lines | `docs/layer1-math-science-chunking-plan.md` §3–§4 | Sidecar markdown output is consumed **unchanged** — no new chunking logic in Layer 2 |
| FTS5/BM25/index schema untouched by Layer 1; `preTokenizeForFTS` symmetric | Layer 1 §2 | Converted PDF text gets identical search semantics |
| Repo commits are conventional (`feat:`/`fix:`/`docs:`/`chore:`), biome tabs, ESM `.ts` imports | `AGENTS.md` | Layer 2 follows the same |

## 3. Specification — NEW module `src/indexer/pdf-sidecar.ts`

All functions exported; deterministic where possible; subprocess I/O isolated behind one function for testability. **No npm deps.**

### 3.1 Configuration (`resolvePdfSidecarConfig(): PdfSidecarConfig`)

| Env var | Default | Values / meaning |
|---|---|---|
| `PI_KNOWLEDGE_PDF_ENGINE` | `auto` | `auto` (detect marker → docling → none) · `marker` · `docling` · `off` (current unpdf-only behavior, cache bypassed) |
| `PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS` | `120000` | Per-PDF conversion budget; expired ⇒ kill child, count as failure, fall back |
| `PI_KNOWLEDGE_PDF_SIDECAR_MARKER_CMD` | `marker_single` | Binary name or path for the marker adapter |
| `PI_KNOWLEDGE_PDF_SIDECAR_DOCLING_CMD` | `docling` | Binary name or path for the docling adapter |
| `PI_KNOWLEDGE_PDF_SIDECAR_CMD` | unset | **Escape hatch / test seam**: full argv template overriding built-in construction, e.g. `node /abs/fake-sidecar.mjs {input} {output_dir}`. Placeholders `{input}`, `{output_dir}` are substituted; split on whitespace; executed via `execFile(file, args)` — **never a shell**. When set, detection probes the template's FIRST token with `--help` |
| `PI_KNOWLEDGE_TEST_SIDECAR` | unset | Test-only gate for real-binary e2e (`marker`/`docling`); never read outside tests |

Config is resolved once per extraction call (cheap; no startup cost). Invalid values (`PI_KNOWLEDGE_PDF_ENGINE=bogus`) ⇒ warn once and behave as `auto` (fail-open).

### 3.2 Detection (`detectSidecar(config): Promise<"marker" | "docling" | "none">`)

- `engine: auto` → probe in order marker, docling; explicit engine → probe only that one.
- Probe = spawn `<cmd> --help` with a 10 s timeout; `ENOENT`/non-zero/timeouts ⇒ not available. Result cached in module state for the process lifetime (heavy CLI startup runs at most twice per process).
- Nothing installed ⇒ `none` ⇒ caller uses the unpdf fallback. **Detection never throws.**

### 3.3 Cache (`<knowledge-dir>/pdf-cache/`)

- Key: `sha256(pdf file bytes) + "\0" + engine + "\0" + adapterVersion` (adapterVersion = static string per adapter arg-shape in this module, bumped when args/output parsing change). Filename: `<key>.md` + `<key>.json` (`{ engine, converter, convertedAt, sourceBytes }`).
- Read before spawn; write after successful validation. Corrupt/missing sidecar files ⇒ cache miss (never an error).
- Cache lives under the knowledge dir ⇒ inherits `PI_KNOWLEDGE_DIR` overrides (module imports `resolveKnowledgeDir` from `../storage/sqlite.ts` — indexer→storage import precedent already exists in `chunker.ts`). Cache is content-addressed and shared across KBs; `knowledge_remove` does NOT delete it. Pruning: document `rm -rf <knowledge-dir>/pdf-cache` as the reset hatch. Unbounded growth is accepted and documented (one `.md` per distinct PDF; text is tiny vs. the PDF itself).

### 3.4 Conversion (`convertPdf(filePath, config, signal): Promise<{ markdown, converter }>`)

Adapter argv (built-in construction):

| Engine | Argv | Output reading |
|---|---|---|
| marker | `<cmd> <input> --output_dir <tmpdir> --output_format markdown` | the single `*.md` in `<tmpdir>` (largest if several); images subdir ignored |
| docling | `<cmd> <input> --to md --output <tmpdir>` | `<basename>.md` in `<tmpdir>` |

Rules (all **fail-open** — any violation ⇒ throw a typed `SidecarError`, caller falls back):
- Spawn via `execFile(file, args, { timeout, signal, maxBuffer: 8MB })` — argv array, **no shell**, the PDF path enters as one argv element (injection-proof). stdout/stderr beyond `maxBuffer` ⇒ child killed ⇒ `SidecarError("output_overflow")` (fail-open).
- Unique tmpdir per conversion (`mkdtemp`), cleaned up in a `finally`.
- Validation: output `.md` exists, decodes as UTF-8, length ≥ 50 chars after trim, contains no NUL byte. (Marker emits `-----` page breaks and image links — both fine; image links to a deleted tmpdir are dead but harmless — strip nothing, document.)
- Timeout/abort ⇒ kill child (execFile handles it), `SidecarError("timeout")`.
- On success: write cache, return `{ markdown, converter: "marker" | "docling" }`.
- Concurrency: a module-level mutex serializes conversions (sidecars are RAM/GPU-heavy; the engine's scanning loop is sequential anyway — the mutex is defense, not orchestration).

## 4. Specification — wiring into `engine.ts` + `chunker.ts`

### 4.1 `extractSourceFileContent` — `.pdf` branch (the only engine change to extraction)

```
if .pdf:
  config = resolvePdfSidecarConfig()
  if config.engine !== "off":
    try:
      side = await detectSidecar(config)          // cached
      if side !== "none":
        { markdown, converter } = await convertPdf(path, config, signal)
        return { content: markdown, fileType: "markdown", sourceFormat: "pdf", converter }
      // side === "none" → fall through to unpdf silently
    catch SidecarError:
      record skipped entry { reason: "pdf_sidecar_failed", path }  // visible in scan stats
      // fall through to unpdf
  // existing unpdf path unchanged (dynamic import, throwIfAborted rhythm preserved)
```

- `ExtractedSourceFile` gains optional `sourceFormat?: "pdf"` and `converter?: string`. All existing producers omit them.
- **Blast-radius note (deviation from Layer 1's no-engine guarantee, deliberate):** Layer 2's subject IS the extraction path, which lives in `engine.ts`. Allowed engine.ts surface: the `.pdf` branch, `ExtractedSourceFile`, one skipped-reason string. Nothing else in `engine.ts` may change (search, update loop, vectors, storage stay untouched — update loop benefits automatically because it calls `extractScannableFileContent`).

### 4.2 `chunkFile` + `analyzeIndexableContent` + `chunkMarkdown` threading

- `chunkFile(content, filePath, options?: { fileTypeOverride?: string })`: when `options.fileTypeOverride` is set and the detected type is NOT a code type, route using the override (`"markdown"` → `chunkMarkdown`, `"latex"` → `chunkLaTeX`); else behavior is byte-identical to today.
- `analyzeIndexableContent` passes its `fileType` param down: `chunkFile(content, filePath, { fileTypeOverride: analysisFileType })` — the param already flows in from both call sites (`engine.ts:1123`, update loop).
- `chunkMarkdown(content, filePath, fileType: string = "markdown", extraMetadata: ChunkMetadata = {})`: the type param replaces the hardcoded `"markdown"`; `extraMetadata` is merged into every chunk's metadata (Layer 2 passes `{ converter }`). Existing call sites unchanged.
- `buildContextPrefix` appends `Converter: <name>` when `metadata.converter` is set. **Ratified amendment to Layer 1 §4.5 (part of this spec): the guarded candidate-line order is Title → Tags → Aliases → Links → Labels → Formulas → Converter** — Converter is simply the last candidate inside the existing 1500-char guard loop; no separate rule.

### 4.3 Resulting data shape for a sidecar-converted PDF

- `chunk.file_path` = original `.pdf` path (provenance, staleness mtime, dedup).
- Symbols come free: `analyzeIndexableContent` receives `fileType: "markdown"` ⇒ `extractSymbols` already emits markdown heading symbols for the converted document — zero new symbol code in Layer 2.
- `chunk.file_type` = `"pdf"` → `filters.file_type: "pdf"` keeps finding ALL PDFs (sidecar or fallback); `documentationBoost` treats `pdf` like any non-markdown/latex type today (no boost change — ratified: no ranking changes in L2).
- `chunk.content` = markdown with `$$…$$` → Layer 1 canonicalization + protected regions + formulas metadata apply unchanged.
- `metadata_json` gains `converter` on sidecar chunks only.

## 5. Specification — tests

### 5.1 Unit (`test/unit/pdf-sidecar.test.ts`)

Fake sidecar: `test/fixtures/fake-sidecar.mjs` — a Node script reading `{input}`/`{output_dir}` from argv, writing a fixture markdown (with `$$E = mc^2$$`, a heading, a table) into the output dir; `--help` exits 0 (detection pass). A second fixture mode simulates failure (exit 3), a third sleeps >timeout.

| # | Criterion |
|---|---|
| U1 | `resolvePdfSidecarConfig` defaults; invalid engine ⇒ auto + warn-once; `off` bypasses everything |
| U2 | Detection: available cmd passes via `--help`; missing cmd ⇒ `none`, never throws; result cached (second probe spawns nothing — assert via counter file) |
| U3 | marker argv exact: `<cmd> <input> --output_dir <tmpdir> --output_format markdown` (capture via fake cmd writing its own argv to the output dir); docling argv exact; `PI_KNOWLEDGE_PDF_SIDECAR_CMD` template substitution exact |
| U4 | Cache: first convert spawns + writes `<key>.md/.json`; second convert with same bytes spawns nothing, returns identical markdown; different bytes ⇒ miss; engine bump in key ⇒ miss |
| U5 | Fail-open: exit≠0, missing `.md`, empty output, output with NUL, timeout ⇒ `SidecarError` with distinct causes; tmpdir always cleaned (assert dir gone) |
| U6 | Mutex: two concurrent `convertPdf` calls on a slow fake ⇒ serialized (overlapping-count file never exceeds 1) |

### 5.2 Unit — threading (`test/unit/chunker.test.ts` additions)

| # | Criterion |
|---|---|
| T1 | `chunkFile(md, "x.pdf", { fileTypeOverride: "markdown" })` → `chunkMarkdown`-shaped chunks (headings/breadcrumbs) with `file_type: "pdf"` and `metadata.converter` present; `Converter:` line in `buildChunkEmbeddingText` |
| T2 | `chunkFile(md, "x.pdf")` without override ⇒ byte-identical to today's `chunkText` fallback (existing tests stay green) |
| T3 | `chunkMarkdown` default params reproduce existing behavior exactly (all Layer 1 tests unchanged) |
| T4 | Override `"latex"` on a `.pdf` routes to `chunkLaTeX` (mechanism proof) |

### 5.3 Engine-level e2e (`test/unit/pdf-sidecar.e2e.test.ts` or inside engine.test.ts pattern)

| # | Criterion |
|---|---|
| E1 | Temp dir with `paper.pdf` (committed fixture, ~1-2 KB valid PDF with text layer) + `PI_KNOWLEDGE_PDF_SIDECAR_CMD` pointing at the fake script + `PI_KNOWLEDGE_PDF_ENGINE=marker`: `engine.add` succeeds; `knowledge_search "mc²"` (fast mode) finds the chunk whose provenance file is `paper.pdf`; `filters.file_type=pdf` returns it; `metadata_json.converter === "marker"` |
| E2 | Same setup with failing fake ⇒ add still succeeds (unpdf fallback content indexed), skipped stats record `pdf_sidecar_failed` |
| E3 | `PI_KNOWLEDGE_PDF_ENGINE=off` ⇒ behavior byte-identical to today's unpdf path (existing PDF tests, if any, stay green) |
| E4 | Update-after-add with cache present ⇒ fake sidecar spawn counter unchanged (0 new conversions) |
| E5 | Real-binary e2e, gated: runs only when `PI_KNOWLEDGE_TEST_SIDECAR=marker` and `marker_single --help` succeeds — converts the fixture, asserts output contains a math fence or `$$` and a heading. Otherwise `it.skip` |

Fixture PDF: committed minimal single-page PDF with text layer containing `E = mc^2`, a `## Section`-style line, and one paragraph; generated once (any toolchain), stored at `test/fixtures/fixture-paper.pdf`, content asserted only via the fake sidecar (the real-binary path asserts loosely — parser output varies by version).

## 6. Task Breakdown (execution order, each independently verifiable & committable)

| # | Task | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| T1 | Sidecar module: config, detection, adapters, cache, mutex, `SidecarError` | NEW `src/indexer/pdf-sidecar.ts`, NEW `test/unit/pdf-sidecar.test.ts`, NEW `test/fixtures/fake-sidecar.mjs` | U1–U6 pass; `npm run check` + `typecheck` clean; no new entries in `package.json` dependencies | — |
| T2 | Engine wiring: `.pdf` branch sidecar-first with unpdf fallback + skipped reason; `ExtractedSourceFile` extension | `src/engine.ts` | §4.1 flow exact; failure path records `pdf_sidecar_failed`; `engine=off` path identical to today; no other `engine.ts` diffs | T1 |
| T3 | Threading: `chunkFile` override, `analyzeIndexableContent` pass-through, `chunkMarkdown` params, `Converter:` prefix line | `src/indexer/chunker.ts` | T1–T4 pass; ALL existing chunker tests unchanged; blast radius = signature additions only | T1 |
| T4 | Engine-level e2e + fixture PDF | NEW `test/fixtures/fixture-paper.pdf`, e2e test file | E1–E4 pass | T2, T3 |
| T5 | Real-binary gated e2e | e2e test file | E5: skipped by default; passes locally when marker installed and gate env set | T4 |
| T6 | Docs: configuration.md (5 new env rows + cache section + install hints `pip install marker-pdf` / `pip install docling`), README paragraph, CHANGELOG, ADR-021 (sidecar architecture, marker-first rationale + benchmark citation, fail-open, cache, no-shell spawn security, weights-license note), known-pitfalls (first-run model download, VRAM, timeout tuning), AGENTS.md contract line ("PDF sidecar is optional and fail-open: marker/docling when available and configured, unpdf fallback otherwise; conversions are cached by content hash; converted PDFs keep file_type pdf and record their converter") | docs + AGENTS.md + CHANGELOG + README | content review vs this spec; `check` clean | T1–T5 |

### Commit plan
1. `feat: add pdf sidecar module with marker/docling adapters and cache` (T1)
2. `feat: route pdf extraction through optional sidecar with markdown threading` (T2–T4)
3. `test: real-binary sidecar e2e gate` (T5, if separable — else fold into 2)
4. `docs: document pdf sidecar configuration and contracts` (T6)

## 7. Verification Protocol

**Hard gates (identical to Layer 1 §7):** `npm run check` zero warnings · `npm run typecheck` clean · `npx vitest --run test/unit/ --testTimeout=15000` ALL pass (289 existing + new) · `node --experimental-strip-types -e "import('./index.ts')"` smoke · diff review: only the files in §1 change (`package.json` untouched).

**Functional acceptance:** every criterion in §5 maps 1:1 to a named test; the implementation report lists criterion → test → pass/fail.

**Dogfood (post-merge, recorded, not a gate):** `pip install marker-pdf` on this machine (RTX 5060, balanced mode), `knowledge_add` one real arXiv PDF (e.g. the SSEmb paper), then `knowledge_search` with a unicode-math query against a formula printed in that PDF; verify `file_type: pdf` chunk, `Converter: marker` line, and conversion time (first run includes model download; second `knowledge_update` must show near-zero PDF re-conversion time from cache).

**Explicitly NOT claimed by Layer 2:** OCR quality on scanned (image-only) PDFs; formula-perfect extraction for every layout (benchmark: no parser is); DOCX/URL-sidecar paths; docling feature parity beyond the adapter; Layer 3 structural formula search.

## 8. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Sidecar absent for most users ⇒ dead code path complexity | Medium | Fail-open design; `auto` detection; unpdf path byte-identical (E3); zero startup cost |
| Marker/docling CLI arg drift across versions | Medium | Adapters pin minimal arg surface; `PI_KNOWLEDGE_PDF_SIDECAR_CMD` escape hatch; E5 gates against real binary; adapterVersion busts cache when args change |
| First marker run downloads GB-scale models; slow conversions block indexing | High (first run) | Documented in known-pitfalls; 120 s default timeout tunable; timeout ⇒ unpdf fallback rather than failed add; mutex prevents parallel resource explosion |
| Subprocess injection via crafted paths | Low | `execFile` argv array, no shell, no string interpolation; path enters as a single argv element |
| Cache poisoning / stale conversions | Low | Key = content bytes + engine + adapterVersion; corrupt cache = miss (never error); documented reset hatch |
| `file_type: "pdf"` chunks now contain markdown (surprise for filter users) | Low | Documented in README/ADR-021; `converter` metadata + `Converter:` prefix make provenance visible |
| Engine.ts regression (Layer 1 kept it pristine) | Medium | Scope fenced to §4.1 (`.pdf` branch + type + skipped reason); diff review gate; E2/E3 prove fallback paths |
| Image links in markdown point to deleted tmpdirs | Certain, harmless | Documented: images are not extracted/stored in L2; dead links are inert text |
| Model weights license (marker weights: OpenRAIL-M) | Low | We never bundle or serve weights; user installs per marker's terms — documented in ADR-021 |

## 9. Effort Estimate

T1 ≈ 260 lines module + 280 tests. T2 ≈ 45 lines + 80 tests. T3 ≈ 40 lines + 90 tests. T4 ≈ 130 lines e2e + fixture. T5 ≈ 40 lines. T6 docs. Total ≈ 900 lines across 3-4 commits. No schema migrations; **no new npm dependencies** (sidecars are user-installed external binaries).
