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
});
