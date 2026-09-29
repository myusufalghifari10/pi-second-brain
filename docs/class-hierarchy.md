# Class hierarchy — scoping a knowledge base into isolated subclasses

Status: implemented (schema v9)
Layer: 5 (follows `docs/layer2-pdf-sidecar-plan.md`, `docs/layer3-formula-retrieval-plan.md`, `docs/layer4-fidelity-breadth-plan.md`)

## Problem

Every knowledge base is one flat bag of chunks. `om-memory` indexes `~/.memory/`, which is
36 conversation directories — so a query about one conversation returns chunks from all of
them. The only correct isolation boundary today is `kb_id`, and a conversation is not a KB.

The obvious workaround, `path_pattern`, is a **post-retrieval** filter:

```ts
// src/engine.ts — Apply metadata filters post-retrieval
if (filters?.path_pattern && !chunk.file_path.includes(filters.path_pattern)) return false;
```

Candidates are retrieved globally, then non-matching ones are dropped. A conversation
holding 5 of 1,269 chunks loses every top-N candidate to the filter and returns **zero
results for content that is present**. That is the bug this layer removes rather than
works around.

## Decision: the subclass boundary is a knowledge base

Two designs were considered.

**A — subclass = one KB per child directory.** The boundary is `kb_id`, which is applied when
the KB list is selected (`availableKBs = kb_id ? [selectedKB] : listKBs(db)`) *before*
retrieval. Isolation is therefore already correct and needs no retrieval change.

**B — subclass = a `scope_path` column on chunks, pushed into the FTS and vector queries.**
One KB holds every subclass and retrieval is scoped at query time.

A was chosen. B is the more principled design and would also fix the `path_pattern` leak in
general, but it rewrites the query path — a substantially larger change than the problem
warrants. A is not a dead end: chunk content is re-derivable from source files, so the KBs
A produces can be collapsed back into one scoped KB later without data loss.

## Model

```
class     om                      → a set of knowledge bases
subclass  om-01a0e17a-fab7        → one KB = one child directory of the class root
```

The class **root** is a directory whose direct children are the subclasses. The root itself
is never a KB. For `~/.memory` the root is `~/.memory` and the 36 conversation directories
are the subclasses.

## Schema (migration v9)

Three additive nullable columns on `knowledge_bases`. No existing row is rewritten; a NULL
`class` means the KB predates this layer and behaves exactly as before.

| Column | Type | Meaning |
|---|---|---|
| `class` | TEXT | Class name, e.g. `om`. NULL for a standalone KB. |
| `class_root` | TEXT | Absolute path of the class root that owns this KB. |
| `last_searched_at` | INTEGER | Epoch ms of the last search that included this KB. NULL = never searched. |

`idx_kb_class` indexes `class`. `last_searched_at` is deliberately unindexed: it is only ever
read as a sort/compare in `knowledge_status`, never in a hot query.

## Operations

| Operation | Behaviour |
|---|---|
| `knowledge_class_sync(root=…, class=…)` | Reconciles the root: one KB per existing child directory, then indexes it. Idempotent. |
| Reconcile on a new child | The class watcher detects an unknown child directory and reconciles just that child. |
| Reconcile on process start | `startClassWatchers` fires a reconcile per registered root, catching conversations created while Pi was closed. Fire-and-forget with an `onLog` warn hook; a failure is reported, never swallowed. |
| Reconcile on a later start | Refreshes each child's derived `description` and its `.gitignore` inheritance. No re-embed, and it does not touch `updated_at`, so a description change is never reported as a reindex. |
| `knowledge_search(class=…)` | Restricts `availableKBs` before retrieval. Pushdown, not post-filter. |
| `knowledge_search(kb_ids=[…])` | Same, for an explicit subset. |
| `knowledge_search(kb_id=…)` | Existing single-KB scoping. The subclass boundary. |

KB naming is `om-<first 12 chars of the directory name>`. Deterministic and collision-free
for UUID session ids, and idempotent by construction: reconciling twice produces the same
name and the second pass is a no-op.

### Name collisions are a hard error, not a no-op

That guarantee holds for UUID directory names only. Two **hand-named** siblings sharing their
first 12 characters resolve to the same KB name, so `reconcileClassRoot` discriminates on
`source_path`, not on the name:

- same `source_path` → idempotent re-reconcile; refresh the description, report in `existing`
- different `source_path` → **collision**; report in `failed` with a message naming both
  directories, and index nothing for it

The second case used to report `existing` too, which parked the colliding directory without
indexing it and through no channel: silent data loss, visible only when a query for that topic
returned nothing much later. A collision is cheap to fix (rename one directory) and expensive
to miss, so it uses the existing per-child failure channel and does not abort the rest of the
class.

### Nested directories are deliberately not subclasses

`reconcileClassRoot` iterates depth 1 only (`entry.isDirectory()`), while the scanner recurses
into subdirectories. So `systems/compilers/` is **indexed into its parent's KB** but is not a KB
of its own.

This is the escape hatch that makes a coarse class cheap. Topical depth lives in the
filesystem and is free; only topics that have demonstrated they need isolation spend one of the
class's names on a KB. It also keeps the 12-character budget small enough that collisions are
rare by construction — and, for a hand-named class, a two-digit family prefix
(`01-networking-protocols`) makes uniqueness structural rather than a convention to remember.

`description` is derived from the child's `JOURNEY.md` or `STATE.md` — **not** from
`INDEX.md`. `INDEX.md` is orchestrator-rendered and its first line is the same
`# Memory index` for every conversation, so describing subclasses from it would make all 37
of them indistinguishable. A line must clear a 60-character floor so a bare date heading
(`## 2026-09-22`) is skipped; if neither file yields prose, the child hand-named topic files
are used instead (`topics: browser redesign`).

### Ignore inheritance

`buildIgnoreMatcher` reads only `join(dirPath, ".gitignore")`, so a scan rooted at a child
directory is blind to the rules in the class root's `.gitignore`. That is not cosmetic: for
the memory class the root file excludes `.runs/` (transient worker IPC), `INDEX.md` and
itself — and without inheritance **843 of those files were indexed across 37 subclasses**.

`ScanOptions.ignoreFrom` layers an ancestor `.gitignore` on top of the dir's own, the nearer
file first so a child can still re-include what a parent excluded.
`reconcileClassRoot` passes the root's `.gitignore` down, and `AddOptions.ignore_from` is
serialized into `source_options` so a `knowledge_update` round-trip keeps honouring it —
without that, a subclass would quietly start indexing `.runs/` on its second scan.

## Watching: one watcher per class root

`startWatcher` installs **two** live mechanisms per KB — a recursive `fs.watch` and a
`setInterval` poller at `POLL_MS = 2000`. Starting one per child would mean 38 pollers
instead of 2.

It is not needed. A class root gets exactly **one** watcher and one poller, and:

- `scanSnapshot(root)` already walks every child, so a changed file's path prefix identifies
  the owning subclass KB;
- the same walk sees a new child directory and triggers a reconcile for it;
- the poller cost is one directory walk per tick regardless of how many subclasses exist.

The startup reconcile is not redundant with the watcher, and the distinction is the whole
reason it exists. The watcher's first snapshot is taken at `session_start`, so a conversation
directory created while Pi was closed is **already in that baseline** — no diff will ever
report it, and without an explicit reconcile its content is permanently unindexed. `fs.watch`
does not help either: it only fires for changes that happen *after* it is installed.

`engine.ts` skips per-KB watcher startup for any KB that has a `class_root`, so a child KB
never installs a watcher of its own. Total watcher count is 1 per class root, independent of
subclass count — the layer does not degrade as subclasses accumulate.

### Deleting files inside a subclass

Deleting a file is an ordinary edit and retracts its chunks on the next tick. Deleting the
**last** file in a subclass is not: `update()` treats a zero-file scan against a populated KB as
a broken mount rather than an intentional deletion, and refuses to wipe the index. That guard
is deliberate — a vanished mount, a chmod'd directory and an offline network drive all look
identical to a real deletion — so the index keeps serving the last good content instead of
going dark. Emptying a subclass is therefore done with `knowledge_remove`, not by deleting
files.

The two dispatch loops in `checkClassRoot` are ordered **discover → update → forget** for the
same reason. A child that empties is indistinguishable from a child whose directory vanished,
so `onChildRemoved` fires for it too; if forgetting ran first, the routing entry would already
be gone by the time `onChildChanged` was reached and the retraction could never happen.

## Risks

| Risk | Mitigation |
|---|---|
| Snapshot walk of a large root on every 2s tick | Unchanged from today: the pre-existing `om-memory` KB walked the same tree from the same root. Cost is per-root, not per-child. |
| `fs.watch` recursive does not report a newly created directory on all platforms | The poller is authoritative; the watch is an accelerator. A missed event still reconciles on the next tick. |
| A child directory deleted out from under its KB | The KB's next update yields zero readable files. The existing guard at `engine.ts` (`scannedFiles === 0 && kb.chunk_count > 0`) aborts rather than wiping the index. |
| Partial writes in a conversation directory | Existing content-hash reconciliation: unchanged files stay `unchanged`, so a write storm costs one update, not a re-embed. |
| Migration of `om-memory` drops search continuity | Chunk content is re-derived from the same files. Chunk totals are compared before/after as the acceptance check. |
| Two classes sharing one directory | `class_root` is stored per KB, so roots are grouped by exact path; a class name is never inferred from a path. |

## Completion criteria

1. `npm run typecheck` clean.
2. `npm test` (unit) green — no existing test regresses.
3. A KB with NULL `class` is byte-identical in behaviour to one created before this layer.
4. `knowledge_search(kb_id=…)` on a subclass returns **only** that subclass, and a
   conversation's own content is retrievable even when it is a small minority of the class.
5. `knowledge_search(class=…)` spans every subclass of that class and excludes KBs of other
   classes.
6. `knowledge_status` shows `class`, `description`, and `last_searched_at` per KB.
7. After migration, subclass count equals child-directory count and total chunks match the
   pre-migration total.
