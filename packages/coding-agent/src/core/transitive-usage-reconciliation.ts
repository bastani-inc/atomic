import type { Usage } from "@earendil-works/pi-ai/compat";
import type { DescendantUsageContribution, DescendantUsageReport } from "./transitive-usage.ts";
import { mergeStringArrays, sessionFileAliases, sharesSessionFileAlias } from "./transitive-usage-aliases.ts";

export function coalesceCompleteReconciliationReports(
	reports: readonly DescendantUsageReport[],
	knownContributions: readonly DescendantUsageContribution[],
	addUsage: (left: Usage, right: Usage) => Usage,
): DescendantUsageReport[] {
	const pending = [...reports];
	const coalesced: DescendantUsageReport[] = [];
	for (const known of knownContributions) {
		const knownAliases = sessionFileAliases(known);
		if (knownAliases.size < 2) continue;
		const matches = pending.filter((report) => sharesSessionFileAlias(known, report));
		if (matches.length < 2 || !reportsPartitionAliases(matches, knownAliases)) continue;
		for (const match of matches) pending.splice(pending.indexOf(match), 1);
		let usage = matches[0]!.usage;
		for (const match of matches.slice(1)) usage = addUsage(usage, match.usage);
		const sessionFile = known.sessionFile ?? matches.find((report) => report.sessionFile !== undefined)?.sessionFile;
		const allSessionFiles = matches.flatMap((report) => [report.sessionFile, ...(report.sessionFiles ?? [])])
			.filter((value): value is string => value !== undefined && value !== sessionFile);
		coalesced.push({
			...matches[0]!,
			childRunId: known.childRunId,
			kind: known.kind,
			usage,
			settled: matches.every((report) => report.settled),
			label: known.label ?? matches[0]!.label,
			sessionFile,
			sessionFiles: mergeStringArrays(known.sessionFiles, allSessionFiles),
		});
	}
	return [...pending, ...coalesced];
}

function reportsPartitionAliases(reports: readonly DescendantUsageReport[], expected: ReadonlySet<string>): boolean {
	const seen = new Set<string>();
	for (const report of reports) {
		const aliases = sessionFileAliases(report);
		if (aliases.size === 0) return false;
		for (const alias of aliases) {
			if (!expected.has(alias) || seen.has(alias)) return false;
			seen.add(alias);
		}
	}
	return expected.size === seen.size;
}
