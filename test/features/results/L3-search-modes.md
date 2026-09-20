# L3-search-modes — functional test report (features C1–C8)

Lane: L3-search-modes · Engine: `/home/yusuf/pi-knowledge/dist/src/engine.js` (real built dist)
Store: isolated `PI_KNOWLEDGE_DIR=/tmp/fx-L3-search-modes/store` · Models: offline cache via
`PI_KNOWLEDGE_MODEL_CACHE_DIR=/home/yusuf/.pi/knowledge/models` + `PI_KNOWLEDGE_OFFLINE=true`
Probes kept at `/tmp/fx-L3-search-modes/` (`setup.mjs`, `probe-c*.mjs`, `run.sh`).
Corpus: kb-a = 21 generated md docs (21 chunks), kb-b = 1 doc (1 chunk) sharing harbor/anchor vocabulary.
All runs below reproduced twice (initial + full clean re-run from fresh store).

## Verdicts

C1 | PASS | `run.sh c1`: mode fast "qubit superposition" → TOTAL 1, TOP 01-quantum.md score 5.073 match_reason "bm25", WARNINGS null; `run.sh c1noemb` with `PI_KNOWLEDGE_EMBEDDING=openai:*` + unreachable base URL `http://127.0.0.1:9/v1`: FAST_RESULTS 1, FAST_WARNING null, FAST_TOP_MATCH 01-quantum.md bm25 (fast needs no embedding; hybrid surfaces the embedding error instead)

C2 | PASS | `run.sh c2`: hybrid "anchored harbor network" diversity:off → 14 results, all match_reason "hybrid", strictly score-descending [1.376…0.201]; light paraphrase "cats resting habits in daylight" → hybrid TOP 02-feline.md 1.196 "hybrid" while fast on same query = 0 results (semantic leg rescues the hit); zero-overlap paraphrase "why do cats sleep so much" → semantic (pure vector leg) TOP 02-feline.md 0.885 vs next 0.814. Caveat (by-design): fully zero-overlap paraphrase returns 0 in hybrid (hasEnoughLexicalEvidence gate, dist/src/search/ranking.js:188)

C3 | PASS | `run.sh c3` (reranker model cached, ~1.7 s/query incl. load, well under 120 s): mode deep "garbage collector memory safety" → 3 results, scores [0.9993, 0.9990, 0.9901] all in [0,1], ALL_EQUAL false, match_reason "rerank"; order changes vs fast — fast [09-gc-internals, 03-rust-safety] vs deep [09-gc-internals, 04-jvm-tuning, 03-rust-safety] (reranker inserts 04-jvm-tuning at rank 2); second query "memory safety garbage collection": deep [0.99945, 0.99938, 0.98113], TOP3_CHANGED_VS_FAST true

C4 | PASS | `run.sh c4`: "anchored harbor network" fast limit 5 → P1 5/has_more true, P2 5/has_more true, P3 2/has_more false, total 12; OVERLAP P1∩P2=P2∩P3=P1∩P3=0, UNIQUE_TOTAL 12; offset 20000 → offset capped, CAPPED_RESULTS 0, CAPPED_HAS_MORE false, warning exactly ["offset capped at 10000; results repeat past the cap"]

C5 | PASS | `run.sh c5`: "xqzzj wumpus flibbertigibbet qwertyuiopzzz" → fast: results 0, suggestions ["Try mode 'fast' for exact symbols or mode 'semantic' for conceptual wording.", "Run knowledge_status if the KB should contain this answer."], no crash; hybrid: identical suggestions array

C6 | PASS | `run.sh c6`: 30 results across fast/hybrid × 3 queries — zero violations; every result has finite `score`, `ranking` object, and `adjusted_score === score` exactly (e.g. top fast 7.814292562924347 === adjusted 7.814292562924347); `tuning` exposes min_hybrid_score, candidate_limit, deep_rerank_candidates, requested/selected_profile; C6_ALL_ADJUSTED_EQ_SCORE true

C7 | PASS | `run.sh c7`: default floor — hybrid "anchored harbor network" 14 results MIN_SCORE 0.2011 ≥ TUNING_FLOOR 0.18, junk query 0 results; `PI_KNOWLEDGE_MIN_HYBRID_SCORE=0.99` — TUNING_FLOOR 0.99 reported, results 14→13 (the 0.2011 sub-floor hit removed), remaining MIN_SCORE 1.1960 ≥ 0.99, junk query 0 results

C8 | PASS | `run.sh c8`: kb_id "kb-a" on shared-vocabulary query "harbor anchor" → 12 results, SCOPED_KB_NAMES ["kb-a"] only, LEAK_SECRET false — vs unscoped same query which includes kb-b's berth-manifest chunk (0.2011 in C7 default run); scoped kb_id "kb-b" on "cargo manifest berth" → 1 result kb-b only

## Observations (non-blocking, not contract violations)

- Deep reranker (Xenova/ms-marco-MiniLM-L-4-v2) scores the keyword-stuffed JVM doc ~0.999, near-tied with the semantically correct docs — tiny cross-encoder is surface-overlap sensitive. Reranker contract (runs, [0,1], not all equal, reorders) is satisfied; ranking quality is model-inherent.
- Hybrid requires lexical evidence (hasEnoughLexicalEvidence) — zero-overlap paraphrases return empty in hybrid by design; use mode semantic/auto for those. Consistent with AGENTS.md mode guidance.
- FTS has no porter stemming for "anchored" vs "anchor" in strict-AND fast mode (kb-b's "anchor registry" chunk not matched by fast "anchored harbor network"); hybrid OR-fallback does match it. Worth noting for lane L1/L4 awareness only.
- Incidental discovery (out of lane): a file named `secret-manifest.md` is silently suggested-excluded at add time (kb-b indexed 0 chunks until renamed to `berth-manifest.md`) — matches the documented suggested-exclusion contract; flagging for the ingestion lanes.

## Environment

- node v26.8.1; engine booted from dist with fresh schema; no network access (PI_KNOWLEDGE_OFFLINE=true, models local).
- No repo files modified; probes and scratch corpus live entirely under /tmp/fx-L3-search-modes/.
