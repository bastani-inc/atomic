/**
 * Rewrites test/helpers/integration-file-durations.json, the per-file weights the integration suite is ordered and
 * sharded by (see test/helpers/duration-sequencer.ts), from vitest JSON reports.
 *
 *   bun run scripts/integration-file-durations.ts <report.json>...
 *
 * Pass the Linux integration reports from one CI run, one per shard: download the
 * `test-diagnostics-integration-tests-linux-x64-*` artifacts and give it each `integration-tests-*.json`. A file
 * that appears in several reports gets its mean duration.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface VitestJsonReport {
	testResults: { name: string; startTime: number; endTime: number }[];
}

const reports = process.argv.slice(2);
if (reports.length === 0) {
	console.error("usage: bun run scripts/integration-file-durations.ts <vitest JSON report>...");
	process.exit(2);
}
const samples = new Map<string, number[]>();
for (const report of reports) {
	const parsed = JSON.parse(readFileSync(report, "utf8")) as VitestJsonReport;
	for (const file of parsed.testResults) {
		const path = /(?:^|\/)(test\/integration\/.+)$/u.exec(file.name.replaceAll("\\", "/"))?.[1];
		if (path === undefined) continue;
		samples.set(path, [...(samples.get(path) ?? []), file.endTime - file.startTime]);
	}
}
const durations = Object.fromEntries(
	[...samples]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([path, values]) => [path, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)]),
);
const output = new URL("../test/helpers/integration-file-durations.json", import.meta.url);
writeFileSync(output, `${JSON.stringify(durations, null, "\t")}\n`);
console.log(`Recorded ${samples.size} integration files from ${reports.length} report(s).`);
