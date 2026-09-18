import { createHash } from "node:crypto";

// Pure label-graph resolution (L4 plan §3.5): a LaTeX label is scoped to the file that defines it.
// candidatePaths lists the files known to define `label`. A same-file definition wins; otherwise a
// unique cross-file definition resolves; a label defined in > 1 other files (collision) or zero
// matches stays unresolved — never guessed.
// Scope-key convention (repo-wide): sha256(relPath + "\0" + label).

export interface LabelResolution {
	/** "resolved" when exactly one defining file was selected under the scoping rule. */
	status: "resolved" | "unresolved";
	/** Defining file (normalized relative path) when resolved; null when unresolved. */
	targetPath: string | null;
	/** sha256(relPath + "\0" + label) of the referencing file; stable edge scope key. */
	scopeKey: string;
}

function normalizePath(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function resolveLabelTarget(
	filePath: string,
	label: string,
	candidatePaths: readonly string[],
): LabelResolution {
	const relPath = normalizePath(filePath);
	const trimmedLabel = label.trim();
	const scopeKey = createHash("sha256").update(`${relPath}\0${trimmedLabel}`).digest("hex");
	const candidates = [...new Set(candidatePaths.map(normalizePath).filter((p) => p.length > 0))];
	const unresolved: LabelResolution = { status: "unresolved", targetPath: null, scopeKey };
	if (trimmedLabel.length === 0 || candidates.length === 0) return unresolved;
	const sameFile = candidates.find((p) => p === relPath);
	if (sameFile !== undefined) return { status: "resolved", targetPath: sameFile, scopeKey };
	if (candidates.length > 1) return unresolved; // collision — never guessed
	const unique = candidates[0];
	if (unique === undefined) return unresolved;
	return { status: "resolved", targetPath: unique, scopeKey };
}
