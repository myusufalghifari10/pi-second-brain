import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { createSkippedScanStats, iterateScannableFiles, type ScanOptions } from "../indexer/chunker.ts";

const watchers = new Map<string, FSWatcher>();
const pollers = new Map<string, ReturnType<typeof setInterval>>();
const snapshots = new Map<string, Map<string, string>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
			void Promise.resolve(onUpdate(kbId)).then(
				() => {
					// Advance the stored snapshot ONLY after a successful update. While it runs, the
					// stored pre-change snapshot keeps the poller re-detecting, so a change whose
					// update was rejected (overlapping mutation) or coalesced into a stale in-flight
					// run is re-triggered instead of being silently lost. On rejection the snapshot
					// stays untouched and the next poll retries.
					snapshots.set(kbId, scanSnapshot(dirPath, options));
				},
				() => {}, // rejection: keep the pre-change snapshot so the next poll re-detects
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
	if (!snapshotsDiffer(previous, next)) return;
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

function scanSnapshot(dirPath: string, options: ScanOptions = {}): Map<string, string> {
	const snapshot = new Map<string, string>();
	if (!existsSync(dirPath)) return snapshot;
	const skipped = createSkippedScanStats();
	for (const file of iterateScannableFiles(dirPath, skipped, options)) {
		try {
			const stat = statSync(file.path);
			snapshot.set(file.path, `${stat.mtimeMs}:${stat.size}`);
		} catch {
			/* file disappeared or is unreadable */
		}
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
	snapshots.set(kbId, scanSnapshot(dirPath, options));
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
			watchers.get(kbId)?.close();
			watchers.delete(kbId);
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
