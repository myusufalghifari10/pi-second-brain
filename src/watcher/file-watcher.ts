import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { createSkippedScanStats, iterateScannableFiles, type ScanOptions } from "../indexer/chunker.ts";

const watchers = new Map<string, FSWatcher>();
const pollers = new Map<string, ReturnType<typeof setInterval>>();
const snapshots = new Map<string, Map<string, string>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 2000;
const POLL_MS = 2000;

function scheduleUpdate(kbId: string, onUpdate: (kbId: string) => void): void {
	const existing = debounceTimers.get(kbId);
	if (existing) clearTimeout(existing);
	debounceTimers.set(
		kbId,
		setTimeout(() => {
			debounceTimers.delete(kbId);
			onUpdate(kbId);
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

function startPoller(kbId: string, dirPath: string, onUpdate: (kbId: string) => void, options: ScanOptions = {}): void {
	snapshots.set(kbId, scanSnapshot(dirPath, options));
	pollers.set(
		kbId,
		setInterval(() => {
			const previous = snapshots.get(kbId) ?? new Map<string, string>();
			const next = scanSnapshot(dirPath, options);
			if (snapshotsDiffer(previous, next)) {
				snapshots.set(kbId, next);
				scheduleUpdate(kbId, onUpdate);
			}
		}, POLL_MS),
	);
}

export function startWatcher(
	kbId: string,
	dirPath: string,
	onUpdate: (kbId: string) => void,
	options: ScanOptions = {},
): void {
	stopWatcher(kbId);
	startPoller(kbId, dirPath, onUpdate, options);
	try {
		const watcher = watch(dirPath, { recursive: true }, () => {
			const previous = snapshots.get(kbId) ?? new Map<string, string>();
			const next = scanSnapshot(dirPath, options);
			if (!snapshotsDiffer(previous, next)) return;
			snapshots.set(kbId, next);
			scheduleUpdate(kbId, onUpdate);
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
}

export function stopAllWatchers(): void {
	const ids = new Set([...watchers.keys(), ...pollers.keys()]);
	for (const id of ids) stopWatcher(id);
}

export function getActiveWatcherCount(): number {
	return new Set([...watchers.keys(), ...pollers.keys()]).size;
}
