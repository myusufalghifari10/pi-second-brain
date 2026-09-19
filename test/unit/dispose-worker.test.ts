import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";

// Pin the dispose({disposeModels}) worker-lifecycle contract: the default dispose tears the
// model worker down, while dispose({disposeModels:false}) intentionally keeps it warm. This
// contract escaped two audit rounds half-applied precisely because no test pinned it.
const shutdownSpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/model-worker-client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/model-worker-client.ts")>();
	return { ...actual, shutdownModelWorker: (...args: unknown[]) => shutdownSpy(...args) };
});

describe("KnowledgeEngine dispose worker lifecycle", () => {
	let TEST_DIR: string;
	let engine: KnowledgeEngine;

	beforeEach(async () => {
		TEST_DIR = mkdtempSync(join(tmpdir(), "pk-test-dispose-"));
		engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
		shutdownSpy.mockClear();
	});

	afterEach(async () => {
		await engine.dispose({ disposeModels: true });
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("keeps the model worker alive across dispose({disposeModels:false})", async () => {
		await engine.dispose({ disposeModels: false });
		expect(shutdownSpy).not.toHaveBeenCalled();
	});

	it("kills the model worker on default dispose()", async () => {
		await engine.dispose();
		expect(shutdownSpy).toHaveBeenCalledTimes(1);
	});
});
