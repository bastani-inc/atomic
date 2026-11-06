// @ts-check
/**
 * The run's evidence: a machine-readable `report.json` and a Markdown summary. Both are rendered from one report
 * object and pass through redaction before they are written, so no token or key can reach them.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./commands.mjs";

/**
 * @typedef {import("./errors.mjs").SerializedError} SerializedError
 * @typedef {import("./invariants.mjs").InvariantResult} Invariant
 * @typedef {import("./suites.mjs").FaultRecord} FaultRecord
 * @typedef {{ name: string, issue: string, status: "passed" | "failed" | "skipped" | "cancelled", reason?: SerializedError,
 *   invariants?: Invariant[], failures?: SerializedError[], faults?: FaultRecord[],
 *   metrics?: import("./suites.mjs").SmokeMetrics | import("./released-suite.mjs").ReleasedMetrics,
 *   profiles?: Record<string, import("./chaos.mjs").ProfileSpec> }} SuiteResult
 * @typedef {"passed" | "failed" | "cancelled"} RunStatus
 * @typedef {{ ref: string, suite: string, chaos: string, nodes: number, regions: string[], seed: number, prng: string,
 *   dbStorage: string, dbRegion: string, sha?: string, refname?: string | null, artifactDigest?: string }} ReportReplay
 * @typedef {import("./config.mjs").VmPlan & Partial<Pick<import("./azure.mjs").PlacedVm, "privateIp" | "secondaryIp" | "nics">>} ReportVm
 * @typedef {{ resourceGroup: string, expiresAt: string, vms: ReportVm[], networks?: { region: string, prefix: string, vnet: string }[] }} ReportTopology
 * @typedef {{ hostname: string, node: string, kernel: string, memoryBytes: number, cpus: number, tools: Record<string, boolean>,
 *   modules: Record<string, boolean>, cgroup2: boolean, bootId: string, clockMs: number }} HostFacts
 * @typedef {{ device: string, lsblk: { blockdevices: { name: string, size: string, model: string | null, tran: string | null }[] } }} DatabaseVolume
 * @typedef {{ sha: string, node: string, builtAt: string }} ArtifactStamp
 * @typedef {{ artifactCached?: boolean, sqld?: string, sqldDigest?: string, sqldImage?: string, node?: string, nodeDigest?: string,
 *   databaseVolumes?: { primary?: DatabaseVolume, replica?: DatabaseVolume }, hosts?: Record<string, HostFacts>,
 *   capabilities?: { workflows: number, atomic: number, artifact: ArtifactStamp } }} ReportEnvironment
 * @typedef {{ passed: boolean, checks: import("./security.mjs").SecurityCheck[] }} SecurityReport
 * @typedef {ReturnType<typeof import("./chaos.mjs").profileCoverage>[number] & { suite?: string }} CoverageEntry
 * @typedef {{ ok: boolean, steps: { operation: string, ok: boolean, error?: SerializedError }[],
 *   queries: import("./teardown.mjs").QueryRecord[], remaining: string[], nothingProvisioned?: true, builder?: "stopped" | SerializedError }} TeardownReport
 * @typedef {{ ok: null, kept: true, expiresAt: string, reuse: string, sweep: string }} KeptTeardownReport
 * @typedef {{ json: string, markdown: string }} ReportPaths
 * @typedef {{ schemaVersion: 1, runId: string, startedAt: string, command: string, replay: ReportReplay, topology: ReportTopology,
 *   suites: SuiteResult[], coverage: CoverageEntry[], durations: Record<string, number>, environment: ReportEnvironment, status?: RunStatus,
 *   nvmeSkip?: { code: "encryption-at-host-unavailable", detail: string }, security?: SecurityReport,
 *   teardown?: TeardownReport | KeptTeardownReport, teardownError?: SerializedError,
 *   lifecycle?: { completed: string[], scenariosStarted: boolean }, error?: SerializedError, finishedAt?: string,
 *   paths?: ReportPaths }} Report
 */

/**
 * The run's status from its parts: cancelled wins, then any failure, then passed.
 * @param {{ cancelled: boolean, error: unknown, suites: readonly SuiteResult[], coverage: readonly { status: string }[], teardownOk: boolean | null }} parts
 * @returns {RunStatus}
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
 * @param {Report} report
 */
export function renderMarkdown(report) {
	const { replay } = report;
	const lines = [
		`# Distributed test run ${report.runId}`,
		"",
		`Status: **${report.status}**`,
		"",
		`- Ref: \`${replay.ref}\` → \`${replay.sha ?? "unresolved"}\``,
		`- Suite: \`${replay.suite}\`, chaos: \`${replay.chaos}\`, nodes: ${replay.nodes}, regions: ${cell(replay.regions)}`,
		`- Seed: ${replay.seed} (${replay.prng}); replay with \`node test/distributed/run.mjs --replay ${report.paths?.json ?? "report.json"}\``,
		`- Artifact SHA-256: \`${replay.artifactDigest ?? "none"}\``,
		`- Database storage: ${replay.dbStorage}${report.nvmeSkip ? ` (local NVMe skipped: ${report.nvmeSkip.code})` : ""}`,
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
	for (const vm of report.topology.vms)
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
	for (const suite of report.suites)
		lines.push(
			`| ${suite.name} | ${suite.issue} | ${suite.status} | ${suite.reason ? `\`${suite.reason.code}\`: ${cell(suite.reason.message)}` : ""} |`,
		);
	lines.push(
		"",
		"## Chaos coverage",
		"",
		"| Suite | Profile | Status | Target | Effect observed | Recovered | Observed |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const item of report.coverage) {
		const fault = report.suites
			.filter((suite) => item.suite === undefined || suite.name === item.suite)
			.flatMap((suite) => suite.faults ?? [])
			.find((entry) => entry.profile === item.profile);
		lines.push(
			`| ${item.suite ?? ""} | ${item.profile} | ${item.status} | ${fault?.target ?? ""} | ${fault?.effectObserved ?? ""} | ${fault?.recovered ?? ""} | ${cell(fault?.error?.message ?? fault?.observed ?? "")} |`,
		);
	}
	lines.push("", "## Invariants", "", "| Invariant | Passed | Expected | Actual |", "| --- | --- | --- | --- |");
	for (const suite of report.suites)
		for (const item of suite.invariants ?? [])
			lines.push(
				`| ${item.name} | ${item.passed ? "yes" : "**no**"} | ${cell(item.expected)} | ${cell(item.actual)} |`,
			);
	lines.push(
		"",
		"## Metrics",
		"",
		"```json",
		JSON.stringify(Object.fromEntries(report.suites.map((suite) => [suite.name, suite.metrics ?? {}])), null, 2),
		"```",
	);
	lines.push("", "## Fault timeline", "", "| ms | Profile | Event |", "| --- | --- | --- |");
	for (const fault of report.suites.flatMap((suite) => suite.faults ?? []))
		for (const event of fault.timeline) lines.push(`| ${event.at} | ${fault.profile} | ${cell(event.event)} |`);
	lines.push(
		"",
		"## Teardown",
		"",
		`Result: **${report.teardown === undefined ? "not run" : report.teardown.ok ? "zero resources left" : "incomplete"}**`,
		"",
	);
	if (report.teardown !== undefined && "queries" in report.teardown)
		for (const query of report.teardown.queries)
			lines.push(`- \`${query.command}\` → ${query.ok ? cell(query.result) : "query failed"}`);
	lines.push("", "## Phase durations (ms)", "", "```json", JSON.stringify(report.durations, null, 2), "```", "");
	return lines.join("\n");
}

/**
 * Writes `report.json` and `report.md` into `dir`, redacting every registered secret.
 * @param {string} dir
 * @param {Report} report
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
