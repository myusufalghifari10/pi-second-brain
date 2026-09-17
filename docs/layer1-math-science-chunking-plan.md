# Layer 1 — Math & Science-Aware Chunking: Technical Execution Plan

Status: APPROVED SPEC — implementation baseline
Date: 2026-09-17
Owner: implementation agent (verify against this document; deviations require explicit re-approval)

---

## 0. Purpose & Success Definition

Make `pi-knowledge` correctly index **Markdown/LaTeX scientific documents** (math notation, tables, Obsidian-style vault notes) so that:

1. Display math and tables are **never split mid-structure** by chunking.
2. Lexical search matches **across notations** (`x²` ⇔ `x^2`, `α` ⇔ `\alpha`, `≤` ⇔ `\leq`).
3. `.tex` files get a dedicated section-aware chunker (new file type `latex`).
4. Obsidian-vault sources yield richer retrieval context via **frontmatter (title/tags/aliases)** and **wikilinks** metadata.
5. Existing behavior for non-math content is **byte-for-byte unchanged**.

**Success is measured by the acceptance criteria in §7.** Every task in §6 lists its own verifiable criteria. This document is the verification baseline: after implementation, each criterion is checked pass/fail with no interpretation room.

## 1. Scope

### In scope
- New module `src/indexer/math-text.ts` (canonicalization + protected-region scanner + metadata extractors).
- `src/indexer/chunker.ts`: math/table-aware `chunkMarkdown` + `chunkText`, new `chunkLaTeX`, `detectFileType` gains `latex`, `preTokenizeForFTS` applies canonicalization, new context-prefix fields.
- `src/indexer/symbols.ts`: LaTeX section-heading symbols.
- `src/search/ranking.ts`: `FILE_TYPE_ALIASES` gains `tex/ltx/latex → latex`.
- Unit tests (new `test/unit/math-text.test.ts`, extended `chunker.test.ts`, `search.test.ts`, `symbols.test.ts`).
- Docs: `docs/chunking-strategies.md`, `docs/technical-decisions.md`, `README.md`, `AGENTS.md`, `CHANGELOG.md`.

### Out of scope (explicit non-goals — do NOT implement)
- PDF formula extraction (Layer 2: marker/docling sidecar).
- Formula-to-formula structural retrieval / SSEmb-style operator graphs (Layer 3).
- New symbol kind `formula`; `knowledge_symbol_search` changes; search filters for tags.
- Obsidian mirror export (optional Layer 2.5).
- Changing embedding models, vector storage, engine.ts search/update flows.
- Changing `tokenizeForSearch`'s `token.length > 1` filter (single-char variables remain unmatchable lexically; mitigated by `pow2`/`sub…` composite tokens, see §3.3).

## 2. Current-World Facts (verified by static read — the contracts we build on)

| Fact | Location | Consequence |
|---|---|---|
| `preTokenizeForFTS` is the single symmetric injection point: it builds FTS `content_tokenized` (via `makeChunk`) AND is the first stage of `tokenizeForSearch` (queries) | `src/indexer/chunker.ts:402`, `src/search/query.ts:43` | Canonicalization applied **inside `preTokenizeForFTS`** is automatically symmetric for BM25, `queryCoverage`, `hasEnoughLexicalEvidence` — zero plumbing elsewhere |
| `search/query.ts` already imports from `indexer/chunker.ts` | `src/search/query.ts:1` | New module lives in `src/indexer/`, import direction follows existing precedent |
| `chunkIdentityHash` covers raw `content` + `metadata_json` only | `src/indexer/chunker.ts:417` | Tokenized/canonicalized text never affects hashes; new metadata keys ⇒ affected files re-chunk+re-embed on `knowledge_update` (intended) |
| Chunk constants: `MARKDOWN_TARGET_TOKENS=450`, `TEXT_TARGET_TOKENS=550`, `MAX_TEXT_CHUNK_CHARS=6000`, min chunk 50 chars, `estimateTokens = ceil(len/3)` | `src/indexer/chunker.ts:395-399` | New splitter reuses these; protected segments follow the same 6000 ceiling |
| `analyzeIndexableContent` routes code types to AST, everything else to `chunkFile`, which re-detects type by extension | `src/indexer/chunker.ts:647-712` | Adding `latex` needs: `detectFileType` entry + `chunkFile` branch. **`engine.ts` requires zero changes** (single-file `.tex` add flows through `extractSourceFileContent` → `analyzeIndexableContent` → `chunkFile`) |
| `buildContextPrefix` emits `File/Type/Section/Language/Scope/Parent/Kind/Symbol/Signature` lines; consumed by `buildChunkEmbeddingText` | `src/indexer/chunker.ts:435-460` | New fields append here; adaptive metadata parser in `engine.ts` ignores unknown keys (additive-safe, verified: `parseAdaptiveMetadata` reads only known keys) |
| `extractSymbols` dispatches by extension (`CODE_EXTENSIONS`, `CONFIG_EXTENSIONS`, md headings) | `src/indexer/symbols.ts:193-218` | LaTeX branch added by extension, mirrors markdown-heading pattern |
| FTS5 uses unicode61 (splits on non-alphanumerics incl. `\`, `$`, `_`); query terms are quoted words from `normalizedQueryText` | `src/search/bm25.ts`, `docs/fts5-code-tokenization.md` | Canonical tokens must be plain alphanumeric words (no punctuation) — the design below guarantees that |
| Existing `preTokenizeForFTS` unit tests assert exact output for non-math input | `test/unit/chunker.test.ts:20-27` | Canonicalization must be **identity for text containing zero math characters** — hard regression gate |

## 3. Specification — New Module `src/indexer/math-text.ts`

All exports pure functions, no I/O, no deps. Deterministic. Every function carries its own test file section (§7).

### 3.1 Unicode ⇄ LaTeX canonical map (`MATH_UNICODE_MAP`)

`Record<string, string>`, applied by replacing each mapped char with ` <name> ` (space-padded). **Exact enumeration (complete list — no others):**

**Greek lowercase (25):** α alpha, β beta, γ gamma, δ delta, ε epsilon, ζ zeta, η eta, θ theta, ι iota, κ kappa, λ lambda, μ mu, ν nu, ξ xi, ο omicron, π pi, ρ rho, σ sigma, ς sigma (final sigma), τ tau, υ upsilon, φ phi, χ chi, ψ psi, ω omega
**Greek uppercase (24)** — mapped to the SAME lowercase word as their lowercase counterparts (case-folded by design, so no reliance on FTS5 case-folding): Α alpha, Β beta, Γ gamma, Δ delta, Ε epsilon, Ζ zeta, Η eta, Θ theta, Ι iota, Κ kappa, Λ lambda, Μ mu, Ν nu, Ξ xi, Ο omicron, Π pi, Ρ rho, Σ sigma, Τ tau, Υ upsilon, Φ phi, Χ chi, Ψ psi, Ω omega
**Relations (12):** ≤ leq, ≥ geq, ≠ neq, ≈ approx, ≡ equiv, ∝ propto, ∈ in, ∉ notin, ⊂ subset, ⊆ subseteq, ∪ cup, ∩ cap
**Operators (20):** ± pm, ∓ mp, × times, ÷ div, · cdot, ∞ infty, ∂ partial, ∇ nabla, ∑ sum, ∏ prod, ∫ int, ∮ oint, √ sqrt, ∀ forall, ∃ exists, ∅ emptyset, ∴ therefore, ∵ because, ⊕ oplus, ⊗ otimes
**Arrows (6):** → to, ← gets, ⇒ implies, ⇔ iff, ↦ mapsto, ↔ leftrightarrow
**Misc (5):** ∠ angle, ∘ circ, ° degree, ℏ hbar, ℓ ell

92 entries total (25 + 24 + 12 + 20 + 6 + 5). Superscripts/subscripts are NOT in this map — they fold **directly to composite tokens** (see §3.2):
- Superscript fold (15): ⁰¹²³⁴⁵⁶⁷⁸⁹ ⁺⁻⁼ ⁿⁱ → ` pow0`…` pow9`, ` powplus`, ` powminus`, ` poweq`, ` pown`, ` powi`
- Subscript fold (14): ₀₁₂₃₄₅₆₇₈₉ ₊₋₌ ₙ → ` sub0`…` sub9`, ` subplus`, ` subminus`, ` subeq`, ` subn`

Folds MUST be plain alphanumeric words (§2 FTS constraint): the `+`/`-`/`=` forms use word suffixes (`powplus`, not `pow+`) because FTS5 unicode61 and `tokenizeForSearch`'s punctuation strip would otherwise shred them to bare `pow`/`sub`.

**ASCII `_` is deliberately NOT transformed** (marker rules apply to `^` only). Reason: `_` is ubiquitous in identifiers (`snake_case`), and a `_x` → `subx` rule would break the existing `preTokenizeForFTS` contract (test: "snake_case unchanged"). Consequence, accepted and documented: cross-notation subscript matching works only from the unicode side (`a₁` → `sub1`); ASCII `a_1` keeps today's behavior. Superscripts are the dominant real-world case (`x²` vs `x^2`) and get full symmetry.

LaTeX command side (`\alpha`, `\leq`, …) needs **no map**: backslash splits naturally in FTS unicode61 and in `tokenizeForSearch`'s punctuation strip, yielding the same `alpha`/`leq` word. The map's job is only to fold the **unicode side** onto the same word.

### 3.2 `canonicalizeMathText(text: string): string`

Pipeline (order is normative):
1. **Identity fast-path**: if the text contains no char from `MATH_UNICODE_MAP`, the superscript/subscript fold sets, and no `^` anywhere → return `text` unchanged (same reference). This guarantees the §2 regression gate: non-math text (including everything with `_`, `$`, Greek-free prose, CJK) is byte-identical to today.
2. Unicode map replacement (§3.1, space-padded names) — includes superscript/subscript chars folding directly to ` pow…`/` sub…` tokens.
3. **Caret marker rule** (ASCII side, applied repeatedly until fixpoint, one brace level):
   - `\^\s*(\{([A-Za-z0-9]+)\}|[A-Za-z0-9]+)` → ` pow$2-or-$1` (single token: `^2`→`pow2`, `^{ij}`→`powij`, `^n`→`pown`)
   - Non-alphanumeric exponent body (e.g. `^{\top}`) → bare ` pow` word.
   - No rule for `_` (see §3.1 rationale).
4. Collapse runs of spaces introduced by replacements (single space); original spacing elsewhere preserved.

Result contains only the original characters plus inserted space-separated alphanumeric tokens. **Examples (normative test vectors):**

| Input | Output of `canonicalizeMathText` |
|---|---|
| `x² + y² = r²` | `x pow2 + y pow2 = r pow2` |
| `α ≤ β` | `alpha leq beta` |
| `x^2 + y^{ij}` (ASCII, no unicode) | `x pow2 + y powij` (caret rule) |
| `\frac{a}{b}` | unchanged (LaTeX side needs no transform) |
| `E = mc²` | `E = mc pow2` |
| `a_{ij}` | unchanged (`_` never transformed — snake_case safety) |
| `a₁` | `a sub1` (unicode subscript folds directly) |
| `snake_case_and_more` | unchanged (no `^`, no math unicode → fast-path) |
| `∫₀^∞ f(x)dx` | `int sub0 powinfty f(x)dx` (map ∫→`int`, ₀→`sub0`, then `^∞`→` pow`+map(∞)=`powinfty`) |

### 3.3 Integration point: `preTokenizeForFTS`

```ts
export function preTokenizeForFTS(content: string): string {
	return canonicalizeMathText(               // ← ONLY change: applied LAST
		content
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			... (existing chain untouched, in original order)
	);
}
```

**Order is normative and load-bearing:** canonicalization runs AFTER the existing chain. The existing `([a-zA-Z])(\d)` letter-digit split would otherwise shred freshly minted composite tokens (`pow2` → `pow 2`, with `2` then dropped by the `length > 1` filter), silently destroying the entire cross-notation mechanism. With canonicalize-last, inserted tokens (`pow2`, `alpha`, `sub1`, …) are never re-split. Identity fast-path still guarantees byte-identical output for non-math input (existing 7 tests unaffected: the chain output contains no math chars/`^`, so `canonicalizeMathText` returns it by reference).

Because `tokenizeForSearch` starts with `preTokenizeForFTS`, query side gets the identical transform — e.g. query `x²` and indexed `x^2`/`x²` all produce token `pow2` (single-letter `x` is dropped by the existing `length > 1` filter on both sides — symmetric, accepted limitation). `normalizedQueryText` → BM25 terms therefore match. **No change to `query.ts` at all.**

### 3.4 Protected-region scanner: `splitProtectedSegments(text: string, mode: "markdown" | "latex" | "text"): Segment[]`

```ts
interface Segment { kind: "text" | "math" | "table" | "code"; text: string; startLine: number; endLine: number; }
```

Line-based scanner with mode-dependent rules (all **fail-open**: unclosed opener ⇒ treat region as plain text from that point):

| Region | Opens on | Closes on | Modes |
|---|---|---|---|
| Fenced code | ` ``` `/` ~~~ ` line (any info string; NOT `math`) | matching fence line | markdown, text |
| Math fence | ` ```math ` | ` ``` ` | markdown, text |
| Display `$$` | line starting `$$` not closed on same line | line containing `$$` | markdown, text |
| Display `\[ \]` | `\[` on own line | `\]` | markdown, text |
| LaTeX env | `\begin{equation|equation*|align|align*|gather|gather*|eqnarray|math|displaymath}` | matching `\end{…}` | markdown, text, latex |
| Table env | `\begin{table|tabular}` (starred variants `table*`/`tabular*` accepted as a ratified superset) | matching `\end{…}` | latex |
| Pipe table | run of ≥2 consecutive lines matching `^\s*\|.*\|\s*$` | first non-matching line | markdown, text |

Rules:
- Escaped `\$` never opens math (regex negative lookbehind on `\`).
- Single-line `$$…$$` is a math segment of one line (atomic, same treatment).
- Segments cover the whole input contiguously; `text` segments carry line ranges for the paragraph splitter.
- `startLine`/`endLine` are 1-based inclusive, matching `content.split("\n")` indices.

### 3.5 Metadata extractors

```ts
extractDisplayFormulas(segments: Segment[]): string[]   // math segments, verbatim, deduped, max 10, each ≤2000 chars (truncated + "…")
extractWikiLinks(text: string): string[]                // [[target]], [[target|alias]], [[target#h]] → target; deduped, max 20
parseFrontmatter(text: string): { title?: string; tags: string[]; aliases: string[]; bodyStartLine: number }
                                                        // "---" on line 1 + closing "---"; allowlist keys only: title (str), tags, aliases
                                                        // values: bare word, [list], comma string; malformed → all-empty, bodyStartLine 1 (fail-open)
extractTexLabels(text: string): string[]                // \label{…} values, max 20
splitOversizedProtected(segment: Segment, maxChars: number): Segment[]  // math: split at top-level \\ row separators; table: row lines; code: any line boundary. Never splits inside a row/line. Pieces keep kind.
                                                                        // PRECEDENCE (normative): a single row/line longer than maxChars is NEVER split mid-structure; it is emitted as one oversized piece (structural integrity outranks the char ceiling)
```

Constants exported: `MAX_MATH_BLOCK_CHARS = 6000`, `MAX_FORMULAS = 10`, `MAX_FORMULA_CHARS = 2000`, `MAX_LINKS = 20`, `MAX_LABELS = 20`, `MAX_TAGS = 20`, `MAX_ALIASES = 10`.

## 4. Specification — Changes to `src/indexer/chunker.ts`

### 4.1 `detectFileType` additions
`".tex" | ".ltx" | ".latex" → "latex"`. Not added to `isCodeFileType`, not added to `BINARY_EXTENSIONS`, not added to `DEFAULT_SUGGESTED_EXCLUDE`.

### 4.2 `chunkMarkdown` — protected-region-aware (replaces paragraph splitting internals)

Algorithm (normative):
1. `parseFrontmatter` → strip frontmatter block from content; `bodyStartLine` offsets all subsequent line numbers. Frontmatter values become chunk metadata (see 4.5) for **every** chunk of the file.
2. Heading-boundary splitting unchanged (`^(#{1,6})\s+`, breadcrumb stack).
3. Within a section body: `splitProtectedSegments(body, "markdown")`. Text segments are further split into paragraphs on blank lines (`\n\n+`, existing semantics). Each protected segment is one **atomic paragraph**.
4. Buffer assembly unchanged in spirit: join paragraphs while `estimateTokens ≤ MARKDOWN_TARGET_TOKENS`; min 50 chars per emitted chunk; heading text included in first chunk (existing tests). **Protected segments are always appended to the current buffer when encountered, regardless of their own length; if adding one would exceed the target, flush the buffer first, then start a new buffer with the protected segment alone (possibly followed by later paragraphs).** Target-tokens is therefore a SOFT limit for atomic protected segments (a single 5000-char equation block becomes one chunk ≈1666 estimated tokens) and a FIRM limit for prose; the HARD ceiling for every chunk is 6000 chars via rule 5.
5. Oversized handling: text paragraphs >`MAX_TEXT_CHUNK_CHARS` → existing 6000-char slicing. Protected segments >`MAX_MATH_BLOCK_CHARS` → `splitOversizedProtected` into ≤6000 pieces, pieces emitted in order as separate chunks (or buffered individually per rule 4). Protected segments ≤6000 are **never char-sliced**.
6. `metadata.formulas` = `extractDisplayFormulas` over the segments included in that chunk.
7. `metadata.links` = `extractWikiLinks` over the full file body (identical for every chunk of the file — the operative requirement; superset of the earlier per-section wording, ratified).

Preservation requirements (verified by existing tests staying green): heading chunks, breadcrumbs, `## Big Section` oversized test, `snake_case` preTokenize test, 50-char minimum, empty → `[]`.

### 4.3 `chunkText` — same protection, minimal diff

Wrap existing paragraph logic with `splitProtectedSegments(content, "text")`: text segments flow through today's buffer/slicing untouched; math/table/code segments are atomic paragraphs per 4.2 rules 4–5. `metadata.formulas` populated. No frontmatter/links (plain text has no vault semantics — YAGNI).

### 4.4 NEW `chunkLaTeX(content, filePath)`

1. `splitProtectedSegments(content, "latex")`.
2. Text segments scanned for `\chapter{…}`, `\section{…}`, `\subsection{…}`, `\subsubsection{…}` (starred variants `\section*{…}` etc. accepted as a ratified superset) — these act as heading boundaries (section stack → `breadcrumb` metadata, exactly like markdown's heading stack; `\chapter`=level 1 … `\subsubsection`=level 4). Content before `\begin{document}` or first section = one chunk with `heading: "Preamble"`, `breadcrumb: "Preamble"` (≥50 chars, else dropped).
3. Math/table envs atomic per 4.2 rules; `splitOversizedProtected` for >6000.
4. `file_type: "latex"`. `metadata.formulas` + `metadata.labels = extractTexLabels(sectionText)`.
5. Fallback: if zero chunks and content >10 chars → single chunk (matches `chunkFile` fallback).

### 4.5 Metadata & context prefix (data contract)

New optional keys in `metadata_json` (chunk-level, additive; `ChunkMetadata` already supports `string[]`):

| Key | Type | Source | Cap |
|---|---|---|---|
| `formulas` | string[] | display math verbatim | 10 × 2000 chars |
| `labels` | string[] | `\label{…}` (latex) | 20 |
| `tags` | string[] | frontmatter (markdown) | 20 |
| `aliases` | string[] | frontmatter (markdown) | 10 |
| `title` | string | frontmatter (markdown) | — |
| `links` | string[] | wikilinks (markdown) | 20 |

`buildContextPrefix` appends (only when non-empty, in this order, after existing fields): `Title:`, `Tags: x, y`, `Aliases: …`, `Links: a, b`, `Labels: eq:foo`, and `Formulas:` — formulas rendered whitespace-collapsed, ` | `-joined, each ≤300 chars, max 5 in the prefix, total added prefix ≤1500 chars (hard guard). Chunk `content` stays **verbatim body text** — never canonicalized; the SOLE exception to verbatim is rule 4.2.1 (frontmatter block removed, values preserved in metadata + prefix). Canonical form exists ONLY in `content_tokenized` and query terms.

### 4.6 `analyzeIndexableContent` / `chunkFile` routing

- `chunkFile`: add `else if (fileType === "latex") chunks = chunkLaTeX(content, filePath);` before the generic fallback.
- `analyzeIndexableContent`: no structural change needed — non-code types already fall through to `chunkFile`, which now routes latex. `extractSymbols` gains the latex branch (§5).

## 5. Specification — `src/indexer/symbols.ts`, `src/search/ranking.ts`

- `extractSymbols`: add `TEX_EXTENSIONS = new Set([".tex", ".ltx", ".latex"])`; branch calls new `extractLatexSymbols(content, filePath, fileType)`: one `heading` symbol per `\chapter/\section/\subsection/\subsubsection{Title}` line (name = title text, `metadata: { depth: 1..4 }`, `text` = full line) — mirrors `extractMarkdownSymbols` exactly. No `formula` symbols (non-goal).
- `ranking.ts` `FILE_TYPE_ALIASES`: add `tex: "latex", ltx: "latex", latex: "latex"` so `filters.file_type` normalization works.
- `ranking.ts` `documentationBoost`: treat `latex` exactly like `markdown` (change the early-return guard to `if (chunk.file_type !== "markdown" && chunk.file_type !== "latex") return 0;`). LaTeX papers ARE documentation; without this, guide-intent queries (`how to`, `guide`, …) would boost `.md` but not `.tex` for the same content. Path-based conditions (`readme`, `docs/`, …) apply unchanged.

## 6. Task Breakdown (execution order, each independently verifiable & committable)

| # | Task | Files | Acceptance criteria (all must pass) | Depends on |
|---|---|---|---|---|
| T1 | Math-text module: `MATH_UNICODE_MAP`, sup/sub direct folds, `canonicalizeMathText` (unicode map + caret-only marker rule) + fast-path | NEW `src/indexer/math-text.ts`, NEW `test/unit/math-text.test.ts` | (a) Every §3.2 test vector passes exactly; (b) identity fast-path: input with no math unicode and no `^` returns the `===` same string (incl. `snake_case_and_more`); (c) map is exactly 92 entries + 15 sup + 14 sub folds (assert counts in test); (d) loop test over every map entry: `canonicalizeMathText(entry.char)` output contains `entry.word`; every sup/sub fold char yields its `pow…`/`sub…` token; (e) `npm run check` + `typecheck` clean | — |
| T2 | Wire canonicalization into `preTokenizeForFTS` (one-line change) | `src/indexer/chunker.ts`, `test/unit/chunker.test.ts` | (a) All 7 existing `preTokenizeForFTS` tests pass **unchanged**; (b) new tests: `"x² + y²"` → contains `pow2` tokens; `"α ≤ β"` → contains `alpha`, `leq`; `"\alpha \leq \beta"` (LaTeX input) → contains `alpha`, `leq` (symmetry proof at unit level); (c) full unit suite green | T1 |
| T3 | Region scanner: `splitProtectedSegments` (+ all modes), `splitOversizedProtected`, fail-open rules | `src/indexer/math-text.ts`, `test/unit/math-text.test.ts` | (a) `$$` block containing a blank line → exactly ONE math segment spanning both lines; (b) unclosed `$$` → plain text, no math segment; (c) ```` ```math ```` fence → math segment; ```` ```js ```` fence with `|`-lines inside → ONE code segment, zero table segments; (d) 3-line pipe table → one table segment, correct line numbers; (e) `\begin{align}…\end{align}` in md and latex modes; (f) oversized align (>6000 chars, `\\`-separated rows) splits only at `\\`; oversized table splits only at row boundaries; (g) segments are contiguous & line numbers reconstruct the input exactly (property test on a composite fixture) | T1 |
| T4 | Metadata extractors: `parseFrontmatter`, `extractWikiLinks`, `extractTexLabels`, `extractDisplayFormulas` | `src/indexer/math-text.ts`, `test/unit/math-text.test.ts` | (a) valid frontmatter (title/tags list/aliases) parsed; malformed → empty + `bodyStartLine=1`; (b) `[[A]]`, `[[B|alias]]`, `[[C#sec]]` → `["A","B","C"]` deduped; caps enforced; (c) `\label{eq:mass}` → `["eq:mass"]`; (d) formulas extracted from math segments only, capped 10×2000 | T3 |
| T5 | `chunkMarkdown` rewrite (regions + frontmatter + wikilinks + formulas metadata) | `src/indexer/chunker.ts`, `test/unit/chunker.test.ts` | (a) **All existing `chunkMarkdown` tests pass unchanged**; (b) NEW: md with `$$` block containing blank line + text after → block lands intact inside exactly one chunk (`chunk.content` contains the full block verbatim, no `$$` fragment split across two chunks); (c) pipe table with >6000 chars → chunks split at row boundaries only (assert every chunk content starts with `|` or heading text); (d) frontmatter-stripped body chunks carry `tags`/`aliases`/`title` in `metadata_json` AND `Tags:`/`Title:` lines in `buildChunkEmbeddingText`; (e) wikilinks → `Links:` in embedding text; (f) `content_tokenized` of a `β`-chunk contains `beta` | T2, T4 |
| T6 | `chunkText` protection | `src/indexer/chunker.ts`, `test/unit/chunker.test.ts` | (a) existing `chunkText` tests pass unchanged; (b) `.txt` with `$$…blank…$$` → single intact chunk; (c) `formulas` metadata present | T5 |
| T7 | `chunkLaTeX` + `detectFileType` + `chunkFile` routing | `src/indexer/chunker.ts`, `test/unit/chunker.test.ts` | (a) `detectFileType("a.tex")` → `"latex"`; (b) small tex (preamble + 2 sections + `\begin{equation}` block with internal blank line) → ≥3 chunks; equation block intact in exactly one chunk verbatim; `breadcrumb` follows sections; preamble chunk labeled `Preamble`; (c) `chunkFile(content, "f.tex")` returns latex chunks (routing proof); (d) labels in `metadata_json` + `Labels:` prefix line | T5 |
| T8 | Symbols + filter aliases + doc boost | `src/indexer/symbols.ts`, `src/search/ranking.ts`, `test/unit/symbols.test.ts`, `test/unit/search.test.ts` (or ranking.test.ts where aliases live) | (a) tex with `\section{Methods}` → one `heading` symbol named `Methods`; (b) `normalizeFileTypeFilter("tex")` → `"latex"`; (c) guide-intent query diagnostics: `scoreChunkForQuery` on a latex chunk under `docs/` yields `documentation_boost === 0.35`, identical to a markdown chunk at the same path | T7 |
| T9 | End-to-end retrieval proof (unit level, engine-less) | `test/unit/search.test.ts` or new `test/unit/math-retrieval.test.ts` | Using a temp SQLite DB + FTS5 (pattern of existing `search.test.ts`): (a) index md doc containing `$$E = mc^2$$` + prose; query `"mc²"` in **fast** mode returns the chunk (cross-notation proof); (b) query `"α"` finds `\alpha` doc; (c) query `"x^2"` finds `x²` doc via token `pow2` (proves the canonicalize-last order: asserts the FTS term is `pow2`, not shredded `pow`); (d) query `"Ω"` finds `\Omega` doc (case-fold proof at FTS level — no reliance on FTS5 case-folding since canonical names are lowercase) | T5 |
| T10 | Docs & contracts | `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/chunking-strategies.md`, `docs/technical-decisions.md` | (a) AGENTS.md Extension Development gains one contract line: "Math/table-aware chunking is a behavior contract: display math (`$$`, ```math fences, `\begin{equation}`-family, `\[..\]`), pipe tables, and fenced code are atomic chunking units; `preTokenizeForFTS` canonicalizes math unicode (Greek, operators, sup/subscripts) symmetrically for index and query; markdown frontmatter (title/tags/aliases) and wikilinks become chunk metadata; `.tex` files are chunked as `latex` with section breadcrumbs and label metadata."; (b) README: math/science KB capability paragraph + `latex` file type in docs; (c) CHANGELOG entry; (d) chunking-strategies.md documents region rules + canonical map summary; (e) technical-decisions.md records: canonicalization-in-preTokenize decision + single-letter-variable limitation + pow/sub composite token rationale | T1-T9 |

### Commit plan (one logical change per commit, `feat:`/`docs:`)
1. `feat: add math text canonicalization and protected-region scanner` (T1–T4)
2. `feat: math and table aware markdown/text chunking with vault metadata` (T5–T6, T9)
3. `feat: latex-aware chunking, symbols, and file-type filters` (T7–T8)
4. `docs: document math-aware chunking contracts` (T10)

## 7. Verification Protocol (how "done" is judged against this plan)

**Hard gates (every gate must show output, not assumption):**
1. `npm run check` — zero warnings (repo gate).
2. `npm run typecheck` — clean.
3. `npm test` — ALL pass, including the 7 pre-existing `preTokenizeForFTS` tests and all pre-existing `chunkMarkdown`/`chunkText` tests **byte-identical expectations** (regression proof for non-math content).
4. `node --experimental-strip-types -e "import('./index.ts')"` — startup-light smoke passes (no new imports at root).
5. Spot-check diff review: `git diff` contains NO changes in `src/engine.ts`, `src/search/query.ts`, `src/search/bm25.ts`, `src/embedding/*`, `src/storage/*` (blast-radius guarantee). Only the files listed in §4–§5 + tests + docs change.

**Functional acceptance (each traced to a task criterion):** the table in §6 — every lettered criterion maps 1:1 to a named test; the implementation report must list criterion → test name → pass/fail.

**Dogfood (post-merge, recorded in report):** `pi -e ./index.ts` one-shot: `knowledge_add` a small md file with `$$…$$` + frontmatter + wikilinks; `knowledge_search` query using unicode math finds it; `knowledge_show` reports chunks. Not a release gate; a sanity check.

**Explicitly NOT claimed by completing Layer 1:** PDF formula extraction quality, formula-to-formula structural search, tags-as-filters, Obsidian mirror export.

## 8. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Canonicalization subtly alters non-math text | Low | Identity fast-path (§3.2.1) + unchanged existing tests as gate (§7.3) |
| `pow2`-style tokens pollute BM25 for code content (`x^2` in code fences gets canonicalized in FTS text) | Accepted | Tokens live only in `content_tokenized`, never in `content`; symmetric on query side; effect is extra matchability, ranked by BM25 IDF. ASCII `_` is exempt by design (snake_case safety). Monitor in dogfood; revert path = remove caret marker rule, keep unicode map |
| Frontmatter regex mis-parses exotic YAML | Low | Allowlist 3 keys, fail-open, `bodyStartLine` fallback |
| Region scanner false positives (e.g. `$$` in shell docs) | Medium | Fail-open on unclosed; `\$` escape rule; single-line `$$…$$` atomic anyway; worst case = one larger chunk (correctness preserved, recall slightly reduced) |
| Re-chunk changes hashes → re-embed of md/tex chunks after upgrade | Intended (mechanism verified) | `runUpdate` reuses vectors strictly by `content_hash`: changed hashes (new metadata keys, `latex` file_type, new line splits) miss the reuse map → re-embedded + old chunk IDs pruned via `idsToRemove`; unchanged hashes (all non-md/tex files: canonicalize fast-path is identity, metadata untouched) hit the reuse map → `unchanged++` with ZERO re-embed cost and vectors carried over. Symbols are replaced wholesale (`deleteSymbolsByKB` + `insertSymbols`). Document in CHANGELOG: run `knowledge_update` after upgrading; upgrade cost is bounded to md/tex files only |
| Embedding quality on raw LaTeX unchanged (canonical form is lexical-only) | Known | By design (§3.3); `Formulas:`/`Title:`/`Links:` context lines enrich embeddings; Layer 3 evaluates math embeddings separately |
| `pow2`/`sub1` composite tokens exist only from unicode folds and the caret rule; ASCII `a_1` vs `a₁` remains asymmetric | Known | Accepted limitation (§3.1): snake_case safety outweighs subscript symmetry; documented in technical-decisions.md (T10e) |

## 9. Effort Estimate

T1–T4: ~350 lines module + ~200 lines tests. T5–T7: ~180 lines chunker + ~180 lines tests. T8: ~30 lines. T9: ~80 lines. T10: docs. Total ≈ 1000 lines across 4 commits. Single focused implementation session; no schema migrations; no new dependencies (package.json untouched — production dep freeze respected).
