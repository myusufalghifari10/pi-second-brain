#!/usr/bin/env node
// Fake PDF sidecar used by the pdf-sidecar unit tests (U1–U6) and the engine-level e2e
// tests (E1–E4). Never shipped or executed outside tests.
//
// Invocation shapes it must understand:
//   <script> --help                                  (detection probe: exit 0)
//   <script> <input.pdf> <output_dir>                (argv-template mode)
//   <script> <input.pdf> --output_dir <dir> ...      (marker built-in argv)
//   <script> <input.pdf> --to md --output <dir>      (docling built-in argv)
//
// Behavior knobs (environment variables):
//   FAKE_SIDECAR_MODE     ok (default) | fail | no_output | empty | nul | sleep
//   FAKE_SIDECAR_COUNTER  path of a JSON file counting executions; concurrent conversions
//                         track current/max overlap so tests can assert serialization.
//   FAKE_SIDECAR_ARGV     when set, conversion argv is mirrored here as JSON. The real
//                         argv record is written into the output dir, which convertPdf
//                         removes during cleanup — hence the mirror.
//   FAKE_SIDECAR_SLEEP_MS sleep duration for mode=sleep (default 5000).
//   FAKE_SIDECAR_IMAGES  path of an image file copied into the output dir as images/figure-1.png
//                        and images/figure-2.png (image-persistence tests), or the literal
//                        "missing" to emit the same image refs without copying any files.
//                        Unset (default) emits no image block — existing behavior untouched.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const input = argv[0] ?? "";
const flagValue = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
const outputDir = flagValue("--output_dir") ?? flagValue("--output") ?? argv[1];
const mode = process.env.FAKE_SIDECAR_MODE ?? "ok";

function readCounter() {
	try {
		return JSON.parse(readFileSync(process.env.FAKE_SIDECAR_COUNTER, "utf-8"));
	} catch {
		return { count: 0, maxOverlapping: 0, current: 0 };
	}
}

function writeCounter(state) {
	if (process.env.FAKE_SIDECAR_COUNTER) writeFileSync(process.env.FAKE_SIDECAR_COUNTER, JSON.stringify(state));
}

// Image block for the persistence tests: an image with alt text plus an adjacent caption line
// (never OCR-eligible) and an alt-less, blank-line-isolated image (OCR-eligible). With
// FAKE_SIDECAR_IMAGES="missing" the refs are emitted but no files are written, exercising the
// drop-missing-ref path.
function imageBlockLines() {
	const source = process.env.FAKE_SIDECAR_IMAGES;
	if (!source) return [];
	if (source !== "missing") {
		try {
			mkdirSync(join(outputDir, "images"), { recursive: true });
			const bytes = readFileSync(source);
			writeFileSync(join(outputDir, "images", "figure-1.png"), bytes);
			writeFileSync(join(outputDir, "images", "figure-2.png"), bytes);
		} catch {
			// copy failure degrades to refs-only; consumers must drop the missing files
		}
	}
	return [
		"## Figures",
		"",
		"![Linear actuator force diagram](images/figure-1.png)",
		"The figure one caption describes the linear actuator force diagram.",
		"",
		"![](images/figure-2.png)",
		"",
	];
}

if (argv.includes("--help")) {
	writeCounter({ ...readCounter(), count: readCounter().count + 1 });
	process.exit(0);
}

const state = readCounter();
state.count += 1;
state.current += 1;
state.maxOverlapping = Math.max(state.maxOverlapping, state.current);
writeCounter(state);

let exitCode = 0;
try {
	if (process.env.FAKE_SIDECAR_ARGV) writeFileSync(process.env.FAKE_SIDECAR_ARGV, JSON.stringify(argv));
	const writeMd = (text) => writeFileSync(join(outputDir, `${basename(input).replace(/\.pdf$/i, "")}.md`), text);
	if (mode === "fail") {
		console.error("fake sidecar simulated failure");
		exitCode = 3;
	} else {
		if (mode === "sleep") {
			await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_SIDECAR_SLEEP_MS ?? 5000)));
		}
		if (mode !== "no_output") {
			if (mode === "empty") {
				writeMd("short");
			} else if (mode === "nul") {
				writeMd(`This markdown output has valid length but carries a NUL byte\x00 inside the text body.`);
			} else {
				writeMd(
					[
						"# Relativity Primer",
						"",
						"## Section One",
						"",
						"Mass-energy equivalence is written as $$E = mc^2$$ in display math notation.",
						"",
						"| Quantity | Symbol |",
						"| --- | --- |",
						"| Energy | E |",
						"",
						...imageBlockLines(),
					].join("\n"),
				);
			}
		}
	}
} finally {
	const done = readCounter();
	done.current = Math.max(0, done.current - 1);
	writeCounter(done);
}
process.exit(exitCode);
