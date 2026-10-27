/**
 * Rewrites one OS's section of test/helpers/integration-file-durations.json, the per-file weights the integration
 * suite is ordered and sharded by (see test/helpers/duration-sequencer.ts), from vitest JSON reports.
 *
 *   bun run scripts/integration-file-durations.ts --os linux|win32 <report.json>...
 *
 * Pass that OS's integration reports from recent CI runs, one per shard per run: download the
 * `test-diagnostics-integration-tests-<linux-x64|windows-x64>-*` artifacts and give it each `integration-tests-*.json`.
 * A file that appears in several reports gets its mean duration. Reports that hold no integration file leave the
 * record untouched and fail the command.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface VitestJsonReport {
	testResults: { name: string; startTime: number; endTime: number }[];
}

/**
 * Mean duration in milliseconds of every integration file in `reports`, keyed by repository-relative path. Throws
 * when the reports hold no integration file: an empty record would weigh every file the same.
 */
export function integrationFileDurations(reports: readonly VitestJsonReport[]): Record<string, number> {
	const samples = new Map<string, number[]>();
	for (const report of reports) {
		for (const file of report.testResults) {
			const path = /(?:^|\/)(test\/integration\/.+)$/u.exec(file.name.replaceAll("\\", "/"))?.[1];
			if (path === undefined) continue;
			samples.set(path, [...(samples.get(path) ?? []), file.endTime - file.startTime]);
		}
	}
	if (samples.size === 0) throw new Error("the reports hold no integration test file; the record was left unchanged");
	return Object.fromEntries(
		[...samples]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([path, values]) => [path, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)]),
	);
}

if (import.meta.main) {
	const [flag, os, ...paths] = process.argv.slice(2);
	if (flag !== "--os" || (os !== "linux" && os !== "win32") || paths.length === 0) {
		console.error("usage: bun run scripts/integration-file-durations.ts --os linux|win32 <vitest JSON report>...");
		process.exit(2);
	}
	let durations: Record<string, number>;
	try {
		durations = integrationFileDurations(
			paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as VitestJsonReport),
		);
	} catch (error) {
		console.error(`integration-file-durations: ${(error as Error).message}`);
		process.exit(1);
	}
	const output = new URL("../test/helpers/integration-file-durations.json", import.meta.url);
	const record = JSON.parse(readFileSync(output, "utf8")) as Record<string, Record<string, number>>;
	record[os] = durations;
	writeFileSync(output, `${JSON.stringify(record, null, "\t")}\n`);
	console.log(`Recorded ${Object.keys(durations).length} ${os} integration files from ${paths.length} report(s).`);
}
