// @ts-check
/**
 * report.json and report.md of a run, from vitest's JSON report of each phase and the events the scenarios recorded.
 * Pure apart from what the caller writes, so test/unit/distributed-report.test.ts covers it whole.
 */

/**
 * @typedef {object} VitestAssertion
 * @property {string} fullName
 * @property {string} status "passed" | "failed" | "skipped" | "pending" | "todo"
 * @property {number | null} [duration]
 * @property {string[]} [failureMessages]
 */

/**
 * @typedef {object} VitestFile
 * @property {string} name absolute path of the test file
 * @property {string} status
 * @property {string} [message] why the whole file failed, such as an error in a hook
 * @property {VitestAssertion[]} assertionResults
 */

/** @typedef {{ testResults?: VitestFile[] }} VitestReport */

/**
 * @typedef {object} SuiteResult
 * @property {string} name
 * @property {"passed" | "failed" | "skipped" | "not-run"} status
 * @property {string} [reason]
 * @property {number} durationMs
 * @property {{ name: string, status: string, durationMs: number, failure?: string }[]} tests
 */

/**
 * Replaces every secret in `text` with `[redacted]`.
 * @param {string} text
 * @param {readonly string[]} secrets
 */
export function redact(text, secrets) {
	let result = text;
	for (const secret of secrets) if (secret.length >= 6) result = result.split(secret).join("[redacted]");
	return result;
}

/**
 * The first lines of a failure message, without ANSI colours.
 * @param {string} message
 */
function firstLines(message) {
	const plain = message.replace(/\u001b\[[0-9;]*m/g, "");
	return plain.split("\n").slice(0, 12).join("\n").trim();
}

/**
 * One suite's result from vitest's report of its file. A suite the plan skipped, or whose file vitest never reported
 * (the run stopped first), says so.
 * @param {{ name: string, file: string, action: "run" | "skip", reason?: string }} planned
 * @param {VitestReport | undefined} report
 * @param {readonly string[]} secrets
 * @returns {SuiteResult}
 */
export function suiteResult(planned, report, secrets) {
	if (planned.action === "skip")
		return { name: planned.name, status: "skipped", reason: planned.reason, durationMs: 0, tests: [] };
	const file = report?.testResults?.find((entry) => entry.name.endsWith(planned.file));
	if (file === undefined)
		return {
			name: planned.name,
			status: "not-run",
			reason: "the run stopped before this suite",
			durationMs: 0,
			tests: [],
		};
	const tests = file.assertionResults.map((test) => ({
		name: test.fullName,
		status: test.status,
		durationMs: Math.round(test.duration ?? 0),
		...(test.failureMessages !== undefined && test.failureMessages.length > 0
			? { failure: redact(firstLines(test.failureMessages.join("\n")), secrets) }
			: {}),
	}));
	const failed = file.status === "failed" || tests.some((test) => test.status === "failed");
	const ran = tests.some((test) => test.status === "passed" || test.status === "failed");
	const status = failed ? "failed" : ran ? "passed" : "skipped";
	return {
		name: planned.name,
		status,
		...(failed && file.message ? { reason: redact(firstLines(file.message), secrets) } : {}),
		...(!failed && !ran ? { reason: "every test in the file was skipped" } : {}),
		durationMs: tests.reduce((total, test) => total + test.durationMs, 0),
		tests,
	};
}

/**
 * @typedef {object} RunReport
 * @property {1} schemaVersion
 * @property {string} runId
 * @property {string} commit
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {"passed" | "failed"} status
 * @property {Record<string, unknown>} options
 * @property {string[]} faultOrder
 * @property {SuiteResult[]} suites
 * @property {Record<string, unknown>[]} events
 * @property {{ status: "removed" | "kept" | "failed", detail?: string }} teardown
 * @property {string} [error] what stopped the run, when something outside the suites did
 */

/**
 * @param {Omit<RunReport, "status" | "schemaVersion">} input
 * @returns {RunReport}
 */
export function buildReport(input) {
	const failed =
		input.error !== undefined ||
		input.teardown.status === "failed" ||
		input.suites.some((suite) => suite.status === "failed" || suite.status === "not-run");
	return { schemaVersion: 1, status: failed ? "failed" : "passed", ...input };
}

/**
 * The Markdown report: the outcome first, then each suite and its failures, then the faults as they happened.
 * @param {RunReport} report
 */
export function renderMarkdown(report) {
	const lines = [
		`# Distributed tests: ${report.status}`,
		"",
		`Run \`${report.runId}\` of commit \`${report.commit}\`, from ${report.startedAt} to ${report.finishedAt}.`,
		`Seed ${report.options.seed}. Replay with \`node test/distributed/run.mjs --replay <this run's report.json>\`.`,
		"",
	];
	if (report.error !== undefined) lines.push(`**The run stopped:** ${report.error}`, "");
	lines.push("| Suite | Result | Time |", "| --- | --- | --- |");
	for (const suite of report.suites)
		lines.push(
			`| ${suite.name} | ${suite.status}${suite.reason === undefined ? "" : ` (${suite.reason.split("\n")[0]})`} | ${(suite.durationMs / 1000).toFixed(1)} s |`,
		);
	lines.push("");
	for (const suite of report.suites) {
		const failures = suite.tests.filter((test) => test.status === "failed");
		if (failures.length === 0 && suite.status !== "failed") continue;
		lines.push(`## ${suite.name}`, "");
		if (suite.reason !== undefined && failures.length === 0) lines.push("```text", suite.reason, "```", "");
		for (const test of failures)
			lines.push(`### ${test.name}`, "", "```text", test.failure ?? "(no message)", "```", "");
	}
	if (report.faultOrder.length > 0) lines.push(`Fault order: ${report.faultOrder.join(", ")}.`, "");
	const faults = report.events.filter((event) => event.fault !== undefined);
	if (faults.length > 0) {
		lines.push("## Faults", "", "| Time | Scenario | Fault | Target | Phase |", "| --- | --- | --- | --- | --- |");
		for (const event of faults)
			lines.push(
				`| ${event.at} | ${event.scenario} | ${event.fault} | ${event.node ?? event.service ?? ""} | ${event.phase ?? ""} |`,
			);
		lines.push("");
	}
	lines.push(
		`Teardown: ${report.teardown.status}${report.teardown.detail === undefined ? "" : `. ${report.teardown.detail}`}`,
		"",
	);
	return lines.join("\n");
}
