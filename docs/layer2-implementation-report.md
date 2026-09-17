# Layer 2 (PDF Sidecar) Implementation Report — T2–T4 Completion

Date: 2026-09-18 · Branch: `main` · Base: `01313d4` · Commit: `88a1b12` (`feat: route pdf extraction through optional sidecar with markdown threading`)

Third worker on this lane. T1 (`src/indexer/pdf-sidecar.ts` + `test/unit/pdf-sidecar.test.ts` + `test/fixtures/fake-sidecar.mjs`) was already committed (`19d976e`) together with the Amendment B search fix (`01313d4`, raw query to `searchBM25`). This worker adopted the uncommitted T2–T4 draft, verified it against the amended spec (`docs/layer2-pdf-sidecar-plan.md`, Amendments A & B ratified 2026-09-18), made two conformance repairs, added one missing test, ran the full gate trio, and committed.

## Adopted predecessor draft (with repairs)

The draft was largely complete and already green on `check`/`typecheck`; the two transient TS errors previously observed (engine.ts TS2345 possibly-undefined `skipped`; e2e TS18046 `chunk.file_path`) were already fixed in the draft. Repairs made by this worker:

1. **`src/indexer/chunker.ts` — `chunkFile` override guard aligned to normative §4.2 + Amendment B.** The draft guarded with `!isCodeFileType(detectedFileType)`, which still let a *non-routing* override (`"text"`, `"pdf"`) passed directly to `chunkFile` demote extension-detected markdown routing — exactly the regression class Amendment B forbids (it was only guarded at the `analyzeIndexableContent` forwarding layer). Now the override applies iff it names a routing type (`markdown` | `latex`) **and** differs from extension detection, per §4.2 verbatim. Absent/non-routing override ⇒ byte-identical behavior (extraMetadata always forwarded).
2. **`src/engine.ts` — hoisted `extractPdfSourceFileContent` to module scope.** The draft declared it as a nested function after the non-PDF early-return, leaving the sidecar comment stranded in the non-PDF flow (misleading placement; per-call re-allocation). Behavior-neutral restructure; comment now sits on the function it describes.
3. **`test/unit/chunker.test.ts` — added the missing Amendment B guard test** ("Amendment B: a non-routing extractor label does not demote extension-detected markdown routing") covering both the `analyzeIndexableContent` forwarding layer and the direct `chunkFile` layer.

CHANGELOG inherited from the predecessor verified complete: two `### Added` bullets (sidecar + cache) and the `### Fixed` bullet for the `01313d4` double-normalization fix.

## Criterion → test → result matrix (spec §5)

Verification level: unit/e2e in-repo (vitest), no external fixtures required. E5 real-binary path never executed on this machine (`marker_single`/`docling` absent; nothing installed).

### §5.1 U1–U6 (T1, committed `19d976e`) — file `test/unit/pdf-sidecar.test.ts`

| Criterion | Test name(s) | Result |
|---|---|---|
| U1 config defaults / invalid⇒auto+warn-once / off bypass | `U1 resolvePdfSidecarConfig > defaults…`, `reads all env overrides`, `invalid engine behaves as auto and warns once`, `off is preserved verbatim…`, `invalid timeout behaves as the default` | pass |
| U2 detection probe / missing⇒none never throws / cached | `U2 detectSidecar > probes the template command via --help and caches the result (no second spawn)`, `missing command resolves to none and never throws`, `explicit engine probes only its own command` | pass |
| U3 marker argv exact / docling argv exact / CMD template exact | `U3 adapter argv > marker built-in argv is exact and the tmpdir is cleaned up`, `docling built-in argv is exact`, `PI_KNOWLEDGE_PDF_SIDECAR_CMD template substitution is exact` | pass |
| U4 cache hit/miss by bytes+engine | `U4 conversion cache > caches by content bytes + engine: hits spawn nothing, new bytes/engine miss` | pass |
| U5 fail-open typed causes + tmpdir cleanup | `U5 fail-open failures > non-zero exit`, `missing markdown output`, `empty output`, `output containing a NUL byte`, `timeout kills the child and cleans the tmpdir` | pass |
| U6 conversion mutex serialization | `U6 conversion mutex > serializes two concurrent slow conversions (overlap never exceeds 1)` | pass |

### §5.2 T1–T4 (T3 threading) — file `test/unit/chunker.test.ts`, describe `chunkFile pdf sidecar threading`

| Criterion | Test name | Result |
|---|---|---|
| T1 markdown override on `.pdf`: `file_type: "pdf"`, `metadata.converter`, `Converter:` prefix; no provenance without extraMetadata (negative clause verified at e2e level by E2/E3 — reviewer note, annotated by supervisor) | `T1: markdown override on a .pdf keeps file_type pdf, threads converter metadata, and renders the Converter prefix` | pass |
| T2 no override ⇒ byte-identical to `chunkText` fallback | `T2: chunkFile on a .pdf without override is byte-identical to the chunkText fallback` | pass |
| T3 `chunkMarkdown` default params reproduce existing behavior | `T3: chunkMarkdown default params reproduce existing behavior exactly` | pass |
| T4 `latex` override on `.pdf` routes to `chunkLaTeX` | `T4: latex override on a .pdf routes to chunkLaTeX (mechanism proof)` | pass |
| (extra) Amendment B non-routing override never demotes routing (both layers) | `Amendment B: a non-routing extractor label does not demote extension-detected markdown routing` | pass |

All pre-existing chunker tests (Layer 1 math/table protection, context guard, walkDir, etc.) unchanged and green.

### §5.3 E1–E5 (T4+T5) — file `test/unit/pdf-sidecar.e2e.test.ts` (engine-level, committed fixture + fake sidecar)

| Criterion | Test name | Result |
|---|---|---|
| E1 sidecar add: `mc²` finds `paper.pdf` chunk via canonicalization; `file_type=pdf` filter hits; `converter === "marker"` | `E1: sidecar add makes the fixture searchable across notation with pdf provenance and converter metadata` | pass |
| E2 failing sidecar ⇒ unpdf fallback indexed, `pdf_sidecar_failed` in progress/stats, no converter metadata | `E2: failing sidecar falls back to unpdf and records pdf_sidecar_failed in scan stats` | pass |
| E3 `PI_KNOWLEDGE_PDF_ENGINE=off` ⇒ unpdf path, sidecar never invoked (spawn counter absent), no converter metadata | `E3: PI_KNOWLEDGE_PDF_ENGINE=off is byte-identical to today's unpdf path (sidecar never invoked)` | pass |
| E4 update-after-add ⇒ 0 new conversions (cache), `added: 0`, `unchanged > 0` | `E4: update after add hits the conversion cache (zero new sidecar spawns)` | pass |
| E5 real `marker_single` e2e, gated on `PI_KNOWLEDGE_TEST_SIDECAR=marker` **and** `marker_single --help` success | `E5: real marker_single converts the fixture to math-aware markdown` | **skipped** (gate env unset; `marker_single` not installed — verified via `which`; nothing installed per instructions) |

E5 is small (~10 lines) and lives inside the e2e file, so it was folded into commit 1 per the commit plan ("else fold into 2").

## Gates (full tails)

- `npm run check` — `Checked 59 files in 89ms. No fixes applied.` (zero warnings)
- `npm run typecheck` — clean, no output
- `npx vitest --run test/unit/ --testTimeout=15000` — `Test Files  22 passed (22)` · `Tests  316 passed | 1 skipped (317)` (the 1 skip = E5)
- `node --experimental-strip-types -e "import('./index.ts')"` — exit 0 (spec §7 smoke)
- `npm pack --dry-run` / Pi dogfood — **not run** (not release time; T6 docs lane still open, owned by the docs worker)

## Scope discipline

Changed/committed (explicit paths, no `git add .`/`-A`): `src/engine.ts`, `src/indexer/chunker.ts`, `test/unit/chunker.test.ts`, `test/unit/pdf-sidecar.e2e.test.ts` (new), `test/fixtures/fixture-paper.pdf` (new), `CHANGELOG.md`.

Untouched as required: `docs/**` (incl. the amended plan — read-only normative source), `README.md`, `AGENTS.md`, `package.json`, `package-lock.json`, `src/storage/*`, `src/embedding/*`, `src/search/**`, `src/indexer/symbols.ts`, `src/indexer/pdf-sidecar.ts` (committed T1). The pre-existing modifications to `package.json`, `docs/*`, `README.md`, `AGENTS.md` (docs worker + orchestrator amendments) were **never staged** and remain in the working tree. `DOCS-WORKER-SUMMARY.md` and `STANDDOWN-NOTE.md` preserved.

engine.ts diff surface stayed inside §4.1: `.pdf` branch, `ExtractedSourceFile` extension (`sourceFormat`/`converter`), `pdf_sidecar_failed` skipped reason, `sidecarMetadata()` carriage + Amendment A conditional 4th argument at the three `analyzeIndexableContent` call sites (single-file add wrapper, directory-scan update loop, single-source update), and the mechanical `skipped`-stats plumbing so the new skipped reason reaches scan stats. Amendment B search args were already committed in `01313d4`.

## Residual risks / notes

- E5 has never executed end-to-end on this machine; it is env-gated and will exercise real marker behavior only where `marker_single` exists. Adapter arg drift against a live marker version remains unverified (spec §8 accepts this; escape hatch: `PI_KNOWLEDGE_PDF_SIDECAR_CMD`).
- Fixture PDF (712 bytes, 1 page, text layer with `E = mc^2` + section heading) is asserted only via the fake sidecar; real-binary assertions are loose by design.
- §7's `npm pack --dry-run` and Pi dogfood were not run — they belong to the release/T6 stage, not this lane.

---

## Review round (2026-09-18, supervisor-orchestrated)

Two fresh read-only reviewers verified this implementation (fidelity vs amended spec; correctness/security/regression). **Verdict: 0 blockers, 15 notes total.**

Dispositions (supervisor as spec-owner):

| Note | Disposition |
|---|---|
| `readCache` served hits without re-validating (NUL/min-length) | **Fixed** in `546ec1e` — hit re-validated like fresh output; U4b test added |
| `writeCache` non-atomic (no tmp+rename) | **Fixed** in `546ec1e` — tmp+rename md-first/json-last, temp residue cleaned; assertion added |
| Skipped-sample abs vs rel path inconsistency | **Skipped** — fixing requires threading `relPath` through the extraction call chain (refactor out of scope); documented residual risk |
| U1 floating un-awaited expect | **Fixed** in `546ec1e` — awaited, async callback |
| E5 temp-dir leak on gated path | **Fixed** in `546ec1e` — `finally` cleanup |
| Cache key = nested hash of resolved converter vs spec's flat formula | **Ratified** — deterministic, collision-equivalent, U4 covers all bust cases; plan §3.3 annotated |
| ADR-021 says key uses raw engine config value | **Docs corrected** — now says resolved converter |
| Spec fact table cited non-existent `resolveKnowledgeDir` | **Spec corrected** — `getDefaultKnowledgeDir` |
| T1 negative-clause (no provenance without extraMetadata) covered at e2e level only | **Annotated** in matrix — covered by E2/E3 |
| e2e-with-model file in `test/unit/` vs repo convention | **Accepted** — spec §5.3 sanctioned, model cache dir pinned |
| SIGTERM-only kill (no SIGKILL escalation) | **Documented** in `docs/known-pitfalls.md` |
| `maxBuffer` 8 MB combined stdout+stderr overflow on huge PDFs | **Documented** in `docs/known-pitfalls.md` |
| Dead enum member `engine_off` | **No-op** — harmless |
| E5 never executed (marker not installed) | **Accepted per spec §8** — env-gated, escape hatch `PI_KNOWLEDGE_PDF_SIDECAR_CMD` |

Hardening commit: `546ec1e` `fix: harden pdf sidecar cache integrity and test hygiene` (3 files, +78/−15).

Final gates (supervisor-run, at `546ec1e` + docs): `npm run check` clean (59 files) · `npm run typecheck` clean · `npx vitest --run test/unit/ --testTimeout=15000` → **317 passed + 1 skipped (E5 env-gated)**.
