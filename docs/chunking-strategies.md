# Chunking 策略規格

---

## 1. 策略優先級

| 優先 | 策略 | 適用 | Chunk 大小 |
|------|------|------|-----------|
| 1 | Recursive AST-based | TS/JS/Python/Go/Rust/Java/Bash/C/C++/QML | declaration-first; bounded fallback at ~6,000 chars |
| 2 | Markdown-aware | .md files | heading 為單位 |
| 3 | Semantic boundary | 其他文字檔 | 300-1000 tokens |
| 4 | Fixed-size | 未知格式 fallback | 512 tokens, 64 overlap |

---

## 2. Token 估算

不載入 model 就估算，用 chars/token ratio:

```typescript
// XLM-RoBERTa tokenizer 平均:
// 英文: ~4 chars/token, 中文: ~1.5 chars/token, 程式碼: ~3.5 chars/token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3); // 混合內容取 ~3
}
```

精確 tokenization 在 embedding 時由 @huggingface/transformers 處理。

---

## 3. 檔案掃描

### .gitignore + 內建排除

```typescript
// 使用 'ignore' package (Pi 生態已用)
const ig = ignore();
ig.add(readFileSync('.gitignore', 'utf-8'));
ig.add([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '*.min.js',
  'docs/*knowledge-base*report*.md',
  'docs/*evaluation-report*.md',
  'docs/*eval-report*.md',
]);
```

### Binary 偵測

```typescript
function isBinary(path: string): boolean {
  const binaryExts = new Set(['.png','.jpg','.gif','.zip','.gz','.pdf','.exe','.db','.bin']);
  if (binaryExts.has(extname(path).toLowerCase())) return true;
  const buf = readFileSync(path, { length: 512 });
  return buf.includes(0x00); // null byte = binary
}
```

### 大小限制: 預設 10 MB/file (可配)

---

## 4. Markdown-Aware

- 按 heading (##/###) 切分
- 保留 heading + content 為一個 chunk
- 跳過 <50 chars 的 section
- >2000 tokens 的 section 再按段落切分
- Frontmatter → 提取為 metadata，不索引 raw YAML

---

## 5. Semantic Boundary (通用文字)

- 按 `\n\n+` 分段落
- 累積到 ~1000 tokens 時 flush
- Overlap: 保留前一 chunk 最後一段 (2 sentences)
- 確保不在句子中間切斷

---

## 6. Fixed-Size (Fallback)

- 512 token chunks, 64 token overlap
- 用行為單位避免 mid-line cut

---

## 7. AST-Based

| 語言 | 切分單位 | Metadata |
|------|---------|----------|
| TS/JS | class, interface, type, function, exported arrow/function-valued variables, class field methods | `language`, `symbol`, `symbol_kind`, `scope`, `parent_symbol`, `signature`, `exported`, `ast_path`, `start_line`, `end_line` |
| Python | class, function, method | 同上，並保留 decorators |
| Go/Rust/Java | function/method/type/class/interface declarations supported by tree-sitter grammar | 同上 |

> Inspection-only metadata keys: code-AST chunks also store `ast_depth`, `decorators`,
> `modifiers`, `visibility`, and `static` in `metadata_json` (and thus the chunk identity
> hash and export/import round-trip), but no search/ranking/tool path reads them — they are
> stored for inspection only. Symbol-table `metadata_json` is likewise inspection-only.
> `match_reason: "symbol"` in search provenance is a reserved value that current code never
> emits.
| Bash | function declarations in `name() {}` and `function name {}` forms | 同上；parse errors fall back to text chunking |
| GNU C | `.c` function definitions/prototypes, structs, unions, enums, typedefs, reliable preprocessor definitions | 同上，並保留 `static` storage metadata when present; `.h` remains text by default |
| C++ | `.cpp`/`.cc`/`.cxx` source and `.hpp`/`.hh`/`.hxx` headers: namespaces, classes, methods, constructors/destructors, enums, templates where tree-sitter parses cleanly | 同上，並保留 explicit access visibility; Qt macro parse errors fall back to text chunking |
| QML | `.qml` imports, component/object definitions, properties, signals, handlers, ids, bindings, and embedded JavaScript functions | 同上；object hierarchy is preserved in `scope` / `parent_symbol`, parse errors fall back to text chunking |

原則:

- 小型 class/type/function 以完整 declaration 為 chunk，保留可讀原始內容。
- 超過 token 上限的 parent declaration 會遞迴下降到 child declarations；例如大型 class 會拆成 method-level chunks。
- 相鄰且同 parent 的小 child declarations 可 pack 成 sibling group chunk，以減少碎片化。
- 沒有可用 child declaration 的巨大節點用行與固定字元上限切分，避免產生 MB 級 chunk。
- Chunk identity 包含 file path、file type、line range、metadata 和 content；不能只看 content。
- Symbol index 來自同一次 AST analysis；method symbols 可以獨立於 retrieval chunk 存在。

---

## 8. Code Pre-Tokenize (for FTS5)

```typescript
function preTokenizeCode(content: string): string {
  return content
    .replace(/([a-z])([A-Z])/g, '$1 $2')        // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // ACRONYM
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')         // item1
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');        // 3px
}
```

Edge cases (`XMLHTTPRequest`→不完美) 可接受，Phase 3 改善。

---

## 9. Math & Science-Aware（Markdown / LaTeX）

數學與科學文件（含 Obsidian vault 筆記、LaTeX 論文）使用保護區域掃描（`src/indexer/math-text.ts` 的 `splitProtectedSegments`），避免把結構切半。

### 9.1 保護區域（atomic chunk 單位）

| 區域 | 開始 | 結束 | 適用模式 |
|------|------|------|---------|
| Fenced code | ` ``` `/`~~~ `（info string 非 `math`） | 同字元 fence line | markdown、text |
| Math fence | ` ```math ` | ` ``` ` | markdown、text |
| Display `$$` | 行首 `$$`（同行未閉合） | 含未跳脫 `$$` 的行 | markdown、text |
| Display `\[..\]` | `\[` 獨佔一行 | 含 `\]` 的行 | markdown、text |
| LaTeX 數學 env | `\begin{equation\*?\|align\*?\|gather\*?\|eqnarray\|math\|displaymath}` | 對應 `\end{…}` | markdown、text、latex |
| LaTeX 表格 env | `\begin{table\*?\|tabular\*?}` | 對應 `\end{…}` | latex |
| Pipe table | ≥ 2 行連續 `^\s*\|.*\|\s*$` | 第一個非符合行 | markdown、text |

規則：反斜線跳脫的 `\$` 不開啟數學；未閉合的 opener 一律 fail-open（視為純文字）；單行 `$$…$$` 為一行 atomic segment。保護 segment 為 soft token target：永遠整塊進 buffer，超過 target 時先 flush；超過 6,000 chars 時 `splitOversizedProtected` 只在頂層 `\\`（數學）或行列邊界（表格/code）切開，絕不切在行/列內部。

### 9.2 數學 unicode 正規化（`canonicalizeMathText`，canonicalize-last）

`preTokenizeForFTS` 在既有 chain 之後套用 canonicalization（順序是契約：先 chain 會把 `pow2` 撕成 `pow 2`）。內容：

- 92 個 unicode → LaTeX 詞（空格補邊）：希臘小寫 25（含 ς→sigma）、希臘大寫 24（fold 到同一小寫詞）、關係 12、運算 20、箭頭 6、其他 5。
- 上標 15 個直接 fold 成 ` pow0`…` pow9`、`powplus`、`powminus`、`poweq`、`pown`、`powi`；下標 14 個 → `sub0`…`sub9`、`subplus`、`subminus`、`subeq`、`subn`。一律 plain alphanumeric（FTS5 unicode61 與查詢端 punctuation strip 不會切碎）。
- ASCII caret 規則：`^2`/`^{ij}`/`^n` → ` pow2`/` powij`/` pown`；非英數 braced body（`^{\top}`）→ ` pow`。ASCII `_` 一律不轉換（`snake_case` 安全）。
- 無數學字元且無 `^` 的輸入走 identity fast-path，回傳原字串參考（非數學內容 byte-identical）。
- LaTeX 端（`\alpha`、`\leq`）不需要 map：backslash 在 FTS 與 tokenizer 自然斷詞成同一個詞。

範例：`x² + y² = r²` → `x pow2 + y pow2 = r pow2`；`∫₀^∞ f(x)dx` → `int sub0 powinfty f(x)dx`；`a_{ij}` 不變。

### 9.3 Vault / LaTeX metadata

- Markdown frontmatter（僅 `title`/`tags`/`aliases`，fail-open）成為每個 chunk 的 metadata 與 embedding prefix（`Title:`/`Tags:`/`Aliases:`）。
- `[[wikilinks]]`（`[[target]]`、`[[target\|alias]]`、`[[target#sec]]` → target）與 display formulas（每 chunk 最多 10 × 2000 chars）進入 `Links:`/`Formulas:` prefix lines。
- `.tex`/`.ltx`/`.latex` → `latex` file type：`\chapter`/`\section`/`\subsection`/`\subsubsection` 作為 heading 邊界（breadcrumb 同 Markdown 語意），`\label{…}` 進 `labels` metadata 與 `Labels:` prefix line；`\begin{document}` 前的內容為 `Preamble` chunk。
