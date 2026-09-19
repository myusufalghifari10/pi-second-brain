# 技術決策紀錄 (ADR)

日期: 2026-06-14

---

## ADR-001: 使用 @huggingface/transformers 作為唯一 embedding 引擎

**狀態**: 已決定

**背景**: 需要在 Pi extension 中做本地向量嵌入。原始方案用 onnxruntime-node + tokenizers-node (2 native deps)。

**決策**: 改用 @huggingface/transformers (1 顯式 dep，內建 WASM tokenizer + onnxruntime-node transitive dep)。

**理由**:
- 解決 tokenizer（XLM-RoBERTa SentencePiece）
- 自帶 model download + cache + progress callback
- 自動偵測 Node/Bun 選對 backend
- 一行 `pipeline()` 完成一切
- 減少顯式 native dep 從 3 → 1

---

## ADR-002: Phase 1 用 pure-JS flat cosine search

**狀態**: 已決定

**背景**: 向量相似度搜尋選型。

**決策**: Phase 1 brute-force cosine。Phase 3 若 >10K vectors 再加 HNSW。

**理由**:
- 少一個 native dep
- 10K × 384d brute-force ~5-10ms on M1
- 大多數 KB 在 1K-5K chunks

**升級觸發**: 延遲 >50ms 或 vectors >30K

---

## ADR-003: Embedding cache key = SHA-256(content)

**狀態**: 已決定

**背景**: 增量索引需要 content-addressed cache。

**決策**:
- Embedding cache key: `SHA-256(content)` — 只看內容
- Chunk identity: `SHA-256(filePath + fileType + startLine + endLine + metadataJson + content)` — KB 內唯一

**理由**:
- Embedding cache 可以只看 content，因為同一段文字的語意向量可重用。
- Chunk identity 不能只看 content，否則不同檔案或同檔不同位置的相同內容會在 update 時互相覆蓋，造成刪除檔案後 stale chunks/orphans 留在 KB。
- 目前 SQLite `content_hash` 欄位承擔的是 chunk identity，不是 embedding cache key；因此必須包含 path、line 與 metadata。若未來新增真正 embedding cache，應使用獨立欄位或獨立 cache key。

---

## ADR-004: 預設 multilingual-e5-small

**狀態**: 已決定

**背景**: zh-TW + 英文混合環境。

**決策**: 預設 multilingual-e5-small quantized (32 MB)。

**理由**: 同 384d、中文品質好、quantized 損失 <2% for 高資源語言。

---

## ADR-005: Lazy-load + stable native model lifecycle

**狀態**: 已決定

**行為**: 首次 add/search 載入本地 embedding/reranker → Pi/OMP 主程序啟動隔離 Node model worker → worker 內載入 transformers.js / `onnxruntime-node` → session 內保留 worker 到 shutdown → `session_shutdown` 等 active runs 完成後用 `SIGKILL` 收掉 worker。Transport 優先使用 Node `fork()` IPC；若 Windows OMP 或其他相容層沒有提供 `child.send()`，自動改用 `spawn(node, ... --stdio)` 的 stdin/stdout JSONL protocol。Node resolution 順序是 env override、持久化 runtime config、目前 Node process、Windows 常見安裝位置、Codex `cua_node` runtime、最後才是 PATH。`PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE=true` 是明確 opt-in，不是預設。

**理由**: 大多數 session 不用 knowledge → 0 memory cost；一旦使用本地模型，穩定退出優先於把 native backend 留在 Pi/OMP TUI 主程序。已驗證 macOS arm64 上主程序載入 native backend 後 `/quit` 會觸發 onnxruntime `mutex lock failed` abort。Windows OMP 的 host runtime 可能無法提供完整 Node fork IPC，且 agent 在已啟動 session 內設定的 env 不一定會傳到 plugin runner；因此 worker transport 必須先驗證 IPC 能力、以 stdio JSONL fallback 保持隔離子程序與相同 request/response contract，並提供持久化 `knowledge_configure` 設定作為 env 之外的配置渠道。

---

## ADR-006: 儲存 ~/.pi/knowledge/ (global) + .pi/knowledge/ (project)

**狀態**: 已決定

**理由**: 知識庫是獨立功能，不嵌套 agent/ 下。

---

## ADR-007: pi install 會跑 postinstall (confirmed from source)

**狀態**: 已確認

**證據**: `package-manager.ts` getNpmInstallArgs() 無 --ignore-scripts。

---

## ADR-008: FTS5 + camelCase pre-tokenize

**狀態**: 需 spike 驗證品質

**方案**: index 前 `replace(/([a-z])([A-Z])/g, '$1 $2')`。

**備案**: trigram tokenizer。


---

## ADR-009: tree-sitter for multi-language AST

**狀態**: 已決定

**選 tree-sitter 而非**:
- TypeScript Compiler API → 只支援 TS/JS
- Babel → 只支援 JS/TS
- ast-grep → 較新、社群小
- 各語言 native parser → 需要 N 個不同 API

**理由**: 唯一能用一套 API 支援 6+ 語言的 AST parser。C binding 但有 Node prebuilt。

---

## ADR-010: unpdf for PDF text extraction

**狀態**: 已決定

**選 unpdf 而非**:
- pdf-parse v2 → API 完全重寫(class-based)、bundle 巨大、測試失敗
- pdfjs-dist → unpdf 內部就是 wrap 它，但 API 更簡潔
- pdf2json → 輸出 JSON 不是 plain text

**理由**: Pure JS、API 簡單 (`extractText(Uint8Array) → {text}`)、中文實測通過。

---

## ADR-011: mammoth for DOCX

**狀態**: 已決定

**選 mammoth 而非**:
- docx-parser → 維護較少
- officeparser → 較新、未經大規模驗證
- textract → 需要系統工具(antiword)

**理由**: Pure JS、15K+ stars、活躍維護、`extractRawText({path}) → {value}` 一行完成。

---

## ADR-012: Regex HTML stripping for URL indexing

**狀態**: 已決定（可改進）

**當前**: `html.replace(/<script>...</script>/).replace(/<[^>]+>/g, " ")`

**替代**: cheerio (~200KB), @mozilla/readability, htmlparser2

**理由**: 零額外依賴。對文檔類頁面（API docs、blog、wiki）夠用。

**已知限制**: 不處理 nested `>`、HTML entities、SPA 動態內容。

**未來升級條件**: 如果使用者回報 URL indexing 品質差，加 cheerio。

---

## ADR-013: JSONL for import/export

**狀態**: 已決定

**選 JSONL 而非**:
- Single JSON → 大檔案不 git-friendly（一行改動 = 整檔 diff）
- SQLite dump → 需要 SQLite 工具解讀
- Custom binary → 不可讀

**理由**: Line-diffable（git-friendly）、streaming 讀寫、人類可讀、可用 jq 查詢。

---

## ADR-014: Contextual Retrieval 使用「索引增強 + 查詢時擴窗 + 意圖排序」

**狀態**: 已決定

**背景**: 單純 chunk-level embedding 會讓 README 或大型概覽文件反覆出現在 top results，也會讓小模組、實作檔與測試檔混排。RRF 雖然穩定，但會壓縮 hybrid score，導致結果差異變成「量的變化」而不是「質的排序」。

**決策**:
- 索引時把 file path、file type、Markdown heading breadcrumbs、code symbols 納入 embedding/FTS searchable text。
- 查詢時保留原始 chunk 作為回傳內容，但 adaptive mode 會從 seed chunk 擴張同檔案上下文 window。
- Hybrid 用 normalized weighted score fusion，後接 query-aware ranking，不再用 RRF 作為預設 fusion。
- Ranking 必須同時考慮 lexical coverage、path token、source file intent、documentation/setup intent、test intent 與 low-evidence confidence gate。
- Ranking diagnostics 必須可回傳，方便用真實專案報告檢視分數與排序原因。
- Agent-facing mode selection 必須文件化，不能只提供 modes 讓模型自行猜測。
- `auto` mode 在工具層執行 primary mode selection 與 fallback，並回傳 mode/retry metadata。

**理由**:
- 索引增強解決「chunk 自身缺少檔案/章節/符號語意」。
- 查詢時擴窗保留上下文，但不污染原始 chunk 內容。
- 意圖排序讓 `stt/stt.go`、`bot/errors.go`、`INSTALL.md` 這類目標依查詢語意勝出，而不是被長文件或測試檔覆蓋。
- Confidence gate 讓無意義或低證據查詢可以回傳 0 結果，避免 agent 建立錯誤信心。
- Mode contract 讓 agent 依任務型態選擇 `fast`、`semantic`、`hybrid`、`adaptive` 或 `deep`，並在空/弱結果時重試一次，降低 false negative。
- Tool-owned `auto` mode 降低 agent 忘記切換模式的機率；exact lookup fallback 必須防 semantic false positive。

**重建索引邊界**:
- Query normalization、ranking、confidence gate、diversity 屬於 query-time 變更，既有 KB 可直接受益。
- embedding/FTS searchable text、file type 標記、chunk metadata 屬於 index-time 變更，既有 KB 必須 update/rebuild 才會完整受益。

**研究依據與取捨**:
- 採用 RAG 的基本分工: 外部知識以檢索方式進入上下文，而不是要求模型記住所有內容。參考 Lewis et al. 2020, "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks".
- 採用 dense retrieval 作為 semantic recall 層。參考 Karpukhin et al. 2020, "Dense Passage Retrieval for Open-Domain Question Answering".
- 採用 Contextual Retrieval 的核心洞察: chunk 本身常缺上下文，因此 searchable text 需要補上 chunk 所屬的文件/章節/符號背景。參考 Anthropic 2024, "Introducing Contextual Retrieval".
- 保留 RRF 作為測試過的 fusion baseline，但預設改用 normalized weighted score fusion。原因是本產品需要可診斷的分數區間；RRF 在專案級 dogfood 中讓 hybrid score 過度壓縮。參考 Cormack et al. 2009, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods".
- 採用 MMR 類似的 diversity 思路降低同檔案、同 window、同語意 chunk 的重複佔位。參考 Goldstein and Carbonell 1998, "Using MMR for Diversity-Based Reranking".
- 未採用 ColBERT late interaction 作為本 release 預設。ColBERT 對精細 token interaction 有價值，但需要更重的模型與索引設計；目前用 lightweight local embeddings、BM25、query-aware ranking、diversity 和 optional cross-encoder reranking 先取得較低成本的商用品質。參考 Khattab and Zaharia 2020, "ColBERT".

---

## ADR-015: 大型索引採用 bounded batches + streamed vectors

**狀態**: 已決定

**背景**: 真實專案可能包含數百到數十萬個可索引 chunk。大型 indexing 是產品支援的長任務，不是必須瞬間完成的背景小工作；產品責任是限制資源、持續顯示進度、避免假死與壞狀態。若 `knowledge_add`、`knowledge_update` 或 `knowledge_import` 一次持有全部 embedding input、全部 Float32 vectors，再用單一 `Buffer.alloc` 寫 vector file，會讓大型 codebase 建 KB 時不穩定，也讓使用者無法判斷目前是否仍在進展。

**決策**:
- directory scan 用 iterator/callback 型 API 串流產生檔案，production add/update path 不先收集所有 `ScannedFile.content`；diagnostics 使用 metadata-only scanner，不讀取完整檔案內容。
- binary detection 只讀固定 sample，不用 `readFileSync` 讀完整檔案後再取前段。
- embedding batch 是硬上限，目前為 64 chunks；單一大檔產生大量 chunks 時也不能超過此上限。
- 每個 batch 成功後立即寫入 SQLite 並更新 KB counts，讓 `updated_at` 代表索引仍有進展。
- vector file 用 header placeholder + append vectors + close 時回寫 header 的方式串流寫入。
- update 以 hash manifest 判斷新增/刪除/未變更，新增向量先寫入 temporary vector file，最後依 SQLite chunk iterator 重建正式 vector file。
- 刪除 chunks 必須分批執行，避免大型 KB 超過 SQLite parameter limit。
- directory add/update 開始前先做 metadata-only planning scan，回報可索引檔案數、scannable bytes 與 skipped summary；這個 planning pass 不讀完整檔案內容。
- add/update/import 都必須提供 progress；能估算時包含 elapsed、chunks/sec 與 file ETA。大型檔案可能讓 file ETA 偏樂觀，因此進度文字必須同時顯示 chunk throughput。
- add/update/import 的 job state 必須持久化到 SQLite，包含 operation、status、phase、last message、started_at、last_progress_at、processed files/chunks、skipped、added、removed、unchanged 與 error_message。
- JSONL import 必須逐行讀取、bounded batch parse/embed/store；JSONL export 必須用 chunk iterator + write stream。Import/export 是大型 KB 的搬運路徑，不能把全檔、全部 chunks 或全部 JSON strings 一次放進 heap。
- `knowledge_status` 需要偵測 stale `indexing` 狀態，避免中斷後的半成品被誤認為健康 KB。
- `knowledge_status` diagnostics 需用 chunk iterator 與 streaming source scan，不載入全部 chunk content 或全部來源內容，並以 persisted job state 區分「仍在進展」和「卡住」。
- `knowledge_doctor` 以 health score + blocking/warning/info issues + concrete action 收斂使用者下一步。
- `knowledge_search` 跳過 `indexing` 和 `error` KB，只搜尋 `ready` 或 `stale` KB。
- semantic/hybrid search 以 vector file ranged reads 掃描 top-K，不把整個 KB 的 Float32 vectors 或全部 chunk IDs 放進長駐 cache。

**理由**:
- 商用品質的索引行為應先求穩定完成，再求速度。
- 大型 indexing 可以花很久，但不能因專案規模大而讓 process 無界成長、靜默卡死、或留下看似健康的 partial KB。
- 批次寫入讓大型專案在模型推論、SQLite 寫入、向量檔輸出三個階段都有可觀測進度。
- persisted job state 讓使用者可以在下一個 prompt、另一個狀態查詢或 TUI 更新消失後仍知道索引目前在哪個階段，而不是只能看到 `Working...`。
- 串流掃描讓 400 萬行等級 codebase 的主要記憶體消耗由「全部檔案內容 + 全部 chunks + 全部 vectors」降為「當前檔案 + embedding batch + hash/id metadata + top-K candidates」。
- 串流向量檔避免最後一次把所有向量複製到同一個巨大 buffer。
- query-time streaming scan 的時間複雜度仍是 O(N)，但記憶體用量由 O(N vectors) 降到 O(topK vectors)，更符合本階段「再大的 codebase 先穩定可跑」的目標。

**限制**:
- 搜尋仍是 exact scan，不是 ANN。若未來需要百萬級 chunk 的低延遲搜尋，需改成 mmap/分片向量索引或外部 ANN index。

---

## ADR-016: 文字檔風險由 agent 與使用者確認，不做永久硬排除

**狀態**: 已決定

**背景**: 大型專案常把重要架構、feature flags、module wiring、cloud/runtime 行為放在 `settings.json`、`appsettings.json`、`.env`、editor config、generated report、lockfile、vendor text 或其他設定/文字檔中。這些檔案可能是專案知識，也可能包含私人資訊或降低搜尋精準度。若產品層用 broad hard ignore 直接排除文字檔，會讓合法索引需求建立不完整 KB；若完全不提示 agent，又可能把敏感或低價值內容納入索引。

**決策**:
- hard skip 只用於技術不可索引或會破壞穩定性的內容: unsupported binary/non-text、oversized、unreadable、inaccessible、無法抽取文字的文件。
- 支援的文件格式（PDF/DOC/DOCX）是可索引來源，不因二進位副檔名樣貌而被 directory scan 當成 binary skip；單檔與 directory add/update 都必須走同一套 extractor。
- `.env`、private-key-looking text、credential/secret-named text、generated report、lockfile、vendor text、build output text、runtime/cache text 是 suggested exclusion，不是永久 hard block。
- `knowledge_plan` 是 no-write inspection tool，讓 agent 在建立 KB 前先回報 scannable files、suggested exclusions、technical skips，再請使用者確認。
- `knowledge_add` 預設可以略過 suggested exclusions，但必須提供 `include_suggested_text` 與 focused `include_paths` 讓 agent 在使用者確認後納入。
- `exclude_paths` 讓 agent 能在單一專案 KB 中精準排除使用者不想索引的文字檔，不需要拆成大量 per-file KB。
- confirmed scope options 必須持久化，`knowledge_update` 需重用同一套 include/exclude 規則，避免更新後悄悄丟失使用者確認過的文字檔。
- `knowledge_add` prompt guidance 必須要求 agent 把 source/docs/config 當成專案知識候選，同時對 ambiguous/risky/low-signal text 做風險與精準度判斷；若看起來可能是 environment-specific、private data 或搜尋污染來源，先向使用者確認。

**理由**:
- 工具層 hard block 應用在技術不可索引與穩定性底線；文字內容是否值得索引是產品/agent/user 的範圍決策。
- 將模糊決策移到 prompt、scan suggestions 與 user confirmation，可以保留完整性，同時讓使用者對隱私與精準度風險有最後決定權。
- 這比針對單一測試專案調整 ignore 更通用，適用於 .NET、Node、Java、cloud-native、browser tooling 等不同專案型態。

---

## ADR-017: Pi/OMP 相容性與環境變數覆蓋合約

**狀態**: 已決定

**背景**: `pi-knowledge` 需要同時支援 Pi extension 直載、npm package install、以及 OMP 這類 Pi fork/runtime。OMP install validation 可能在 Bun binary 內靜態解析 literal imports；若 extension entry 在啟動時直接碰 native dependency，就會在工具尚未使用前失敗。不同 runtime 也需要不同預設資料根目錄，但既有 Pi 使用者的 `~/.pi/knowledge` 不應在 OMP migration 時突然不可見。

**決策**:
- `extension.js` 是 package entry shim；build 後優先載入 `dist/index.js`，本地開發未 build 時 fallback 到 source `index.ts`。
- root `index.ts` 保持 startup-light；Pi virtual modules 只允許 type-only 或本地 shim，不在 import 時解析 native runtime。
- engine、storage、watcher 等 runtime modules 由 `ensureInitialized()` lazy import，只有 lifecycle/tool 實際需要時才載入。
- 本地 embedding/reranker 透過 model worker 子程序載入 `@huggingface/transformers` / `onnxruntime-node`，不讓 Pi/OMP TUI 主程序直接載入 ONNX native backend。
- `better-sqlite3` 載入先走一般 resolution，再在 Bun/hoisted dependency 情境用非 literal package name 和 parent walk fallback，避免 install-time pre-resolution 誤判。
- storage path resolution 順序是 `PI_KNOWLEDGE_DIR`、`OMP_KNOWLEDGE_DIR`、`PI_CODING_AGENT_DIR` / `OMP_CODING_AGENT_DIR` 推導 root、再依 OMP detection 選 `~/.omp` 或 `~/.pi`。
- OMP detection 的最低合約是 `OMP_PROFILE` 或 executable basename 為 `omp`。這避免依賴未驗證的 OMP host internals。
- 在預設 home OMP root 且 `~/.omp/knowledge` 不存在時，若 legacy `~/.pi/knowledge` 存在，繼續使用 legacy Pi knowledge dir，避免 OMP migration 時看不到既有 KB。
- 所有 runtime override 必須集中記錄在 `docs/configuration.md`，README 保留使用者入口摘要。

**理由**:
- Install-time validation 應能檢查 extension metadata 和 tool schema，不應因 native module resolution 或 model runtime 提前失敗。
- Lazy runtime + worker isolation 讓 Pi/OMP 在不使用 knowledge tools 的 session 保持低風險、低成本。
- 明確 env overrides 讓 release dogfood、Docker smoke、Pi/OMP isolated install、使用者 migration 都能用可重現方式指定資料與模型位置。
- OMP 支援應記錄最低可驗證 contract，不 overclaim fork host internals。

**驗證要求**:
- entry/package 變更需跑 `npm run build`、`node -e "import('./extension.js')"`、`node --experimental-strip-types -e "import('./index.ts')"`、`npm pack --dry-run`。
- OMP-sensitive 變更需至少跑 OMP install 或 `omp -e ./extension.js` dogfood；若本機無法取得 OMP runtime，release handoff 必須明確標示未驗證。
- native dependency、model worker、storage path 或 shutdown 變更需補 async lifecycle review 與 targeted regression tests。

---

## ADR-018: Recursive AST chunking and AST-backed symbol metadata

**狀態**: 已決定

**背景**: Flat function-level chunking made large classes either too coarse or too fragmented, and `knowledge_symbol_search` relied on declaration regexes that missed common method syntax. Search also needed deterministic structural context richer than one `function_name` field without mutating returned chunk content.

**決策**:
- Supported code files use a normalized tree-sitter structure for TypeScript/JavaScript, Python, Go, Rust, Java, Bash, `.c` GNU C source, C++ source/typed headers, and QML UI files during indexing.
- Small declarations remain whole chunks; oversized declarations recursively descend to child declarations; same-parent small declarations can be packed; nodes with no child declarations use bounded line/character fallback chunks.
- Chunk metadata records deterministic structure: `language`, `symbol`, `symbol_kind`, `scope`, `parent_symbol`, `signature`, export/decorator flags, AST path, and source line range.
- Embedding/FTS searchable text prepends structural metadata, but stored `content` remains the original source slice.
- `knowledge_symbol_search` uses symbols emitted from the same AST analysis so methods can be exact-looked-up even when the parent class is one retrieval chunk.
- Add/update parse each code file once for chunks and symbols; fallback keeps existing text/regex behavior when AST parsing is unsupported or fails.
- Tree-sitter imports stay lazy in indexing/chunking paths; root `index.ts` remains startup-light.
- Parser baseline (amended post-0.10.1): the shipped graph is `tree-sitter@0.21.1` with peer-aligned grammars and NO root `overrides.tree-sitter` pin — the earlier `0.25.1` + root-override plan was rolled back in 0.10.1 (#14) to stop peer-override warnings; see `docs/known-pitfalls.md` for the current baseline and the ❌-marked `0.25.1`-without-override case. JavaScript still uses `tree-sitter-javascript` directly instead of the legacy TypeScript package export.
- Ambiguous `.h` headers remain conservatively classified as text; C++ AST support covers `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, and `.hxx` where the extension itself identifies the language.

**理由**:
- Recursive splitting preserves semantic units while bounding worst-case chunk size for large classes, generated declarations, or huge methods.
- Structural metadata improves exact and contextual retrieval for class/method queries without LLM-generated context or private-source egress.
- Shared AST analysis avoids duplicate parser work and keeps chunk/symbol metadata aligned.
- Fallback preserves existing KB behavior for unsupported languages and short code files where AST emits only symbols.

**重建索引邊界**:
- This changes chunk boundaries, chunk identity metadata, searchable text, and symbol metadata. Existing KBs must run `knowledge_update` or be rebuilt to get full benefit.
- Query-time ranking changes still apply immediately, but AST-backed symbol lookup and structural embedding context require re-indexing.

---

## ADR-019: Metadata-driven AST-aware adaptive expansion

**狀態**: 已決定

**背景**: Recursive AST chunking gives code chunks deterministic `scope`, `parent_symbol`, `symbol_kind`, and signature metadata. Adaptive search already expands hybrid seed chunks with bounded same-file context, but line proximity alone can choose nearby unrelated code over a structurally related sibling method.

**決策**:
- Adaptive mode remains a hybrid-seed retrieval path with same-file bounded candidate fetching.
- Query-time expansion parses only chunk `metadata_json`; it never reparses source files and never imports tree-sitter.
- Candidate scoring combines the existing seed boost, line proximity, and lexical coverage with AST relation boosts for same parent symbol, compatible scope prefix, and parent/child structural relation.
- Returned content remains original chunk source joined as adaptive context; structural metadata is not prepended to returned content.
- `source_chunk_ids` remains the provenance mechanism for expanded context.
- Missing or invalid metadata falls back to the previous proximity/coverage behavior.

**理由**:
- This improves coding-agent context for class/method edits without turning `knowledge_search` into LSP, reference search, or caller/callee graph analysis.
- The bounded same-file candidate window preserves adaptive latency and avoids loading whole KB chunk sets.
- Existing KBs keep working; AST-aware expansion becomes available after update/rebuild populates structural metadata.

---

## ADR-020: Math canonicalization is the last step in `preTokenizeForFTS` (canonicalize-last) with pow/sub composite tokens

**Status**: Decided

**Background**: Layer 1 math-aware chunking needs cross-notation lexical hits: `x²` ⇔ `x^2`, `α` ⇔ `\alpha`, `≤` ⇔ `\leq`. FTS content is a single `content_tokenized` column and the query-side `tokenizeForSearch` also uses `preTokenizeForFTS` as its first stage, so this is the single point requiring symmetric injection.

**Decision**:
- `canonicalizeMathText()` (unicode map + caret rule + sup/sub folds) is applied AFTER the existing `preTokenizeForFTS` chain (canonicalize-last); the chain itself is untouched line-for-line.
- Superscript/subscript unicode folds into plain alphanumeric composite tokens such as `pow2` and `sub1`; the `+`/`-`/`=` forms use letter suffixes (`powplus`, `powminus`, `poweq`) rather than punctuation-bearing forms like `pow+`.
- ASCII `_` is never transformed (only `^` has a marker rule); ASCII `a_1` and unicode `a₁` remain asymmetric — a known and accepted limitation.
- Single-letter variables (`x`, `y`) are dropped on both index and query sides by the existing `length > 1` filter; cross-notation matching is carried by the `pow2`/`sub…` composite tokens.

**Rationale**:
- canonicalize-last is load-bearing: if canonicalization ran first, `x²` → `x pow2` would be torn apart by the chain's letter-digit split into `pow 2`, `2` would be dropped by the length filter, the FTS term would be just `pow`, and the whole cross-notation mechanism would silently die.
- Composite tokens guarantee FTS5 unicode61 and query-side punctuation stripping never split `pow2`/`sub1`, keeping BM25 terms exactly aligned.
- The unicode map must have zero impact on non-math text: the identity fast-path (no math characters and no `^` returns the original string reference) keeps existing tests and non-math KB chunk hashes unchanged — no re-embedding after upgrade.
- `_` is not transformed as a tradeoff: `snake_case` is everywhere and a `_x` → `subx` rule would break existing behavior; superscripts (`x²` vs `x^2`) are the dominant real-world symmetry need and are fully symmetric.
- The caret rule absorbs whitespace-separated operands: `flags ^ mask` → `powmask`, so the standalone token `mask` disappears from `content_tokenized` (a narrow lexical-recall change; the query side only hits symmetrically when the query itself carries the same caret expression) — coexisting with the documented `x^2`→`pow2` gain.
- The canonical form exists only in `content_tokenized` and query terms; chunk `content` keeps the original text (the only exceptions: frontmatter block removal with values preserved in metadata), so embedding quality is unaffected.

**Rebuild boundary**:
- New metadata keys (`formulas`/`labels`/`tags`/`aliases`/`title`/`links`) and changed Markdown/LaTeX chunk boundaries change chunk hashes: after upgrading, run `knowledge_update` once on affected KBs — only md/tex files get re-embedded; non-math files keep identical hashes and reuse their vectors.
- Pure-code KBs whose FTS text contains `^` (e.g. `x^2` in code fences) gain an extra `pow2` token: only in `content_tokenized`, returned content unchanged, query side symmetric — the effect is extra matchability, absorbed by BM25 IDF ranking.

---

## ADR-021: PDF extraction goes through an optional external sidecar (marker first, docling fallback, unpdf fail-open)

**Status**: Decided

**Background**: unpdf only extracts the raw PDF text layer — formulas in scientific documents turn into glyph soup and section structure disappears; math-aware chunking (Layer 1) needs `$$…$$` LaTeX input to shine. At the same time `knowledge_update` re-extracts every scanned file on each run, so without a cache every unchanged PDF would re-run an expensive conversion.

**Decision**:
- PDF extraction goes through an optional external converter sidecar that emits Markdown with `$$…$$` LaTeX math, flowing directly into the existing math-aware chunking pipeline. The sidecar is a user-installed external binary (pip); this package never bundles or ships it and adds no npm dependency.
- marker is primary, docling the fallback; both share one adapter contract. `PI_KNOWLEDGE_PDF_ENGINE=auto` probes marker → docling → none (`--help` probe, cached per process).
- Fail-open on every path: not installed, detection failure, conversion failure, or timeout (default 120 s, adjustable via `PI_KNOWLEDGE_PDF_SIDECAR_TIMEOUT_MS`) all fall back to the existing unpdf path; conversion failures after a converter was detected are recorded as `pdf_sidecar_failed` skipped stats. With `engine=off`, behavior is identical to unpdf-only.
- Conversion results are cached by content hash: key = `sha256(sha256(pdf file bytes) + resolved converter (the engine actually selected in `auto` mode, not the configured value) + adapterVersion + OCR setting (engine/command))`, stored under `<knowledge-dir>/pdf-cache/`; unchanged PDFs never re-convert; a corrupt cache entry is always a miss, never an error.
- Child processes run via `execFile(file, args)` argv arrays, never a shell; the PDF path enters as a single argv element. The `PI_KNOWLEDGE_PDF_SIDECAR_CMD` argv-template escape hatch also executes no-shell, with a `maxBuffer` cap and timeout kill.
- Converted chunks keep `file_type: "pdf"` (existing filter compatibility), record `converter` in `metadata_json`, and gain a `Converter:` context-prefix line.
- marker model weights are licensed OpenRAIL-M: this package never bundles, downloads, or redistributes weights; users install under marker's own terms.

**Rationale**:
- Sidecar choice follows the ICPR benchmark on scientific PDF parsers: no parser is perfect; marker and docling lead overall. marker has the best quality on scientific PDFs (including LaTeX formula output), hence marker-first; docling provides an installation/ops alternative, not feature parity.
- Fail-open makes the sidecar pure gain: when not installed, behavior matches today's unpdf path with zero startup cost (lazy dynamic import); existing KBs and tests are unaffected.
- The content-hash cache is mandatory, not optional: `knowledge_update` re-extracts every run, and without a cache every update would re-run the GPU/RAM-heavy marker for every PDF. The cache lives under the knowledge dir and inherits `PI_KNOWLEDGE_DIR` overrides automatically.
- No-shell spawn structurally eliminates crafted-path injection; `maxBuffer`/timeout turn a runaway sidecar output or a hung conversion into a single fallible event instead of stalling the whole index.
- `file_type: "pdf"` + `converter` metadata + the `Converter:` prefix keep filter users and provenance checks from being misled by a silently swapped extraction source.

---

## ADR-022: Formula retrieval uses a structural-lexical normalized index (normalized token signature + FTS fusion, not AST/symbolic equivalence)

**Status**: Decided

**Background**: Layer 1 made formulas survive chunking and canonicalize math unicode, but retrieval is still lexical matching over chunk text: a query `$E=mc^{2}$` competes with prose tokens, and cosmetic variants (`\dfrac`/`\frac`, `\le`/`\leq`, `{x}`/`x`, `\left(..\right)`, `\mathrm`, spacing) break matching. The complete solutions to formula equivalence (AST/skeleton structure matching, MathML, SymPy-style symbolic equivalence, MathIR, per-formula embeddings) each imply heavyweight dependencies, new vector spaces, or brittle parsers.

**Decision**:
- Formula retrieval takes the structural-lexical route: at index time formulas are extracted from chunk `metadata.formulas` and `normalizeFormula` normalizes each into a canonical token signature (layout commands removed, style wrappers unwrapped, L1 unicode maps reused, TeX alias table, braces removed, case preserved), stored in a dedicated `formulas` table + external-content `formulas_fts` (SCHEMA_VERSION 5→6, pure-SQL migration).
- The query side (`extractQueryFormulas`) uses the L1 scanner to pull formulas from the query (including bare-TeX detection, capped at 5) and runs two retrieval legs per KB: exact (full normalized equality, score 1.0) and FTS (quoted-OR terms, rank-normalized); per-chunk score = max of the legs.
- Fusion: already-retrieved chunks gain `FORMULA_BOOST = 0.35 * formulaScore`; candidates absent from results are injected with `match_reason: "formula"`, capped at 5. Injection deliberately bypasses `MIN_HYBRID_SCORE` — an exact/FTS formula hit is formula evidence, not a lexical-prose score, and must not be blocked by a confidence gate designed for prose queries.
- Explicitly rejected: AST/skeleton structure matching, MathML, SymPy-style symbolic equivalence, per-formula embeddings/vector index (deferred). The chunk-level vector already carries formula text; a dedicated formula embedding is duplicate investment.
- Fully dormant for non-math queries: with no formula in the query the entire fusion path executes zero statements and results are byte-identical to pre-L3. No new env vars, no new npm dependencies.
- Existing KBs are covered by a one-time backfill: on the first formula-bearing query (or first add) after upgrade, chunk `metadata_json` is scanned, formula rows written, and the `knowledge_bases.formula_index_built` flag guarantees once-per-KB; the whole body never throws — failures fail open (formula features silently dormant, everything else unchanged).

**Rationale**:
- The ARQMath (Mansouri et al.) lesson: symbolic n-gram / normalized-token baselines are competitive with full MathIR systems at a fraction of the complexity; full SLT/SymPy parsing is brittle and dependency-heavy. Brace-insensitive tokenization (`{x}`≡`x`, `\frac{a}{b}`→`frac a b`) covers the dominant cosmetic variants without a parser.
- Zero new dependencies: normalization is pure string operations plus the existing L1 unicode maps; the Node ecosystem has no lightweight symbolic-equivalence engine, and formula embeddings would need a new model and vector space, violating this feature's no-new-deps premise.
- Deterministic: same input always yields the same signature; FTS terms follow the `prepareFtsTerms` quoted-term discipline; no model inference means no nondeterminism and tests can assert golden values.
- Injected results bypassing `MIN_HYBRID_SCORE` is a ratified tradeoff: a formula-only-different query like `$E=mc^{2}$` would fail silently behind the confidence gate; the 5-result injection cap and the 0.35 boost cap keep the formula leg from drowning normal retrieval.
- Large-KB backfill cost is held acceptable by "once per KB + persisted flag + fail-open", consistent with ADR-015's long-task stability posture.

**Rebuild boundary**:
- The SCHEMA_VERSION 5→6 migration runs automatically when an existing KB opens; formula rows are backfilled by the first search/add — no manual `knowledge_update` needed; chunk identity and vectors are completely unaffected.
- If normalization rules ever change (new TeX alias table entries require a paired test vector), existing formula rows become asymmetric with query-side signatures and the `formulas` table must be dropped and rebuilt; that is an obligation on future changes, not behavior of this version.

---

## ADR-023: Chemistry normalization routes through a single entry point in `normalizeFormula` (lexical signatures, no RDKit)

**Status**: Decided

**Background**: Chemistry-heavy sources write the same species many ways: `\ce{H2SO4}` (mhchem), plain `H2SO4`, unicode `H₂SO₄`, with optional states, charges, hydrate dots, and reaction arrows. The Layer 3 generic formula normalizer is TeX-lexical: it treats `\ce` as a TeX command and never unifies unicode subscript characters with ASCII counts, so `H2SO4` and `\ce{H2SO4}` would not match. The complete chemistry equivalence solution (RDKit/SMILES structural matching) implies a heavy native dependency and a new equivalence model.

**Decision**:
- Single-entry routing: inside `normalizeFormula`, the trimmed raw input delegates to `chemNormalize()` when it contains `\ce{`, or when it contains no TeX commands and full-matches the anchored `MOLECULAR_RE`. Both index side (formula rows from chunk `metadata.formulas`) and query side (`extractQueryFormulas`) therefore share one deterministic path — no second chemistry code path exists to drift.
- `MOLECULAR_RE` is an anchored full-match over all 118 element symbols (case-sensitive, longest-first), accepting digit counts, `_` subscript separators, parenthesized groups (nested ≤ 2), charges (`+`, `-`, `^{n±}`, `^n±`), hydrate dots (`·`, `*`), state suffixes `(s)|(l)|(g)|(aq)` (stripped), and arrows that split multi-species sequences while preserving species order. A molecule match requires ≥ 2 element tokens and at least one uppercase letter, which kills prose words ("No", "At", "In") unless they genuinely full-match a formula.
- The `chemNormalize` pipeline is ordered and normative: strip the `\ce{}` wrapper and state suffixes; fold unicode sub/superscript characters to ASCII via a local char map (never the FTS-layer `sub2`-style fold tokens); unify arrows to `->` and charges to the trailing `^n±` form; map hydrate dots to a `.` token; emit per-species element-count tokens with paren groups flattened and multiplier-distributed (`Ca(OH)2` → `Ca O2 H2`, nested groups compose multiplicatively); join with single spaces, case preserved throughout (`Co` ≠ `CO`). It rejects (returns `undefined`, Layer 3 reject semantics) on zero species or input over `MAX_FORMULA_CHARS`, and tolerates mismatched parentheses without throwing.
- Query side: text segments that full-match `MOLECULAR_RE` are treated as one chemistry formula, so the plain query `H2SO4` works; the bare-TeX rule already covers `\ce{…}` queries; cap and reject semantics are unchanged from Layer 3.
- Lexical, not structural: the signature unifies spelling variants of the same composition; genuinely different compositions never match, and there is no RDKit, SMILES, or molecular-graph parsing. Prose-level molecular formula detection on the index side is intentionally out of scope (precision trap): only math-segment formulas and `\ce{}` inputs are indexed.
- No new dependencies and no schema change: chemistry rows live in the existing `formulas` table + FTS index and reuse Layer 3 fusion (boost/inject with `match_reason: "formula"`).

**Rationale**:
- The single entry point makes index and query signatures symmetric by construction; a parallel chemistry path would eventually normalize one side differently and silently break exact matching.
- Anchored full-match + ≥ 2 elements + math-segment-only indexing is the precision stance: chemistry false positives over free prose would pollute the formula index with garbage species; the query-side anchored rule buys plain-formula queries without that index-side risk.
- mhchem-style canonicalization without RDKit covers the dominant real-world equivalence (`H2SO4` family, charges, hydrates, simple states, paren groups); structural/isomer equivalence stays out of scope until an explicit dependency decision.
- Case sensitivity is chemistry semantics, not a bug: `Co`/`CO` and `No`/`NO` are different substances; folding case would merge them.

**Rebuild boundary**:
- Chemistry routing changes `normalizeFormula` output only for chemistry-shaped inputs; chunk content, chunk identity, and vectors are unaffected. KBs whose formula index was already backfilled before this change keep their pre-chemistry generic signatures for chemistry-bearing display formulas; per ADR-022's standing obligation, normalization-rule changes require dropping and rebuilding the `formulas` table if exact formula matching misbehaves on such KBs.

---

## ADR-024: Retrieval quality is gated by a byte-deterministic fixture eval harness (`npm run eval`); live-corpus runs are advisory

**Status**: Decided

**Background**: Through Layer 3, retrieval quality claims rested on dogfood impressions and one-off probe queries. Each layer changed indexing text, metadata, and ranking, and nothing mechanically prevented a regression from shipping: a ranking tweak that silently breaks math-notation recall would pass every unit test that does not assert end-to-end retrieval on golden questions.

**Decision**:
- `eval/golden/*.json` holds per-domain golden files (math-notation, formula, chem, units, code, prose, labels). Entries carry `{ id, query, mode, kb?, expect: { file_path | path_prefix, min_score?, must_reason? } }` — expectations assert file-level hits, not exact ranks or scores.
- `eval/run.ts` is the runner with two modes. `--fixture` (default, the hard gate) builds an ephemeral KB from committed fixtures, runs every kb-less golden query, prints recall@k with a per-domain table, and exits 1 on any miss. `--kb <name>` runs read-only against an existing KB in the default knowledge dir (only entries whose `kb` field matches), is advisory only, and exits 0 unless the KB is missing or the run fails.
- Byte-determinism is the fixture-mode contract: the fixture build asserts the pinned embedding signature against the warm-cache local model before any query runs, iteration is sorted everywhere, and the report contains no timestamps, durations, or chunk ids. Two consecutive runs must produce byte-identical reports.
- Wiring: `npm run eval` rebuilds and runs `dist/eval/run.js` (the runner imports built engine output); CLI passthrough works as `npm run eval -- --kb llm-papers`. The ratified `package.json` change is the single `scripts.eval` line — no dependency changes.
- Golden files grow per domain as layers land; the runner globs all files, so domains evolve independently without runner changes.

**Rationale**:
- A deterministic golden gate converts "retrieval feels fine" into a regression test: any indexing, chunking, normalization, or ranking change that flips a golden result fails visibly instead of shipping as a vague quality drift.
- Fixture mode gates because committed fixtures are frozen; the live corpus evolves (new documents, re-embeddings, schema migrations), so live runs answer "does this still work on real data" without gating releases on a moving target.
- Byte-determinism is what makes eval diffs meaningful: nondeterministic recall reports hide regressions inside run-to-run noise, and a deterministic report makes the two-consecutive-runs check itself a one-line verification.
- File-level expectations (instead of exact rank/score assertions) keep the gate stable under benign re-ranking while still failing on true misses.

---

## ADR-025: Label references resolve through scope-key hashing (schema v7) with a dormant dependency fusion leg

**Status**: Decided

**Background**: LaTeX documents cross-reference through `\label{}`/`\ref{}` families, and a query naming a label ("theorem:main") should retrieve the defining chunk and the chunks that reference it. Label names are only meaningful within a file scope: multi-file projects routinely define the same label in several files, and split documents (`\input`) break single-file assumptions. Guessing a resolution across files would inject wrong-document evidence with formula-grade confidence.

**Decision**:
- `extractTexRefs()` in `math-text.ts` extracts `\ref`, `\eqref`, `\cref`, `\Cref`, and `\autoref` targets (deduped, capped at `MAX_REFS = 40`) beside the existing `extractTexLabels`; the chunker LaTeX path threads `metadata.refs` alongside the existing `metadata.labels`.
- `resolveLabelTarget()` encodes the scoping rule as a pure function: the scope key is `sha256(relPath + "\0" + label)`; a same-file definition is preferred; on collision (same label defined in more than one file) or zero matches the edge resolves as `unresolved` — never guessed.
- Schema v7 is a pure-SQL migration cloning the formulas pattern: a `label_edges` table (`id` = sha256 of `kb_id`, `src_chunk_id`, `scope_key` joined by `\0`; `target_label`, `scope_key`, nullable `resolved_chunk_id` and `target_content_hash`, `kind` ∈ ref|label|link, `indexed_at`) with `(kb_id, src_chunk_id)` and `(kb_id, scope_key)` indexes, plus a `knowledge_bases.label_graph_built` flag column. The backfill runs once per KB (flag + in-process guard, fail-open wrap), scanning chunk `metadata_json`.
- Dependency fusion leg (engine search, post-merge, pre-threshold, beside formula fusion): a retrieved or injected chunk with resolved outgoing edges walks depth 1. Already-retrieved referenced chunks gain `DEPENDENCY_BOOST = 0.25` (ranking constant, `FORMULA_BOOST`-style); absent ones are injected with a base score of exactly 0.25 before the trust multiplier, `match_reason: "dependency"`, and `depends_on` provenance (`label`, `chunk_id`, `pinned`). Caps: 2 edges consumed per triggering chunk, 10 injected candidates per query. KB/file filters are respected, and injection bypasses the hybrid confidence threshold — same ratified rationale as formula evidence. Unresolved edges are recorded, never dropped or guessed; their audit surfacing is deferred (L5). Ratified narrowing (post-review): formula-injected triggers contribute `depends_on` provenance only — their targets are neither boosted nor injected (injection candidates derive solely from the retrieved set), and triggers are taken from the pre-threshold retrieved set; both corners are conservative and keep the dormant path byte-identical.
- Dormant contract: zero edges means zero work. Queries without label matches keep byte-identical results to the pre-label-graph behavior, and the whole path adds no new npm dependency.

**Rationale**:
- Scope-key resolution mirrors LaTeX's own semantics — labels are scoped, not global — and sha256 keys follow the repo convention already used for chunk identity and formula-row ids.
- Unresolved-not-guessed is the trust stance: a guessed cross-file resolution returns plausible but wrong-document evidence with injection-grade confidence, which is worse than returning nothing; recording unresolved edges keeps the graph auditable for L5.
- The dependency leg deliberately reuses the formula-leg architecture (boost + capped injection + threshold bypass) because the evidence class is identical: a structured index hit, not a lexical-prose score. The lower boost (0.25 vs 0.35) and tight caps keep one hot label from flooding top results.
- The once-per-KB flag-guarded backfill keeps first-query cost bounded and predictable, consistent with the Layer 3 formula index posture.

**Rebuild boundary**:
- `metadata.refs` changes `metadata_json`, which is an input to the chunk identity hash: every LaTeX-bearing chunk re-hashes, so the first `knowledge_update` after upgrading re-embeds affected LaTeX files (the ADR-020 rebuild-boundary precedent). Non-LaTeX KBs keep identical chunk hashes and vectors; the v6→v7 migration itself is additive and runs automatically on KB open.
