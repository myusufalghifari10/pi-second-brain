import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
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
}

export function getActiveWatcherCount(): number {
	return new Set([...watchers.keys(), ...pollers.keys()]).size;
}
