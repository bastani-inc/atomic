#!/usr/bin/env node
/**
 * Prove a test-runner or test-runtime change did not quietly shed coverage.
 *
 * "The suite is green" is not the property that matters here: a file that stops
 * being collected, a `describe` that stops registering, a rename that drops a
 * case, or a runtime that turns a test into a skip all leave a green suite with
 * less in it. The gate is a *set diff of test names* in both directions, a floor
 * on the total, and an explicit list of the skips that are allowed to stay.
 *
 * Three deliberate choices:
 *
 *   - The diff is on the test name alone, never on `file + name`. Bun attributes
 *     tests re-exported through a barrel file to the *importing* file, so ~67
 *     files' attribution legitimately changes under vitest. Diffing on file+name
 *     would drown the real signal in that expected improvement.
 *   - A rename is not a wash. Comparing counts would pass two compensating
 *     errors, so every rename must appear in --allow-renamed as an explicit
 *     `old => new` pair and is echoed into the report for review.
 *   - A suite may be *split* across runtimes without being split for this tool.
 *     `--candidate` is repeatable and the parts are unioned, because a file
 *     moved from a Node-hosted project to a Bun-hosted one has not lost a test
 *     -- but a file dropped from both has. Pointing this at one half only is how
 *     a split hides a loss, so the coding-agent suite must be compared as
 *     `--candidate agent.json --candidate agent-bun.json`.
 *
 * `--baseline` accepts either Bun's `bun test` stdout or a vitest JSON report,
 * detected by content. The pre-migration baseline is Bun stdout for the three
 * root suites; for packages/coding-agent it is a vitest report, because that
 * suite already ran vitest -- under `bun --bun` rather than under Node.
 *
 * Usage:
 *   node scripts/compare-test-inventory.mjs \
 *     --baseline <bun-stdout.log|vitest-report.json> \
 *     --candidate <vitest-report.json> [--candidate <more.json>]... \
 *     [--min 4417] [--allow-renamed "old => new"]... \
 *     [--expect-skipped "name"]... [--max-skipped N]
 */
import { readFileSync } from "node:fs";

const ANSI = /\u001b\[[0-9;]*m/g;
/** Bun's per-test record, with or without the trailing `[Nms]` duration. */
const BUN_RECORD = /^\((pass|fail|skip)\)\s+(.+?)(?:\s+\[[0-9.]+ms\])?$/u;
const SKIPPED = new Set(["pending", "skipped", "todo"]);

/** Every distinct test name Bun's reporter printed. */
export function bunNames(output) {
	const names = new Set();
	for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
		const match = BUN_RECORD.exec(raw.trim());
		if (match?.[2]) names.add(match[2]);
	}
	return names;
}

/** Every distinct test name Bun's reporter printed as skipped. */
export function bunSkipped(output) {
	const names = new Set();
	for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
		const match = BUN_RECORD.exec(raw.trim());
		if (match?.[1] === "skip" && match[2]) names.add(match[2]);
	}
	return names;
}

/** Qualified `scope > name` for one vitest assertion record. */
function qualify(assertion) {
	return [...(assertion.ancestorTitles ?? []), assertion.title ?? ""].filter((part) => part !== "").join(" > ");
}

/** Every distinct test name in a vitest JSON report, as `scope > name`. */
export function vitestNames(json) {
	const report = JSON.parse(json);
	const names = new Set();
	for (const result of report.testResults ?? []) {
		for (const assertion of result.assertionResults ?? []) names.add(qualify(assertion));
	}
	return names;
}

/** Names a vitest report marks as skipped, so a skip cannot silently appear. */
export function vitestSkipped(json) {
	const report = JSON.parse(json);
	const names = new Set();
	for (const result of report.testResults ?? []) {
		for (const assertion of result.assertionResults ?? []) {
			if (SKIPPED.has(assertion.status)) names.add(qualify(assertion));
		}
	}
	return names;
}

/**
 * Read one inventory file without being told which runner produced it.
 *
 * Requiring the caller to declare the format is one more thing to get wrong in
 * a command that is typed by hand during a migration, and getting it wrong
 * yields an empty set -- which reads as "everything is missing" or, worse for
 * the candidate side, as a clean sheet.
 */
export function readInventory(text) {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return { names: vitestNames(text), skipped: vitestSkipped(text), format: "vitest" };
	}
	return { names: bunNames(text), skipped: bunSkipped(text), format: "bun" };
}

/** Union several inventories, for a suite split across runtimes. */
export function unionInventories(inventories) {
	const names = new Set();
	const skipped = new Set();
	for (const inventory of inventories) {
		for (const name of inventory.names) names.add(name);
		for (const name of inventory.skipped) skipped.add(name);
	}
	return { names, skipped };
}

// Kept for callers that already imported the previous names.
export const baselineNames = bunNames;
export const candidateNames = vitestNames;
export const candidateSkipped = vitestSkipped;

export function parseArgs(argv) {
	const options = { baseline: "", candidates: [], min: 0, renames: new Map(), expectSkipped: [], maxSkipped: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--baseline") options.baseline = argv[++index];
		else if (arg === "--candidate") options.candidates.push(argv[++index]);
		else if (arg === "--min") options.min = Number(argv[++index]);
		else if (arg === "--max-skipped") options.maxSkipped = Number(argv[++index]);
		else if (arg === "--expect-skipped") options.expectSkipped.push(argv[++index]);
		else if (arg === "--allow-renamed") {
			const [from, to] = argv[++index].split("=>").map((part) => part.trim());
			if (!from || !to) throw new Error("--allow-renamed expects \"old => new\"");
			options.renames.set(from, to);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.baseline || options.candidates.length === 0) {
		throw new Error("--baseline and at least one --candidate are required");
	}
	return options;
}

/**
 * Compare two inventories and report every way the candidate lost ground.
 *
 * Separated from argument and file handling so the rules are unit-testable
 * without a fixture directory: this is the part that decides whether a
 * migration shipped.
 */
export function compareInventories(before, after, options = {}) {
	const { renames = new Map(), min = 0, expectSkipped = [], maxSkipped } = options;

	// A reviewed rename is applied to the baseline so the diff shows only the
	// cases nobody accounted for.
	const projected = new Set([...before.names].map((name) => renames.get(name) ?? name));
	const missing = [...projected].filter((name) => !after.names.has(name)).sort();
	const added = [...after.names].filter((name) => !projected.has(name)).sort();
	const projectedSkips = new Set([...before.skipped].map((name) => renames.get(name) ?? name));
	// A test that ran in the baseline and only skips now is the exact failure
	// this tool exists for, and it is invisible to a name diff and to a pass/fail
	// count alike.
	const newlySkipped = [...after.skipped].filter((name) => !projectedSkips.has(name)).sort();

	const lines = [
		`baseline distinct test names: ${before.names.size} (${before.skipped.size} skipped)`,
		`candidate distinct test names: ${after.names.size} (${after.skipped.size} skipped)`,
		`reviewed renames applied: ${renames.size}`,
		`missing under candidate: ${missing.length}`,
		`new under candidate: ${added.length}`,
		`newly skipped under candidate: ${newlySkipped.length}`,
	];
	for (const name of missing.slice(0, 50)) lines.push(`  - ${name}`);
	for (const name of added.slice(0, 50)) lines.push(`  + ${name}`);
	for (const name of newlySkipped.slice(0, 50)) lines.push(`  ~skip ${name}`);

	let failed = false;
	if (missing.length > 0) {
		lines.push(`FAIL: ${missing.length} test name(s) present in the baseline are absent from the candidate.`);
		failed = true;
	}
	if (newlySkipped.length > 0) {
		lines.push(`FAIL: ${newlySkipped.length} test(s) ran in the baseline and only skip now.`);
		failed = true;
	}
	if (after.names.size < min) {
		lines.push(`FAIL: ${after.names.size} distinct tests is below the frozen floor of ${min}.`);
		failed = true;
	}
	if (maxSkipped !== undefined && after.skipped.size > maxSkipped) {
		lines.push(`FAIL: ${after.skipped.size} skipped test(s) exceeds the ceiling of ${maxSkipped}.`);
		failed = true;
	}
	for (const name of expectSkipped) {
		if (after.skipped.has(name)) continue;
		lines.push(`FAIL: "${name}" was skipped in the baseline and must still be skipped, not dropped or silently enabled.`);
		failed = true;
	}
	if (renames.size > 0) {
		lines.push("reviewed renames:");
		for (const [from, to] of renames) lines.push(`  ~ ${from} => ${to}`);
	}
	return { failed, missing, added, newlySkipped, report: lines.join("\n") };
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const before = readInventory(readFileSync(options.baseline, "utf8"));
	const after = unionInventories(options.candidates.map((path) => readInventory(readFileSync(path, "utf8"))));
	const result = compareInventories(before, after, options);
	console.log(result.report);
	process.exit(result.failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
