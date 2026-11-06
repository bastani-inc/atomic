/**
 * Updates test/helpers/test-file-durations.json, the per-file weights the sharded suites are ordered and sharded by
 * (see test/helpers/duration-sequencer.ts), from vitest JSON reports. `durationDrift` finds the files of one run that
 * strayed far from those weights; scripts/run-test-suite.ts warns about them on every CI shard.
 *
 *   bun run scripts/test-file-durations.ts [--os linux|win32] <report.json>...
 *
 * Pass the reports of recent CI runs, one per shard per run: the `test-diagnostics-*` artifacts of the
 * integration-tests, unit-tests and agent-suite jobs each hold one JSON report per suite. Without `--os`, each report's
 * OS comes from its artifact path (`linux-x64` or `windows-x64`). A file that appears in several reports of one OS gets
 * its mean duration, counting only the reports where it passed. Files the reports cover replace their old entries; entries for files that no longer exist are
 * dropped. An OS whose reports hold no test file, or a report whose OS is unknown, leaves the record untouched and
 * fails the command.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type FileDurations, UNKNOWN_FILE_MS } from "../test/helpers/duration-sequencer.js";

export interface VitestJsonReport {
	testResults: { name: string; startTime: number; endTime: number; status?: string }[];
}

/** A report path relative to the repository: the part from its first `test/` or `packages/<name>/test/` on. */
function repositoryPath(name: string): string | undefined {
	return /^.*?\/((?:packages\/[^/]+\/)?test\/.+\.(?:test|spec|suite)\.ts)$/u.exec(name.replaceAll("\\", "/"))?.[1];
}

/**
 * Mean duration in milliseconds of every test file in `reports`, keyed by repository-relative path. A file that failed
 * in a report is left out of it: its time is when it died or hit a timeout (a 9 s file reported 131 s), not what it
 * costs when it passes. Throws when the reports hold no test file: an empty record would weigh every file the same.
 */
export function testFileDurations(reports: readonly VitestJsonReport[]): Record<string, number> {
	const samples = new Map<string, number[]>();
	for (const report of reports) {
		for (const file of report.testResults) {
			const path = repositoryPath(file.name);
			if (path === undefined || file.status === "failed") continue;
			samples.set(path, [...(samples.get(path) ?? []), file.endTime - file.startTime]);
		}
	}
	if (samples.size === 0) throw new Error("the reports hold no test file; the record was left unchanged");
	return Object.fromEntries(
		[...samples].map(([path, values]) => [
			path,
			Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
		]),
	);
}

/**
 * How far a file's measured duration may stray from the weight the sequencer gave it before the record counts as
 * stale for it: at least `DRIFT_MIN_MS` and a factor of `DRIFT_RATIO` either way. One busy runner moves a file by
 * tens of percent, which only skews the balance; a new heavy file the record weighs as unknown, or a file that
 * gained or lost several cases, moves it by more.
 */
export const DRIFT_MIN_MS = 30_000;
export const DRIFT_RATIO = 2;

export interface DurationDrift {
	readonly path: string;
	readonly measuredMs: number;
	/** Undefined when the record has no entry for the file, which the sequencer then weighs as `UNKNOWN_FILE_MS`. */
	readonly recordedMs: number | undefined;
}

/** The files of `report` whose measured duration drifted from their weight in `durations`, largest drift first. */
export function durationDrift(report: VitestJsonReport, durations: FileDurations): DurationDrift[] {
	const drifted: DurationDrift[] = [];
	for (const file of report.testResults) {
		const path = repositoryPath(file.name);
		if (path === undefined) continue;
		const measuredMs = Math.round(file.endTime - file.startTime);
		if (!Number.isFinite(measuredMs)) continue;
		const recordedMs = durations[path];
		const weight = recordedMs ?? UNKNOWN_FILE_MS;
		const far = Math.abs(measuredMs - weight) >= DRIFT_MIN_MS;
		if (far && (measuredMs >= DRIFT_RATIO * weight || measuredMs * DRIFT_RATIO <= weight))
			drifted.push({ path, measuredMs, recordedMs });
	}
	const drift = ({ measuredMs, recordedMs }: DurationDrift) => Math.abs(measuredMs - (recordedMs ?? UNKNOWN_FILE_MS));
	return drifted.sort((a, b) => drift(b) - drift(a) || (a.path < b.path ? -1 : 1));
}

type RecordOs = "linux" | "win32";

/** The OS of a CI diagnostics report, from its artifact path. */
function reportOs(path: string): RecordOs | undefined {
	const normalized = path.replaceAll("\\", "/");
	if (normalized.includes("windows-x64")) return "win32";
	if (normalized.includes("linux-x64")) return "linux";
	return undefined;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const forced = args[0] === "--os" ? args[1] : undefined;
	const paths = forced === undefined ? args : args.slice(2);
	const usage = "usage: bun run scripts/test-file-durations.ts [--os linux|win32] <vitest JSON report>...";
	if ((args[0] === "--os" && forced !== "linux" && forced !== "win32") || paths.length === 0) {
		console.error(usage);
		process.exit(2);
	}
	const byOs = new Map<RecordOs, string[]>();
	for (const path of paths) {
		const os = (forced as RecordOs | undefined) ?? reportOs(path);
		if (os === undefined) {
			console.error(`test-file-durations: ${path} names no linux-x64 or windows-x64 artifact; pass --os\n${usage}`);
			process.exit(2);
		}
		byOs.set(os, [...(byOs.get(os) ?? []), path]);
	}
	const updates = new Map<RecordOs, Record<string, number>>();
	for (const [os, reports] of byOs) {
		try {
			updates.set(
				os,
				testFileDurations(reports.map((path) => JSON.parse(readFileSync(path, "utf8")) as VitestJsonReport)),
			);
		} catch (error) {
			console.error(`test-file-durations (${os}): ${(error as Error).message}`);
			process.exit(1);
		}
	}
	const root = new URL("../", import.meta.url);
	const output = new URL("test/helpers/test-file-durations.json", root);
	const record = JSON.parse(readFileSync(output, "utf8")) as Record<string, Record<string, number>>;
	for (const [os, durations] of updates) {
		const merged = { ...record[os], ...durations };
		record[os] = Object.fromEntries(
			Object.entries(merged)
				.filter(([path]) => existsSync(fileURLToPath(new URL(path, root))))
				.sort(([a], [b]) => (a < b ? -1 : 1)),
		);
		console.log(`Recorded ${Object.keys(durations).length} ${os} test files from ${byOs.get(os)!.length} report(s).`);
	}
	writeFileSync(output, `${JSON.stringify(record, null, "\t")}\n`);
}
