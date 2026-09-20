import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/unit/**/*.test.ts", "test/e2e/**/*.test.ts"],
		testTimeout: 15000,
		hookTimeout: 60000,
		// Each embedding-using test file forks a model worker (~hundreds of MB with ONNX loaded);
		// unbounded parallel forks thrash CPU/RAM and produce timeout cascades (the documented
		// flaky family). Six concurrent files keeps wall time reasonable without the storm.
		poolOptions: {
			forks: { maxForks: 4 },
		},
	},
});
