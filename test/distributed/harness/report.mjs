// @ts-check
/**
 * The run's evidence: a machine-readable `report.json` and a Markdown summary. Both are rendered from one report
 * object and pass through redaction before they are written, so no token or key can reach them.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./commands.mjs";

/**
 * @typedef {{ name: string, passed: boolean, expected: unknown, actual: unknown }} Invariant
 * @typedef {{ name: string, issue: string, status: "passed" | "failed" | "skipped" | "cancelled", reason?: import("./errors.mjs").SerializedError,
 *   invariants?: Invariant[], faults?: import("./suites.mjs").FaultRecord[], metrics?: Record<string, unknown> }} SuiteResult
 */

/**
 * The run's status from its parts: cancelled wins, then any failure, then passed.
 * @param {{ cancelled: boolean, error: unknown, suites: readonly SuiteResult[], coverage: readonly { status: string }[], teardownOk: boolean | null }} parts
 */
export function overallStatus({ cancelled, error, suites, coverage, teardownOk }) {
	if (cancelled) return "cancelled";
	if (error !== undefined) return "failed";
	if (suites.some((suite) => suite.status === "failed")) return "failed";
	if (coverage.some((item) => item.status === "incomplete" || item.status === "missing")) return "failed";
	if (teardownOk === false) return "failed";
	return "passed";
}

/**
 * Status of one suite from its invariants and faults.
 * @param {readonly Invariant[]} invariants
 * @param {readonly { error?: unknown }[]} faults
 * @returns {"passed" | "failed"}
 */
export function suiteStatus(invariants, faults) {
	return invariants.length > 0 &&
		invariants.every((item) => item.passed) &&
		faults.every((fault) => fault.error === undefined)
		? "passed"
		: "failed";
}

/** @param {unknown} value */
function cell(value) {
	return (typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
		.replaceAll("|", "\\|")
		.replaceAll("\n", " ");
}

/**
 * @param {Record<string, any>} report
 */
export function renderMarkdown(report) {
	const lines = [
		`# Distributed test run ${report.runId}`,
		"",
		`Status: **${report.status}**`,
		"",
		`- Ref: \`${report.replay?.ref}\` → \`${report.replay?.sha ?? "unresolved"}\``,
		`- Suite: \`${report.replay?.suite}\`, chaos: \`${report.replay?.chaos}\`, nodes: ${report.replay?.nodes}, regions: ${cell(report.replay?.regions)}`,
		`- Seed: ${report.replay?.seed} (${report.replay?.prng}); replay with \`node test/distributed/run.mjs --replay ${report.paths?.json ?? "report.json"}\``,
		`- Artifact SHA-256: \`${report.replay?.artifactDigest ?? "none"}\``,
		`- Database storage: ${report.replay?.dbStorage}${report.nvmeSkip ? ` (local NVMe skipped: ${report.nvmeSkip.code})` : ""}`,
		"",
	];
	if (report.error)
		lines.push("## Failure", "", `\`${report.error.name}\` (\`${report.error.code}\`): ${report.error.message}`, "");
	lines.push(
		"## Topology",
		"",
		"| VM | Kind | Roles | Region | Size | Private IP |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const vm of report.topology?.vms ?? [])
		lines.push(
			`| ${cell(vm.name)} | ${vm.kind} | ${cell(vm.roles)} | ${vm.region} | ${vm.size} | ${vm.privateIp ?? ""} |`,
		);
	lines.push(
		"",
		"## Security gate",
		"",
		`Result: **${report.security?.passed === true ? "passed" : report.security === undefined ? "not run" : "failed"}**`,
		"",
		"| Check | Subject | Passed | Observed |",
		"| --- | --- | --- | --- |",
	);
	for (const check of report.security?.checks ?? [])
		lines.push(`| ${check.name} | ${check.subject} | ${check.passed ? "yes" : "**no**"} | ${cell(check.observed)} |`);
	lines.push("", "## Suites", "", "| Suite | Issue | Status | Reason |", "| --- | --- | --- | --- |");
	for (const suite of report.suites ?? [])
		lines.push(
			`| ${suite.name} | ${suite.issue} | ${suite.status} | ${suite.reason ? `\`${suite.reason.code}\`: ${cell(suite.reason.message)}` : ""} |`,
		);
	lines.push(
		"",
		"## Chaos coverage",
		"",
		"| Profile | Status | Target | Effect observed | Recovered | Observed |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	const faults = (report.suites ?? []).flatMap((/** @type {SuiteResult} */ suite) => suite.faults ?? []);
	for (const item of report.coverage ?? []) {
		const fault = faults.find((/** @type {{ profile: string }} */ entry) => entry.profile === item.profile);
		lines.push(
			`| ${item.profile} | ${item.status} | ${fault?.target ?? ""} | ${fault?.effectObserved ?? ""} | ${fault?.recovered ?? ""} | ${cell(fault?.error?.message ?? fault?.observed ?? "")} |`,
		);
	}
	lines.push("", "## Invariants", "", "| Invariant | Passed | Expected | Actual |", "| --- | --- | --- | --- |");
	for (const suite of report.suites ?? [])
		for (const item of suite.invariants ?? [])
			lines.push(
				`| ${item.name} | ${item.passed ? "yes" : "**no**"} | ${cell(item.expected)} | ${cell(item.actual)} |`,
			);
	lines.push(
		"",
		"## Metrics",
		"",
		"```json",
		JSON.stringify(
			Object.fromEntries(
				(report.suites ?? []).map((/** @type {SuiteResult} */ suite) => [suite.name, suite.metrics ?? {}]),
			),
			null,
			2,
		),
		"```",
	);
	lines.push("", "## Fault timeline", "", "| ms | Profile | Event |", "| --- | --- | --- |");
	for (const fault of faults)
		for (const event of fault.timeline ?? []) lines.push(`| ${event.at} | ${fault.profile} | ${cell(event.event)} |`);
	lines.push(
		"",
		"## Teardown",
		"",
		`Result: **${report.teardown === undefined ? "not run" : report.teardown.ok ? "zero resources left" : "incomplete"}**`,
		"",
	);
	for (const query of report.teardown?.queries ?? [])
		lines.push(`- \`${query.command}\` → ${query.ok ? cell(query.result) : "query failed"}`);
	lines.push("", "## Phase durations (ms)", "", "```json", JSON.stringify(report.durations ?? {}, null, 2), "```", "");
	return lines.join("\n");
}

/**
 * Writes `report.json` and `report.md` into `dir`, redacting every registered secret.
 * @param {string} dir
 * @param {Record<string, any>} report
 * @param {Iterable<string>} secrets
 */
export function writeReport(dir, report, secrets) {
	const values = [...secrets];
	const paths = { json: join(dir, "report.json"), markdown: join(dir, "report.md") };
	const withPaths = { ...report, paths };
	writeFileSync(paths.json, `${redact(JSON.stringify(withPaths, null, "\t"), values)}\n`, { mode: 0o600 });
	writeFileSync(paths.markdown, redact(renderMarkdown(withPaths), values), { mode: 0o600 });
	return paths;
}
