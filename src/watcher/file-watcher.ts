import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { createSkippedScanStats, iterateScannableFiles, type ScanOptions } from "../indexer/chunker.ts";

const watchers = new Map<string, FSWatcher>();
const pollers = new Map<string, ReturnType<typeof setInterval>>();
const snapshots = new Map<string, Map<string, string>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
// KBs whose scheduled update was rejected (overlapping in-flight run): the rejected caller
// indexed nothing, so when the in-flight run settles successfully its post-run scan must NOT
// be stored — the pending retry has to re-detect those changes against the old snapshot.
const pendingRetry = new Set<string>();
const DEBOUNCE_MS = 2000;
const POLL_MS = 2000;

function scheduleUpdate(
	kbId: string,
	dirPath: string,
	options: ScanOptions,
	onUpdate: (kbId: string) => unknown,
): void {
	if (debounceTimers.has(kbId)) return; // a pending update already fires soon and re-scans current state
	debounceTimers.set(
		kbId,
		setTimeout(() => {
			debounceTimers.delete(kbId);
			// A poller tick can queue a second update while the first is in-flight, re-detecting
			// against the STORED pre-change snapshot. By the time this timer fires, the in-flight
			// run has usually consumed that diff and stored a fresh snapshot — firing would be a
			// pure no-op ({added:0,removed:0,unchanged:N}). Re-diff before invoking: identical
			// ⇒ skip. pendingRetry entries ALWAYS fire (round-11 change-loss guarantee); a null
			// scan or a missing stored snapshot fails open (the no-op cannot be proven).
			const stored = snapshots.get(kbId);
			if (!pendingRetry.has(kbId) && stored) {
				const fresh = scanSnapshot(dirPath, options);
				if (fresh !== null && !snapshotsDiffer(stored, fresh)) return;
			}
			void Promise.resolve(onUpdate(kbId)).then(
				() => {
					// A rejected overlap during this run means the run's file scan predates changes
					// that arrived mid-flight: storing the fresh post-run scan would consume changes
					// the run never indexed. Skip the store; the poller re-detects against the old
					// snapshot and a clean update converges (then stores its own fresh snapshot).
					if (pendingRetry.delete(kbId)) return;
					// Skip re-adding when the watcher was stopped mid-flight (remove/clear/dispose)
					// — a dead KB must not regain state.
					if (watchers.has(kbId) || pollers.has(kbId)) {
						const fresh = scanSnapshot(dirPath, options);
						if (fresh) snapshots.set(kbId, fresh); // null scan → next poll re-checks
					}
				},
				() => {
					// Rejection: the overlapping caller indexed nothing. Request a retry once the
					// in-flight run settles, and keep the pre-change snapshot so the poller re-detects.
					pendingRetry.add(kbId);
				},
			);
		}, DEBOUNCE_MS),
	);
}

function checkForChanges(
	kbId: string,
	dirPath: string,
	options: ScanOptions,
	onUpdate: (kbId: string) => unknown,
): void {
	const previous = snapshots.get(kbId) ?? new Map<string, string>();
	const next = scanSnapshot(dirPath, options);
	// A null scan means the scan itself failed (transient FS race): treat the tick as "no change
	// detected" — keep the previous snapshot and try again on the next poll. Never throw here:
	// this runs inside timer callbacks where an exception would crash the host process.
	if (next === null || !snapshotsDiffer(previous, next)) return;
	// Deliberately NOT storing `next` here: scheduleUpdate stores the fresh snapshot after the
	// update settles. Storing it now would consume the change event even if the triggered update
	// never scans it (rejected, or coalesced into a run whose scan predates the change).
	scheduleUpdate(kbId, dirPath, options, onUpdate);
}

// Native FS events can storm (git checkout, npm install, build output). The expensive part is
// scanSnapshot (readdir + stat per file), so it must run at most once per quiet DEBOUNCE_MS
// window — schedule the CHECK, do the scan inside the timer.
function scheduleCheck(kbId: string, dirPath: string, options: ScanOptions, onUpdate: (kbId: string) => unknown): void {
	const existing = checkTimers.get(kbId);
	if (existing) clearTimeout(existing);
	checkTimers.set(
		kbId,
		setTimeout(() => {
			checkTimers.delete(kbId);
			checkForChanges(kbId, dirPath, options, onUpdate);
		}, DEBOUNCE_MS),
	);
}

function scanSnapshot(dirPath: string, options: ScanOptions = {}): Map<string, string> | null {
	const snapshot = new Map<string, string>();
	if (!existsSync(dirPath)) return snapshot;
	const skipped = createSkippedScanStats();
	try {
		for (const file of iterateScannableFiles(dirPath, skipped, options)) {
			try {
				const stat = statSync(file.path);
				snapshot.set(file.path, `${stat.mtimeMs}:${stat.size}`);
			} catch {
				/* file disappeared or is unreadable */
			}
		}
	} catch {
		// Scan-level failure (e.g. ignore-file race inside iterateScannableFiles): report null so
		// callers fail open ("no change this tick") instead of throwing from a timer callback.
		return null;
	}
	return snapshot;
}

function snapshotsDiffer(a: Map<string, string>, b: Map<string, string>): boolean {
	if (a.size !== b.size) return true;
	for (const [path, value] of a) {
		if (b.get(path) !== value) return true;
	}
	return false;
}

function startPoller(
	kbId: string,
	dirPath: string,
	onUpdate: (kbId: string) => unknown,
	options: ScanOptions = {},
): void {
	snapshots.set(kbId, scanSnapshot(dirPath, options) ?? new Map<string, string>());
	pollers.set(
		kbId,
		setInterval(() => {
			checkForChanges(kbId, dirPath, options, onUpdate);
		}, POLL_MS),
	);
}

export function startWatcher(
	kbId: string,
	dirPath: string,
	onUpdate: (kbId: string) => unknown,
	options: ScanOptions = {},
): void {
	stopWatcher(kbId);
	startPoller(kbId, dirPath, onUpdate, options);
	try {
		const watcher = watch(dirPath, { recursive: true }, () => {
			scheduleCheck(kbId, dirPath, options, onUpdate);
		});
		watcher.on("error", () => {
			// Close OUR instance, not whatever currently occupies the kbId slot: a queued error from
			// an old watcher must not tear down its replacement after a same-kbId restart.
			watcher.close();
			if (watchers.get(kbId) === watcher) watchers.delete(kbId);
		});
		watchers.set(kbId, watcher);
	} catch {
		/* polling fallback remains active */
	}
}

export function stopWatcher(kbId: string): void {
	watchers.get(kbId)?.close();
	watchers.delete(kbId);
	const poller = pollers.get(kbId);
	if (poller) {
		clearInterval(poller);
		pollers.delete(kbId);
	}
	snapshots.delete(kbId);
	pendingRetry.delete(kbId);
	const t = debounceTimers.get(kbId);
	if (t) {
		clearTimeout(t);
		debounceTimers.delete(kbId);
	}
	const c = checkTimers.get(kbId);
	if (c) {
		clearTimeout(c);
		checkTimers.delete(kbId);
	}
}

export function stopAllWatchers(): void {
	const ids = new Set([...watchers.keys(), ...pollers.keys()]);
	for (const id of ids) stopWatcher(id);
	for (const root of [...classRoots.keys()]) stopClassWatcher(root);
}

export function getActiveWatcherCount(): number {
	return new Set([...watchers.keys(), ...pollers.keys()]).size + classRoots.size;
}

// --- Layer 5: class-root watching (docs/class-hierarchy.md) ---
//
// A class root holds one KB per child directory, so the child KBs must not each install a
// watcher: N children would mean N recursive fs.watch handles and N 2s pollers, and the cost
// would grow with every conversation. Instead one watcher per ROOT walks the whole tree once
// per tick — the same walk the single pre-class KB already performed — and routes each
// changed file to the subclass that owns it by its first path segment. A tick therefore costs
// one directory walk regardless of subclass count, so the layer does not degrade as
// conversations accumulate.
//
// This is deliberately a separate mechanism from startWatcher: that one is coupled to a single
// KB's update lifecycle (snapshot-after-settle, pendingRetry on an in-flight run), and a class
// root has no update lifecycle of its own — it dispatches to several independent ones.

export interface ClassWatchHandlers {
	/** A direct child directory of the root appeared. */
	onNewChild: (childName: string, childPath: string) => unknown;
	/** Files under an already-known child changed. */
	onChildChanged: (childPath: string) => unknown;
	/** A known child directory disappeared. */
	onChildRemoved: (childName: string, childPath: string) => unknown;
}

interface ClassRootState {
	watcher: FSWatcher | undefined;
	poller: ReturnType<typeof setInterval> | undefined;
	checkTimer: ReturnType<typeof setTimeout> | undefined;
	snapshot: Map<string, string> | null;
	children: Set<string>;
}

const classRoots = new Map<string, ClassRootState>();

/** First path segment of `filePath` relative to `root` — the child directory that owns it. */
function childSegmentOf(root: string, filePath: string): string | undefined {
	const rel = relative(root, filePath);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	const segment = rel.split(sep)[0];
	return segment === "" || segment === "." ? undefined : segment;
}

function diffSnapshots(
	previous: Map<string, string>,
	next: Map<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
	const added: string[] = [];
	const changed: string[] = [];
	const removed: string[] = [];
	for (const [path, stamp] of next) {
		const before = previous.get(path);
		if (before === undefined) added.push(path);
		else if (before !== stamp) changed.push(path);
	}
	for (const path of previous.keys()) {
		if (!next.has(path)) removed.push(path);
	}
	return { added, changed, removed };
}

function checkClassRoot(root: string, handlers: ClassWatchHandlers): void {
	const state = classRoots.get(root);
	if (!state) return;
	const next = scanSnapshot(root);
	// Null scan = transient FS race. Keep the previous snapshot and retry next tick; never
	// throw, this runs inside a timer callback.
	if (next === null) return;
	const previous = state.snapshot ?? new Map<string, string>();
	if (state.snapshot !== null && !snapshotsDiffer(previous, next)) return;

	const { added, changed, removed } = diffSnapshots(previous, next);
	// Child segments present in the new snapshot, computed once: the naive form (a `.some()` over
	// every next-path inside the removed-loop) is O(n²) in tree size, and a class root grows with
	// every conversation.
	const presentChildren = new Set<string>();
	for (const path of next.keys()) {
		const segment = childSegmentOf(root, path);
		if (segment) presentChildren.add(segment);
	}
	const touchedChildren = new Set<string>();
	// `removed` belongs here too: deleting a file inside a live child is an ordinary edit that must
	// retract the orphaned chunks. Without it the snapshot diff knows about the deletion but no
	// child KB is ever updated, so the chunks stay searchable forever.
	for (const path of [...added, ...changed, ...removed]) {
		const segment = childSegmentOf(root, path);
		if (segment) touchedChildren.add(segment);
	}

	// Discover children that were only ever implied by the snapshot: a child whose files did not
	// change (empty dir, or one the ignore matcher skips) must still be reported once so its KB
	// gets created, otherwise a brand-new conversation would be invisible until it is written to.
	for (const path of added) {
		const segment = childSegmentOf(root, path);
		if (!segment) continue;
		if (!state.children.has(segment)) {
			state.children.add(segment);
			void Promise.resolve(handlers.onNewChild(segment, join(root, segment))).catch(() => {});
		}
	}
	// Order matters, and it is discover -> update -> forget. Updating before forgetting is what
	// lets a child whose LAST file was deleted retract its chunks: a child that empties is
	// indistinguishable from a vanished one, so onChildRemoved fires for it too, and if it ran
	// first the routing would already be gone by the time onChildChanged was reached.
	for (const segment of touchedChildren) {
		if (!state.children.has(segment)) continue;
		void Promise.resolve(handlers.onChildChanged(join(root, segment))).catch(() => {});
	}
	for (const path of removed) {
		const segment = childSegmentOf(root, path);
		// Only a disappearance of the whole child counts; a single deleted file inside a live
		// conversation is an ordinary edit and must not retract its KB.
		if (segment && !presentChildren.has(segment)) {
			state.children.delete(segment);
			void Promise.resolve(handlers.onChildRemoved(segment, join(root, segment))).catch(() => {});
		}
	}
	// Stored unconditionally after dispatch: each dispatch is a content-hash reconciled update
	// that re-reads the current state, and the per-KB pendingRetry machinery owns the
	// change-loss guarantee for a child KB that is mid-update.
	state.snapshot = next;
}

function scheduleClassCheck(root: string, handlers: ClassWatchHandlers): void {
	const state = classRoots.get(root);
	if (!state) return;
	if (state.checkTimer) clearTimeout(state.checkTimer);
	state.checkTimer = setTimeout(() => {
		const live = classRoots.get(root);
		if (live) live.checkTimer = undefined;
		checkClassRoot(root, handlers);
	}, DEBOUNCE_MS);
}

export function startClassWatcher(root: string, knownChildren: Iterable<string>, handlers: ClassWatchHandlers): void {
	stopClassWatcher(root);
	const state: ClassRootState = {
		watcher: undefined,
		poller: undefined,
		checkTimer: undefined,
		snapshot: scanSnapshot(root),
		children: new Set(knownChildren),
	};
	classRoots.set(root, state);
	state.poller = setInterval(() => {
		checkClassRoot(root, handlers);
	}, POLL_MS);
	try {
		const watcher = watch(root, { recursive: true }, () => {
			scheduleClassCheck(root, handlers);
		});
		watcher.on("error", () => {
			watcher.close();
			const live = classRoots.get(root);
			if (live?.watcher === watcher) live.watcher = undefined;
		});
		state.watcher = watcher;
	} catch {
		/* polling fallback remains active */
	}
}

export function stopClassWatcher(root: string): void {
	const state = classRoots.get(root);
	if (!state) return;
	state.watcher?.close();
	if (state.poller) clearInterval(state.poller);
	if (state.checkTimer) clearTimeout(state.checkTimer);
	classRoots.delete(root);
}

export function getClassRootCount(): number {
	return classRoots.size;
}
