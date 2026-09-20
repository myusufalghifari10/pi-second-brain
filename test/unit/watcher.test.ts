import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWatcher, stopAllWatchers } from "../../src/watcher/file-watcher.ts";

let testDir: string;

describe("file watcher exclusions", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		testDir = mkdtempSync(join(tmpdir(), "pk-test-watcher-"));
		mkdirSync(join(testDir, "node_modules"), { recursive: true });
		writeFileSync(join(testDir, "src.ts"), "export const WatchSource = 1;");
		writeFileSync(join(testDir, "node_modules", "pkg.js"), "export const IgnoredVendor = 1;");
	});

	afterEach(() => {
		stopAllWatchers();
		vi.useRealTimers();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("does not trigger updates for suggested-excluded files", async () => {
		const updates: string[] = [];
		startWatcher("kb", testDir, (kbId) => updates.push(kbId));

		writeFileSync(join(testDir, "node_modules", "pkg.js"), "export const IgnoredVendor = 2;");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(updates).toEqual([]);

		writeFileSync(join(testDir, "src.ts"), "export const WatchSource = 2;");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(updates).toEqual(["kb"]);
	});

	it("coalesces an event storm into a single update per quiet window", async () => {
		const updates: string[] = [];
		startWatcher("kb", testDir, (kbId) => updates.push(kbId));

		// Five rapid writes inside one quiet window: the expensive snapshot/diff must run at most
		// once (inside the check debounce), producing exactly one update after the update debounce.
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(testDir, "src.ts"), `export const WatchSource = ${i + 3};`);
		}
		await vi.advanceTimersByTimeAsync(2_500); // check debounce fires → snapshot diff → scheduleUpdate
		await vi.advanceTimersByTimeAsync(2_500); // update debounce fires

		expect(updates).toEqual(["kb"]);
	});

	it("retries a change whose update rejected instead of losing it", async () => {
		const updates: string[] = [];
		let failFirst = true;
		startWatcher("kb", testDir, (kbId) => {
			if (failFirst) {
				failFirst = false;
				return Promise.reject(new Error("overlapping mutation"));
			}
			updates.push(kbId);
			return Promise.resolve();
		});

		writeFileSync(join(testDir, "src.ts"), "export const WatchSource = 7;");
		await vi.advanceTimersByTimeAsync(2_500); // check fires → schedules update
		await vi.advanceTimersByTimeAsync(2_500); // update #1 rejects → snapshot must stay pre-change
		await vi.advanceTimersByTimeAsync(5_000); // poller re-detects the still-unindexed change → retry succeeds

		// The rejected attempt must NOT consume the change: the poller re-fires and succeeds.
		expect(updates).toEqual(["kb"]);
	});

	it("re-detects a change that landed while a successful update was still in flight", async () => {
		// The HIGH-loss class: change B arrives DURING update U1 (whose scan predates B). Overlap
		// attempts reject for as long as U1 runs; when U1 settles, the settle path must NOT store
		// a post-run scan (it includes B) — the poller must re-detect B and a clean update must
		// index it, and only then does the snapshot advance.
		const deferreds: Array<{ resolve: () => void }> = [];
		let calls = 0;
		let u1Settled = false;
		startWatcher("kb", testDir, () => {
			calls++;
			if (calls === 1) return new Promise<void>((resolve) => deferreds.push({ resolve })); // U1 in flight
			return u1Settled ? Promise.resolve() : Promise.reject(new Error('An update for "kb" is already running'));
		});

		writeFileSync(join(testDir, "a.ts"), "export const A = 1;");
		await vi.advanceTimersByTimeAsync(2_500); // check detects A → schedules update
		await vi.advanceTimersByTimeAsync(2_500); // U1 starts (deferred, in flight)
		expect(calls).toBe(1);

		writeFileSync(join(testDir, "b.ts"), "export const B = 2;");
		await vi.advanceTimersByTimeAsync(5_000); // overlap attempts fire while U1 runs → REJECT
		const callsAfterBAdvance = calls; // U1 + however many overlap attempts were rejected in-flight
		expect(callsAfterBAdvance).toBeGreaterThanOrEqual(2);

		deferreds[0]?.resolve(); // U1 settles successfully — must NOT consume B
		u1Settled = true; // subsequent scheduled updates run clean and store their post-run scan
		await vi.advanceTimersByTimeAsync(0); // flush settle microtasks
		await vi.advanceTimersByTimeAsync(5_000); // poller re-detects B → clean update runs
		// The HIGH-loss discriminator: a clean update MUST fire after U1 settles. Had the settle
		// path wrongly stored its post-run scan (which includes B), no further update would run
		// and B would stay unindexed forever.
		expect(calls).toBeGreaterThan(callsAfterBAdvance);
		const before = calls;
		await vi.advanceTimersByTimeAsync(10_000); // fully quiet afterwards: no retry loop
		expect(calls).toBe(before);
	});

	it("skips a queued second update whose diff the in-flight run already consumed", async () => {
		// F4: a poller tick while update #1 is in flight re-detects against the STORED pre-change
		// snapshot and queues update #2. Update #1 settles and stores the consumed snapshot, so
		// firing #2 would be a pure no-op ({added:0,removed:0,unchanged:N}) — the timer callback
		// must re-diff and skip it. pendingRetry entries would still fire (force-fire contract).
		const deferreds: Array<{ resolve: () => void }> = [];
		let calls = 0;
		startWatcher("kb", testDir, () => {
			calls++;
			if (calls === 1) return new Promise<void>((resolve) => deferreds.push({ resolve })); // update #1 in flight
			return Promise.resolve();
		});

		writeFileSync(join(testDir, "src.ts"), "export const WatchSource = 10;");
		await vi.advanceTimersByTimeAsync(2_500); // check (t=2) detects the change → schedules update #1
		await vi.advanceTimersByTimeAsync(2_500); // t=4: update #1 starts (deferred, in flight)
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(1_500); // t=6: poller re-detects against the stale stored snapshot → queues update #2
		deferreds[0]?.resolve(); // update #1 settles → stores the consumed (post-change) snapshot
		await vi.advanceTimersByTimeAsync(0); // flush settle microtasks
		await vi.advanceTimersByTimeAsync(4_000); // queued update #2 fires → re-diff identical → SKIPPED

		expect(calls).toBe(1);
	});
});
