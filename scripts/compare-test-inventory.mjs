#!/usr/bin/env node
/**
 * Prove a test-runner migration did not quietly shed coverage.
 *
 * "The suite is green" is not the property that matters here: a file that stops
 * being collected, a `describe` that stops registering, or a rename that drops a
 * case all leave a green suite with fewer tests in it. The gate is a *set diff of
 * test names* in both directions, plus a floor on the total.
 *
 * Two deliberate choices:
 *
 *   - The diff is on the test name alone, never on `file + name`. Bun attributes
 *     tests re-exported through a barrel file to the *importing* file, so ~67
 *     files' attribution legitimately changes under vitest. Diffing on file+name
 *     would drown the real signal in that expected improvement.
 *   - A rename is not a wash. Comparing counts would pass two compensating
 *     errors, so every rename must appear in --allow-renamed as an explicit
 *     `old => new` pair and is echoed into the report for review.
 *
 * Usage:
 *   node scripts/compare-test-inventory.mjs \
 *     --baseline <bun-stdout.log> --candidate <vitest-report.json> \
 *     [--min 4417] [--allow-renamed "old => new"]...
 */
import { readFileSync } from "node:fs";

const ANSI = /\u001b\[[0-9;]*m/g;
/** Bun's per-test record, with or without the trailing `[Nms]` duration. */
const BUN_RECORD = /^\((pass|fail|skip)\)\s+(.+?)(?:\s+\[[0-9.]+ms\])?$/u;

/** Every distinct test name Bun's reporter printed. */
export function baselineNames(output) {
	const names = new Set();
	for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
		const match = BUN_RECORD.exec(raw.trim());
		if (match?.[2]) names.add(match[2]);
	}
	return names;
}

/** Every distinct test name in a vitest JSON report, as `scope > name`. */
export function candidateNames(json) {
	const report = JSON.parse(json);
	const names = new Set();
	for (const result of report.testResults ?? []) {
		for (const assertion of result.assertionResults ?? []) {
			const parts = [...(assertion.ancestorTitles ?? []), assertion.title ?? ""].filter((part) => part !== "");
			names.add(parts.join(" > "));
		}
	}
	return names;
}

/** Names a vitest report marks as skipped, so a skip cannot silently disappear. */
export function candidateSkipped(json) {
	const report = JSON.parse(json);
	const names = new Set();
	for (const result of report.testResults ?? []) {
		for (const assertion of result.assertionResults ?? []) {
			if (assertion.status !== "pending" && assertion.status !== "skipped" && assertion.status !== "todo") continue;
			const parts = [...(assertion.ancestorTitles ?? []), assertion.title ?? ""].filter((part) => part !== "");
			names.add(parts.join(" > "));
		}
	}
	return names;
}

function parseArgs(argv) {
	const options = { baseline: "", candidate: "", min: 0, renames: new Map(), expectSkipped: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--baseline") options.baseline = argv[++index];
		else if (arg === "--candidate") options.candidate = argv[++index];
		else if (arg === "--min") options.min = Number(argv[++index]);
		else if (arg === "--expect-skipped") options.expectSkipped.push(argv[++index]);
		else if (arg === "--allow-renamed") {
			const [from, to] = argv[++index].split("=>").map((part) => part.trim());
			if (!from || !to) throw new Error("--allow-renamed expects \"old => new\"");
			options.renames.set(from, to);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.baseline || !options.candidate) throw new Error("--baseline and --candidate are required");
	return options;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const before = baselineNames(readFileSync(options.baseline, "utf8"));
	const after = candidateNames(readFileSync(options.candidate, "utf8"));

	// A reviewed rename is applied to the baseline so the diff shows only the
	// cases nobody accounted for.
	const projected = new Set([...before].map((name) => options.renames.get(name) ?? name));

	const missing = [...projected].filter((name) => !after.has(name)).sort();
	const added = [...after].filter((name) => !projected.has(name)).sort();

	const lines = [
		`baseline distinct test names: ${before.size}`,
		`candidate distinct test names: ${after.size}`,
		`reviewed renames applied: ${options.renames.size}`,
		`missing under candidate: ${missing.length}`,
		`new under candidate: ${added.length}`,
	];
	for (const name of missing.slice(0, 50)) lines.push(`  - ${name}`);
	for (const name of added.slice(0, 50)) lines.push(`  + ${name}`);

	let failed = false;
	if (missing.length > 0) {
		lines.push(`FAIL: ${missing.length} test name(s) present in the baseline are absent from the candidate.`);
		failed = true;
	}
	if (after.size < options.min) {
		lines.push(`FAIL: ${after.size} distinct tests is below the frozen floor of ${options.min}.`);
		failed = true;
	}
	if (options.expectSkipped.length > 0) {
		const skipped = candidateSkipped(readFileSync(options.candidate, "utf8"));
		for (const name of options.expectSkipped) {
			if (skipped.has(name)) continue;
			lines.push(`FAIL: "${name}" was skipped in the baseline and must still be skipped, not dropped or silently enabled.`);
			failed = true;
		}
	}
	if (options.renames.size > 0) {
		lines.push("reviewed renames:");
		for (const [from, to] of options.renames) lines.push(`  ~ ${from} => ${to}`);
	}
	console.log(lines.join("\n"));
	process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
