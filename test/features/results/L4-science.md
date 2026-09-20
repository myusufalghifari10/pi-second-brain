# L4-science — D1..D6 functional test results

Lane: L4-science · Tester: tester · Store: isolated `PI_KNOWLEDGE_DIR=/tmp/fx-L4-science/stores/*`
Engine: REAL built engine `/home/yusuf/pi-knowledge/dist/src/engine.js` (EMSM ESM import, node v26.8.1)
Offline: `PI_KNOWLEDGE_OFFLINE=true`, `PI_KNOWLEDGE_MODEL_CACHE_DIR=/home/yusuf/.pi/knowledge/models` (cached models, no network)
Probes kept at `/tmp/fx-L4-science/probe-d*.mjs` + fixtures under `/tmp/fx-L4-science/fixtures/`.

## Verdicts

```
FEAT-ID | PASS/FAIL/SKIP | evidence
D1 | PASS | probe-d1x.mjs: hybrid query "photosynthesis chloroplast overview $F = m a$" on 92-chunk KB → `hit file=d1x-physics.md reason=formula score=1.040 injected=true` (formula leg injected the absent $$/F = m a/$$ chunk with match_reason "formula"). Formula-bearing hybrid query on 3-chunk KB (probe-d1.mjs) also shows the boost leg: E=mc² chunk retrieved at rank 1, score 1.546 (base+FORMULA_BOOST). Matrix-literal prose query "mass energy equivalence" (no formula in query) correctly retrieves the $E=mc^2$ chunk (rank 1-2 hits, reason=hybrid, no injection — query side extracts zero formulas by design).
D2 | PASS | probe-d2c.mjs (chem doc with $$H2O$$ + $$C6H12O6$$ display math per lane brief): hybrid "H₂O" → top=d2c-chem.md reason=formula score=1.040 (subscript query injected); "water formula" → top=d2c-chem.md reason=hybrid score=1.196; "C₆H₁₂O₆" → reason=formula; "C6H12O6" → reason=hybrid score=1.546 (retrieved+boost); fast "H₂O" → reason=formula. normalizeFormula symmetric: "H2O"≡"H₂O" → "H2 O". Caveat: prose-only chem doc (no math spans) does NOT answer H₂O — prose molecular formulas intentionally not indexed (contract) and subscript tokenizes to "sub2" vs prose "H 2 O" (single-char tokens dropped): 0 results (probe-d2.mjs).
D3 | FAIL | observed: query "kilometers" (hybrid AND fast) returns ONLY d3-marathon.md ("3 kilometers"); the "5 km"-only segment (d3-km.md) is NOT retrieved (0 hits, both modes). expected per matrix: unit variants normalize so "kilometers" matches the "km" doc segment. Root evidence: no word-variant normalization exists — preTokenizeForFTS("...5 km...") = "...5 km..." vs "...kilometers..." stay distinct tokens; grep finds no "kilometer" in src/. The implemented units contract is different: cdot rewrite N·m ≡ N m (verified byte-identical token streams: preTokenizeForFTS("torque of 5 N·m at the shaft") === preTokenizeForFTS("torque of 5 N m at the shaft")); bare-unit queries ("N m","N·m","Nm") return 0 results because single-char tokens are dropped by the shared length>1 tokenizer rule (probe-d3b.mjs).
D4 | PASS | probe-d4.mjs: hybrid "x² + y² = r²" → top=d4-math.md score=1.196; hybrid "x^2 + y^2 = r^2" → top=d4-math.md score=1.196 (identical score ⇒ symmetric canonicalization); fast "x²" → top=d4-math.md reason=bm25 (pure-lexical superscript match, no vector leg). Distractor d4-algebra.md never returned.
D5 | PASS | probe-d5a2.mjs (a.tex \label{eq:mass-energy} + b.tex \ref{eq:mass-energy} in ONE directory KB): hybrid query retrieving B's chunk → depends_on=[{"label":"eq:mass-energy","chunk_id":"52fa1058-…","pinned":true}] on b.tex chunk (A's chunk id). Caveat A: same files added as TWO separate KBs → edge recorded but resolved_chunk_id=null (label graph is per-KB, unresolved never guessed — by design, not a bug). Caveat B (matrix-literal wikilink): B.md containing [[A]] gets metadata links:["A"] only; depends_on stays null (probe-d5.mjs) — wikilinks are not part of the \label/\ref label-graph contract (AGENTS.md L4 scope).
D6 | PASS | probe-d6.mjs run twice on same store, adaptive mode: env PI_KNOWLEDGE_ADAPTIVE_CONTEXT_LINES=10 → tuning.adaptive_context_lines=10, seed span lines 248-497, 3 source chunks, distant "alpha" section (line 3) NOT in content; env=500 → tuning.adaptive_context_lines=500, span lines 3-492, 4 source chunks, alpha text IS pulled into content (content_length capped at adaptive_max_context_chars=10000). Env var honored and context expands with neighboring lines.
```

Summary: **5 PASS / 1 FAIL / 0 SKIP** (D3 fails as worded; implemented units contract is the N·m ≡ N m cdot rewrite, which itself verifies clean).

## Commands (all run in this session)

- `node smoke.mjs` → ADD_OK smoke chunks=1 status=ready / SEARCH_OK results=1 / SMOKE_DONE (harness green)
- `node probe-d1.mjs` → CHECK1 2 hybrid hits incl. E=mc² chunk; CHECK2 rank-1 physics chunk score=1.546 (boost); injection=0 in tiny KB
- `node probe-d1x.mjs` → `B(hybrid, F=ma) file=d1x-physics.md reason=formula score=1.040 injected=true` / VERDICT-B formula_injection=PASS
- `node probe-d2.mjs` → "H₂O" 0 results hybrid AND fast (prose-only doc); "water formula" hit
- `node probe-d2b.mjs` → inline `$H2O$` does NOT index (chunk metadata {}); `C6H12O6` query hit
- `node probe-d2c.mjs` → all 5 query/mode combinations hit d2c-chem.md (see D2 evidence)
- `node probe-d3.mjs` → "kilometers" hits only d3-marathon.md; km_variant_match=FAIL both modes
- `node probe-d3b.mjs` → "N m"/"N·m"/"Nm" queries 0 results; token-stream equality verified via preTokenizeForFTS
- `node probe-d4.mjs` → 3/3 math_doc_hit=PASS
- `node probe-d5.mjs` → cross-KB latex edge unresolved (null) + wikilink depends_on=null (caveats)
- `node probe-d5a2.mjs` → VERDICT-D5 latex label-graph depends_on=PASS
- `env PI_KNOWLEDGE_ADAPTIVE_CONTEXT_LINES=10 node probe-d6.mjs` then `=500` → tuning 10/500, span 248-497 → 3-492, alpha excluded→included

## Residual risks / notes for fix worker & reviewer

1. D3 FAIL scope: implementing kilometers↔km would be NEW behavior (synonym expansion at query time or index-time token folding); current `units.ts` only drops cdot between UNIT_TOKENS. Decide whether the matrix wording or the implementation is the contract of record.
2. D2 caveat: docs must carry display math (`$$…$$`) for chem/formula retrieval; inline `$…$` in markdown docs does not produce `formulas` metadata (only display math segments are extracted); prose molecular formulas intentionally not indexed. If users are told to "just write H2O in prose", subscript queries will miss.
3. D1 note: injection requires the formula chunk to fall outside the retrieval candidate window; with e5 hybrid on small corpora the formula text itself retrieves the chunk (boost leg instead). The boost leg has NO observable marker in results (match_reason stays "hybrid", no formula flag) — formula evidence is only visible via `match_reason:"formula"` on injected chunks.
4. D6 observation: `buildAdaptiveContext` can truncate away the SEED chunk's own text when distant filler chunks consume `adaptiveMaxContextChars` (run 2: content_includes_gamma=false at the 10 000-char cap). Feature flag honored, but seed-loss under cap is a quality quirk worth a look.
5. D5 caveat: label graph resolution is per-KB; cross-KB `\ref` records unresolved edges by design ("never guessed"). Matrix's `[[A]]` wikilink wording is outside the implemented label-graph contract.
