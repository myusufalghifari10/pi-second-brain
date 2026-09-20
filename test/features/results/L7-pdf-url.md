# L7-pdf-url — Feature Test Results (G1–G6)

Lane: L7-pdf-url · Engine: real built `dist/src/engine.js` · Node v26.8.1
Isolated stores: `/tmp/fx-L7-pdf-url/store-*` (fresh per probe, `PI_KNOWLEDGE_DIR` env)
Models: offline via `PI_KNOWLEDGE_OFFLINE=true` + `PI_KNOWLEDGE_MODEL_CACHE_DIR=~/.pi/knowledge/models`
Probe scripts (kept): `/tmp/fx-L7-pdf-url/probe-G*.mjs`, `harness.mjs`, `fake-tesseract.mjs`, logs in `/tmp/fx-L7-pdf-url/logs/`
Sidecar availability: `which marker docling` → **not installed** (both "no marker/docling in PATH"), so G1's unpdf fail-open is the default real path; G2/G6 use fake converters via env cmd templates. No `src/`, `test/`, or fixture files modified (verified via `git status`).

## Verdicts

```
G1 | PASS | add(test/fixtures/fixture-paper.pdf, no marker/docling): status=ready, 1 chunk file_type=pdf with EMPTY metadata {} (no converter => pure unpdf path, sidecar detect returned "none"); hybrid search "Mass-energy equivalence rest mass of a particle" -> 1 hit score 0.574, content "E = mc^2\n## Section One\nMass-energy equivalence states that the rest mass of a p..." (probe-G1.mjs, logs/G1.log)
G2 | PASS | PI_KNOWLEDGE_PDF_SIDECAR_CMD="node test/fixtures/fake-sidecar.mjs {input} {output_dir}": add ready, chunk metadata {"heading":"## Section One","breadcrumb":"Relativity Primer > Section One","converter":"marker"} -> converter lands on chunks; file_type stays "pdf" (converted-PDF contract); content is SIDECAAR markdown "$$E = mc^2$$" not unpdf text; store/pdf-cache/<sha>.md+.json written; hybrid search hits the sidecar chunk score 0.574. (probe-G2.mjs, logs/G2.log; real marker/docling SKIP per matrix note - binaries absent, fake-sidecar cmd-template path is the tested evidence)
G3 | PASS | add(11,534,336-byte junk .pdf) threw exactly: "File exceeds the 10 MB ingestion cap: /tmp/fx-L7-pdf-url/store-g3-800446-1/junk-huge.pdf — split it or add its directory instead"; engine.list() after = [] (no KB row left, no unbounded read). (probe-G3.mjs, logs/G3.log)
G4 | PASS | add("https://example.com") over real network: status=ready source_type=url source_path=https://example.com, 1 chunk file_path=https://example.com file_type=text, HTML stripped, content "Example Domain Example Domain This domain is for use in documentation examples without needing permi..."; hybrid search "Example Domain illustrative examples in documents" -> 1 hit score 1.307. (probe-G4.mjs, logs/G4.log)
G5 | PASS | local http server (127.0.0.1:44795): (A) text/plain 10,486,760-byte payload -> add threw "Fetch failed: response exceeds the 10485760 byte URL ingest cap"; (B) application/pdf (fixture bytes) -> threw "Fetch failed: unsupported content-type \"application/pdf\" — only text/*, xhtml, and JSON URLs are ingested"; engine.list() = [] after BOTH failures (KB not corrupted). (probe-G5.mjs, logs/G5.log)
G6 | PASS | sidecar emits image block (FAKE_SIDECAR_IMAGES=1x1 png) + PI_KNOWLEDGE_OCR_ENGINE=tesseract (warns "invalid ... behaving as auto", OCR engaged) + PI_KNOWLEDGE_OCR_CMD=fake tesseract: image persisted to store/image-store/6b7fa434*.png; exactly ONE "*OCR:* Flux capacitor readout shows one point twenty-one gigawatts on panel seven. KRAKEN OCR CANARY segment." paragraph (alt-captioned figure-1 correctly skipped OCR); hybrid search "flux capacitor readout gigawatts panel seven" -> hit chunk containing "*OCR:*". CONTROL (probe-G6b): PI_KNOWLEDGE_OCR_ENGINE=off -> images still persist, 0 *OCR:* occurrences, fake text absent -> caption provably originates from the OCR leg. (probe-G6.mjs, probe-G6b-control.mjs, logs/G6.log, logs/G6b.log)
```

6 PASS / 0 FAIL / 0 SKIP (real marker/docling binaries absent — noted inside G2; the cmd-template fake-sidecar path the matrix specifies for G2/G6 was fully exercised instead)

## Environment & commands

- `node probe-G<N>.mjs` per feature from `/tmp/fx-L7-pdf-url/` (Node v26.8.1, ESM imports of `/home/yusuf/pi-knowledge/dist/src/engine.js` + `dist/src/storage/sqlite.js` for chunk-metadata assertions).
- Each probe creates a fresh `PI_KNOWLEDGE_DIR` store under `/tmp/fx-L7-pdf-url/` and calls `engine.dispose({disposeModels:true})` at exit.
- G5 runs its own `node:http` server on 127.0.0.1 (random port) — no external network; G4 is the only external fetch (feature-under-test, authorized).
- `which marker docling` → not found (exit 2) — recorded before testing.

## Observations (non-blocking)

1. **`PI_KNOWLEDGE_OCR_ENGINE` accepts only `auto|off`** (src/indexer/pdf-sidecar.ts). The matrix's literal value `tesseract` triggers `pi-knowledge: invalid PI_KNOWLEDGE_OCR_ENGINE "tesseract"; behaving as "auto"` — OCR still engages (auto) so G6 passes either way. Users copying "PI_KNOWLEDGE_OCR_ENGINE=tesseract" from docs will see a warning; the correct off-switch is `off`.
2. **Sidecar markdown headings become breadcrumbs, not chunk content**: the fake sidecar's `# Relativity Primer` heading lands in `metadata.breadcrumb` ("Relativity Primer > Section One"); chunk content starts at `## Section One`. First G2 run FAILED on my own over-strict assertion (`content.includes("Relativity Primer")`) — probe-harness bug, fixed by asserting breadcrumb + sidecar-only `$$E = mc^2$$` content. Not an engine defect.
3. **fail-open chain verified end-to-end**: G1 (sidecar absent → unpdf) and G6b (OCR off → conversion succeeds, caption simply absent, images still persisted) both confirm the "every failure is fail-open" contract without a single hard add failure.
4. example.com live page text differs from the classic RFC text ("for use in documentation examples without needing permission") — fetch is genuinely live; assertions keyed on "Example Domain" only.

## Failure diagnostics (RED-phase artifacts)

- G2 first run: 2 probe assertion FAILs ("content is the SIDECAR markdown", "search hits sidecar markdown") — cause: harness expected the sidecar's H1 text inside chunk content; engine correctly routes it to breadcrumb metadata. Failure class: harness assertion bug (not behavior mismatch, not env). Re-run after probe fix: PASS. Logs preserved: first run overwritten by fixed re-run in logs/G2.log; the failing check lines are quoted in Observation 2.
