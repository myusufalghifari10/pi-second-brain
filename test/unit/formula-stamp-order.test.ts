import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";

// White-box ordering pin for the Layer 3 stamp contract: `markFormulaIndexBuilt` must fire
// strictly AFTER the last formula-row write (per-batch insertChunks) on the add success path.
// Hoisting the stamp beside startIndexingJob would leave crash-interrupted KBs with flag=1 and
// partial rows — disabling the backfill repair forever — while every position-invariant test
// stays green (this ordering pin is the only thing that fails on that regression).

const order: string[] = [];

vi.mock("../../src/storage/sqlite.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/storage/sqlite.ts")>();
	return {
		...actual,
		insertChunks(...args: unknown[]) {
			order.push("insertChunks");
			return (actual.insertChunks as (...a: unknown[]) => unknown)(...args);
		},
		markFormulaIndexBuilt(...args: unknown[]) {
			order.push("markFormulaIndexBuilt");
			return (actual.markFormulaIndexBuilt as (...a: unknown[]) => unknown)(...args);
		},
		markLabelGraphBuilt(...args: unknown[]) {
			order.push("markLabelGraphBuilt");
			return (actual.markLabelGraphBuilt as (...a: unknown[]) => unknown)(...args);
		},
	};
});

describe("formula index stamp ordering", () => {
	let TEST_DIR: string;
	let engine: KnowledgeEngine;

	beforeEach(async () => {
		TEST_DIR = mkdtempSync(join(tmpdir(), "pk-test-stamp-order-"));
		engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
		order.length = 0;
	});

	afterEach(async () => {
		await engine.dispose({ disposeModels: true });
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("stamps markFormulaIndexBuilt only after the final chunk write on a successful add", async () => {
		const filePath = join(TEST_DIR, "stamp-order.tex");
		writeFileSync(
			filePath,
			"\\section{Stamp Order}\nA proving paragraph with enough content to pass the minimum chunk size.\n$$E = mc^2$$\n",
		);

		await engine.add(filePath, "Stamp Order");

		const lastInsert = order.lastIndexOf("insertChunks");
		const stamp = order.lastIndexOf("markFormulaIndexBuilt");
		expect(lastInsert).toBeGreaterThan(-1);
		expect(stamp).toBeGreaterThan(lastInsert);
	});
});
