import type { ConfigLoadResult } from "./config-loader.js";
import type { DiscoveryResult } from "./discovery.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";

export function formatWorkflowResourceLoadWarning(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return [
		"Workflow discovery diagnostics: workflow resources could not be fully refreshed.",
		`- [error DISCOVERY_FAILED] workflow discovery: ${message}`,
		"Using the currently loaded workflow registry; run `/reload` after fixing the issue.",
	].join("\n");
}

export function formatWorkflowReloadReport(report: WorkflowReloadReport, reason?: string): string {
	const reasonSuffix = reason?.trim() ? ` (${reason.trim()})` : "";
	const headline =
		report.outcome === "applied"
			? `Reloaded workflow resources${reasonSuffix}. ${report.workflowCount} workflow(s), generation ${report.generation}.`
			: report.outcome === "failed"
				? `Workflow resources could not be refreshed; the current registry was retained: ${report.error}`
				: "Workflow reload was superseded by a newer session; no stale resources were applied.";
	if (report.diagnostics.length === 0) return headline;

	const lines = report.diagnostics.map(
		(diagnostic) =>
			`- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? `workflow ${diagnostic.phase}`}: ${diagnostic.message}`,
	);
	return [
		headline,
		`Workflow discovery diagnostics (${report.diagnostics.length}): some resources were skipped or need attention.`,
		...lines,
	].join("\n");
}

export function formatStartupDiagnostics(
	configResult: ConfigLoadResult | null,
	discoveryResult: DiscoveryResult | null,
): string | null {
	const lines: string[] = [];
	for (const diagnostic of configResult?.diagnostics ?? []) {
		lines.push(
			`- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? "workflow config"}: ${diagnostic.message}`,
		);
	}
	for (const diagnostic of discoveryResult?.errors ?? []) {
		lines.push(
			`- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? "workflow discovery"}: ${diagnostic.message}`,
		);
	}
	if (lines.length === 0) return null;
	const maxVisible = 8;
	const visible = lines.slice(0, maxVisible);
	const remaining = lines.length - visible.length;
	return [
		`Workflow discovery diagnostics (${lines.length}): some workflow resources were skipped or need attention.`,
		...visible,
		...(remaining > 0 ? [`- … ${remaining} more`] : []),
	].join("\n");
}
