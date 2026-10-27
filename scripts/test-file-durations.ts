/**
 * Updates one OS's section of test/helpers/test-file-durations.json, the per-file weights the sharded suites are
 * ordered and sharded by (see test/helpers/duration-sequencer.ts), from vitest JSON reports.
 *
 *   bun run scripts/test-file-durations.ts --os linux|win32 <report.json>...
 *
 * Pass that OS's reports from recent CI runs, one per shard per run: the `test-diagnostics-*` artifacts of the
 * integration-tests, unit-tests and agent-suite jobs each hold one JSON report per suite. A file that appears in
 * several reports gets its mean duration. Files the reports cover replace their old entries; entries for files that
 * no longer exist are dropped. Reports that hold no test file leave the record untouched and fail the command.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface VitestJsonReport {
	testResults: { name: string; startTime: number; endTime: number }[];
}

/** A report path relative to the repository: the part from its first `test/` or `packages/<name>/test/` on. */
function repositoryPath(name: string): string | undefined {
	return /^.*?\/((?:packages\/[^/]+\/)?test\/.+\.(?:test|spec|suite)\.ts)$/u.exec(name.replaceAll("\\", "/"))?.[1];
}

/**
 * Mean duration in milliseconds of every test file in `reports`, keyed by repository-relative path. Throws when the
 * reports hold no test file: an empty record would weigh every file the same.
 */
export function testFileDurations(reports: readonly VitestJsonReport[]): Record<string, number> {
	const samples = new Map<string, number[]>();
	for (const report of reports) {
		for (const file of report.testResults) {
			const path = repositoryPath(file.name);
			if (path === undefined) continue;
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

if (import.meta.main) {
	const [flag, os, ...paths] = process.argv.slice(2);
	if (flag !== "--os" || (os !== "linux" && os !== "win32") || paths.length === 0) {
		console.error("usage: bun run scripts/test-file-durations.ts --os linux|win32 <vitest JSON report>...");
		process.exit(2);
	}
	let durations: Record<string, number>;
	try {
		durations = testFileDurations(paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as VitestJsonReport));
	} catch (error) {
		console.error(`test-file-durations: ${(error as Error).message}`);
		process.exit(1);
	}
	const root = new URL("../", import.meta.url);
	const output = new URL("test/helpers/test-file-durations.json", root);
	const record = JSON.parse(readFileSync(output, "utf8")) as Record<string, Record<string, number>>;
	const merged = { ...record[os], ...durations };
	record[os] = Object.fromEntries(
		Object.entries(merged)
			.filter(([path]) => existsSync(fileURLToPath(new URL(path, root))))
			.sort(([a], [b]) => (a < b ? -1 : 1)),
	);
	writeFileSync(output, `${JSON.stringify(record, null, "\t")}\n`);
	console.log(`Recorded ${Object.keys(durations).length} ${os} test files from ${paths.length} report(s).`);
}
