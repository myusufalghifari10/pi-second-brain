import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";

// Pin for the round-14 fix: a vector WRITER whose close() fails (header flush ENOSPC/EIO) must
// fail the update on the success path. The pre-fix behavior swallowed the close error, renamed
// the placeholder-header replacement file into place, and reported success — silently disabling
// semantic search for the KB until the next update's self-heal.

let failWriterClose = false;
let _writerInstances = 0;

vi.mock("../../src/embedding/vectors.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/embedding/vectors.ts")>();
	return {
		...actual,
		openVectorWriter(path: string) {
			const writer = actual.openVectorWriter(path);
			_writerInstances++;
			if (!failWriterClose) return writer;
			return {
				append: (vectors: Float32Array[]) => writer.append(vectors),
				close: () => {
					throw new Error("EIOSIM: header flush failed");
				},
			};
		},
	};
});

describe("update fails loudly when the vector writer cannot close", () => {
	let TEST_DIR: string;
	let engine: KnowledgeEngine;

	beforeEach(async () => {
		TEST_DIR = mkdtempSync(join(tmpdir(), "pk-test-writer-close-"));
		engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
		_writerInstances = 0;
		failWriterClose = false;
	});

	afterEach(async () => {
		await engine.dispose({ disposeModels: true });
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("rejects the update and keeps the old vector file when the rebuild writer close fails", async () => {
		const filePath = join(TEST_DIR, "close-fail.txt");
		writeFileSync(filePath, "Writer close failure content about authentication tokens.");
		await engine.add(filePath, "Writer Close Fail");
		const before = engine.list()[0];
		expect(before.chunk_count).toBeGreaterThan(0);

		failWriterClose = true; // only the update's rebuild writer (instance #2) fails to close
		writeFileSync(filePath, "Changed WriterCloseToken content about authentication tokens.");
		await expect(engine.update("Writer Close Fail")).rejects.toThrow(/EIOSIM/);

		const [after] = engine.list();
		// Honest failure: KB flipped to error (real corruption class), old vector file intact,
		// chunk counts untouched — the pre-update index is fully preserved.
		expect(after.status).toBe("error");
		expect(after.chunk_count).toBe(before.chunk_count);
		// No temp replacement file leaked next to the live vector file; the live one still exists.
		const vectorsDir = join(TEST_DIR, "vectors");
		expect(readdirSync(vectorsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(existsSync(join(vectorsDir, `${after.id}.bin`))).toBe(true);
	});
});
