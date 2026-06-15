import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "bun:test";
import {
	acceptanceFailureMessage,
	aggregateAcceptanceReport,
	evaluateAcceptance,
	formatAcceptancePrompt,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	validateAcceptanceInput,
} from "../../packages/subagents/src/runs/shared/acceptance.js";
import { formatAcceptanceLedgerForDisplay } from "../../packages/subagents/src/shared/status-format.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";

function report(overrides: Record<string, unknown> = {}): string {
	return [
		"done",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified in test" }],
			changedFiles: ["src/file.js"],
			testsAddedOrUpdated: ["test/file.test.js"],
			commandsRun: [{ command: "bun test", result: "passed", summary: "passed" }],
			validationOutput: ["tests passed"],
			residualRisks: [],
			noStagedFiles: true,
			notes: "complete",
			...overrides,
		}),
		"```",
	].join("\n");
}

function tempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-acceptance-"));
	fs.writeFileSync(path.join(dir, "file.txt"), "hello\n", "utf-8");
	return dir;
}

describe("acceptance gates", () => {
	test("infers different policies for reviewer, writer, async writer, dynamic contexts, and no-write investigations", () => {
		assert.equal(resolveEffectiveAcceptance({ agentName: "reviewer", task: "Review-only. Do not edit.", mode: "single" }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single", async: true }).level, "reviewed");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Fix each item", mode: "chain", dynamic: true }).level, "reviewed");

		for (const task of [
			"Debug investigation for issue title 'fix flaky auth test'; do not implement changes.",
			"Investigate the likely fix for the cache race",
			"Investigate the likely fix for the cache race; don't implement anything.",
			"Debug the fix regression",
			"Debug the fix regression; no-implementation report.",
			"Debug the fix regression and return a report-only summary.",
			"Find the fix root cause; findings only.",
			"Investigate the fix without edits",
			"Review the fix without any changes",
			"Diagnose the fix without modifications",
			"Investigate the patch; do not change.",
			"Investigate the fix; do not edit files, just identify the root cause.",
			"Investigate the fix; do not edit files, but only report the root cause.",
			"Investigate the fix; do not edit files, just list findings.",
			"Investigate the fix; do not edit files and only report root cause.",
			"Investigate the fix; do not modify code, then summarize findings.",
			"Review the patch; don't modify.",
			"Analyze the diff; dont change",
		]) {
			const noWriteInvestigation = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single", async: true });
			assert.equal(noWriteInvestigation.level, "attested", task);
			assert.equal(noWriteInvestigation.evidence.includes("changed-files"), false, task);
			assert.equal(noWriteInvestigation.review, undefined, task);
		}

		for (const task of [
			"Analyze the fix regression and identify root cause",
			"Analyze each fix regression",
		]) {
			const readOnlyAcceptance = resolveEffectiveAcceptance({ agentName: "codebase-analyzer", task, mode: "single", async: true, dynamic: task.includes("each") });
			assert.equal(readOnlyAcceptance.level, "attested", task);
			assert.equal(readOnlyAcceptance.evidence.includes("changed-files"), false, task);
			assert.equal(readOnlyAcceptance.review, undefined, task);
		}

		assert.equal(resolveEffectiveAcceptance({ agentName: "debugger", task: "Inspect the failing login flow and implement the fix", mode: "single" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "debugger", task: "Inspect the failing login flow and implement the fix", mode: "single", async: true }).level, "reviewed");
	});

	test("keeps read-only code and source diagnostics attested when fix or patch is a noun", () => {
		for (const task of [
			"Analyze code for the fix root cause",
			"Inspect source for the patch root cause",
			"Review files for the likely fix",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single", async: true });
			assert.equal(acceptance.level, "attested", task);
			assert.equal(acceptance.evidence.includes("changed-files"), false, task);
			assert.equal(acceptance.review, undefined, task);
		}

		for (const task of [
			"Fix code and report results",
			"Patch files and summarize",
			"Apply patch to files",
			"Implement the fix in source",
		]) {
			const syncAcceptance = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single" });
			assert.equal(syncAcceptance.level, "checked", task);
			assert.equal(syncAcceptance.evidence.includes("changed-files"), true, task);

			const asyncAcceptance = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single", async: true });
			assert.equal(asyncAcceptance.level, "reviewed", task);
			assert.equal(asyncAcceptance.evidence.includes("changed-files"), true, task);
			assert.deepEqual(asyncAcceptance.review, { agent: "codebase-analyzer", required: true }, task);
		}
	});

	test("infers report and summary investigations as attested unless they request file or code edits", () => {
		for (const task of [
			"Summarize the fix for issue #1383",
			"Summarize README",
			"Write a summary of README",
			"Write a report with proposed fixes",
			"Report proposed fixes for issue #1383",
			"Report what changed in the patch.",
			"Summarize what changed in the diff.",
			"Review what changed in the previous change.",
			"Review the tests added by the previous change",
			"Analyze tests added in the last patch",
			"Summarize tests added by the prior implementation",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single", async: true });
			assert.equal(acceptance.level, "attested", task);
			assert.equal(acceptance.evidence.includes("changed-files"), false, task);
		}

		assert.equal(resolveEffectiveAcceptance({ agentName: "debugger", task: "Write a report and update source code with the proposed fix", mode: "single" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "debugger", task: "Propose and implement the fix", mode: "single" }).level, "checked");
	});

	test("keeps write gates for objectful named-file edits paired with report or summary prose", () => {
		for (const task of [
			"Edit README and write a summary",
			"Modify README and report results",
		]) {
			const syncAcceptance = resolveEffectiveAcceptance({ agentName: "worker", task, mode: "single" });
			assert.equal(syncAcceptance.level, "checked", task);
			assert.equal(syncAcceptance.evidence.includes("changed-files"), true, task);

			const asyncAcceptance = resolveEffectiveAcceptance({ agentName: "worker", task, mode: "single", async: true });
			assert.equal(asyncAcceptance.level, "reviewed", task);
			assert.equal(asyncAcceptance.evidence.includes("changed-files"), true, task);
			assert.deepEqual(asyncAcceptance.review, { agent: "codebase-analyzer", required: true }, task);
		}
	});

	test("keeps write gates when strong implementation verbs are paired with report or summary prose", () => {
		const implementationReportTasks = [
			"Fix the bug and report results",
			"Implement the fix and write a summary",
			"Write a report and implement the fix",
			"Write a summary and fix the bug",
			"Report findings, then implement the fix",
			"Write a report after fixing the bug",
			"Write a report after you fixed the bug",
			"Summarize results after implementing the fix",
			"Summarize results after you implemented the fix",
			"Report what you changed and tests added",
			"After implementing the fix, write a summary",
			"After patching the bug, report results",
			"After applying the patch, report results",
			"Could you fix the bug and report results",
			"Would you implement the fix and write a summary",
			"Fix the bug, then summarize what changed",
			"Please quickly fix the bug and report results",
			"Could you safely update the parser and write a summary",
		];

		for (const task of implementationReportTasks) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single" });
			assert.equal(acceptance.level, "checked", task);
			assert.equal(acceptance.evidence.includes("changed-files"), true, task);
		}

		for (const task of implementationReportTasks) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single", async: true });
			assert.equal(acceptance.level, "reviewed", task);
			assert.equal(acceptance.evidence.includes("changed-files"), true, task);
			assert.deepEqual(acceptance.review, { agent: "codebase-analyzer", required: true }, task);
		}

		const dynamicAcceptance = resolveEffectiveAcceptance({ agentName: "debugger", task: "After applying the patch, report results", mode: "chain", dynamic: true });
		assert.equal(dynamicAcceptance.level, "reviewed");
		assert.equal(dynamicAcceptance.evidence.includes("changed-files"), true);
		assert.deepEqual(dynamicAcceptance.review, { agent: "codebase-analyzer", required: true });

		const asyncPoliteAcceptance = resolveEffectiveAcceptance({ agentName: "debugger", task: "Can you quickly implement the fix and report results", mode: "single", async: true });
		assert.equal(asyncPoliteAcceptance.level, "reviewed");
		assert.equal(asyncPoliteAcceptance.evidence.includes("changed-files"), true);
		assert.deepEqual(asyncPoliteAcceptance.review, { agent: "codebase-analyzer", required: true });
	});

	test("keeps write gates for implementation constraints and factual no-implementation wording", () => {
		for (const task of [
			"Refactor the parser without changing behavior",
			"Implement the fix without changing user behavior",
			"Implement the fix but do not change existing behavior.",
			"Fix the bug but do not change user behavior.",
			"Update parser but do not change observable behavior.",
			"No implementation currently exists; implement it",
			"Fix the bug but do not change public API",
			"Update parser but do not modify CLI behavior",
			"Implement fix but do not change external contract",
			"Fix the bug but do not change tests",
			"Fix the bug but do not change docs",
			"Update parser but do not change snapshots",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "worker", task, mode: "single" });
			assert.equal(acceptance.level, "checked", task);
			assert.equal(acceptance.evidence.includes("changed-files"), true, task);
		}

		const riskyMigrationAcceptance = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement migration but do not change database schema", mode: "single" });
		assert.equal(riskyMigrationAcceptance.level, "reviewed");
		assert.equal(riskyMigrationAcceptance.evidence.includes("changed-files"), true);
		assert.deepEqual(riskyMigrationAcceptance.review, { agent: "codebase-analyzer", required: true });

		const dynamicAcceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Update each parser but do not modify CLI behavior",
			mode: "chain",
			dynamic: true,
		});
		assert.equal(dynamicAcceptance.level, "reviewed");
		assert.equal(dynamicAcceptance.evidence.includes("changed-files"), true);
		assert.deepEqual(dynamicAcceptance.review, { agent: "codebase-analyzer", required: true });

		const dynamicScopedAcceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Update parser but do not change snapshots",
			mode: "chain",
			dynamic: true,
		});
		assert.equal(dynamicScopedAcceptance.level, "reviewed");
		assert.equal(dynamicScopedAcceptance.evidence.includes("changed-files"), true);
		assert.deepEqual(dynamicScopedAcceptance.review, { agent: "codebase-analyzer", required: true });

		const butImplementationAcceptance = resolveEffectiveAcceptance({
			agentName: "debugger",
			task: "Investigate the fix; do not edit files, but implement the migration",
			mode: "single",
			async: true,
		});
		assert.equal(butImplementationAcceptance.level, "reviewed");
		assert.equal(butImplementationAcceptance.evidence.includes("changed-files"), true);
		assert.deepEqual(butImplementationAcceptance.review, { agent: "codebase-analyzer", required: true });
	});

	test("treats do-not-change-anything-else as an implementation scope guard", () => {
		for (const task of [
			"Fix the bug but do not change anything else.",
			"Implement the fix; do not change anything else.",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "worker", task, mode: "single", async: true });
			assert.equal(acceptance.level, "reviewed", task);
			assert.equal(acceptance.evidence.includes("changed-files"), true, task);
			assert.deepEqual(acceptance.review, { agent: "codebase-analyzer", required: true }, task);
		}

		for (const task of [
			"Investigate the likely fix for the cache race; don't implement anything.",
			"Investigate the issue and do not make any changes.",
			"Investigate the fix without edits.",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "worker", task, mode: "single", async: true });
			assert.equal(acceptance.level, "attested", task);
			assert.equal(acceptance.evidence.includes("changed-files"), false, task);
		}
	});

	test("keeps side-effectful release and commit operations gated with report prose", () => {
		for (const task of [
			"Release the package and write a summary",
			"Release and write a summary",
			"Commit the changes and write a report",
			"Commit and write a report",
			"Publish the package and write a report",
			"Deploy the app and write a summary",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "worker", task, mode: "single", async: true });
			assert.equal(acceptance.level, "reviewed", task);
			assert.equal(acceptance.evidence.includes("changed-files"), true, task);
			assert.deepEqual(acceptance.review, { agent: "codebase-analyzer", required: true }, task);
		}

		for (const task of [
			"Summarize release notes",
			"Analyze the previous commit",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "worker", task, mode: "single", async: true });
			assert.equal(acceptance.level, "attested", task);
			assert.equal(acceptance.evidence.includes("changed-files"), false, task);
		}
	});

	test("recognizes no-edit filler wording before write inference", () => {
		for (const task of [
			"Investigate the issue and do not make any changes.",
			"Inspect the regression; don't make any edits.",
			"Diagnose the failing fix, but do not make code changes.",
			"Analyze the changed files; no file writes.",
			"Review the bug; no source changes.",
			"Could you fix the bug and report results, but do not make any changes.",
			"Would you implement the fix and write a summary; no source changes.",
			"Summarize likely fixes without any file edits.",
		]) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "debugger", task, mode: "single", async: true });
			assert.equal(acceptance.level, "attested", task);
			assert.equal(acceptance.evidence.includes("changed-files"), false, task);
		}
	});

	test("dynamic fanouts default to reviewed unless read-only or no-write", () => {
		assert.equal(resolveEffectiveAcceptance({ agentName: "debugger", task: "Clean up each changed file", mode: "chain", dynamic: true }).level, "reviewed");
		assert.equal(resolveEffectiveAcceptance({ agentName: "debugger", task: "Apply patch for each item", mode: "chain", dynamicGroup: true }).level, "reviewed");
		assert.equal(resolveEffectiveAcceptance({ agentName: "debugger", task: "Investigate each changed file; do not make any changes", mode: "chain", dynamic: true }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "codebase-analyzer", task: "Analyze each changed file", mode: "chain", dynamic: true }).level, "attested");
	});

	test("explicit acceptance can strengthen inferred policy", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review-only.",
			explicit: { level: "verified", verify: [{ id: "ok", command: "node --version" }] },
		});

		assert.equal(resolved.level, "verified");
		assert.equal(resolved.verify[0]?.id, "ok");
	});

	test("formats a standardized child prompt section", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "checked", criteria: ["Patch the bug"], stopRules: ["Do not stop after analysis"] },
		});
		const prompt = formatAcceptancePrompt(resolved);

		assert.match(prompt, /## Acceptance Contract/);
		assert.match(prompt, /Acceptance level: checked/);
		assert.match(prompt, /Patch the bug/);
		assert.match(prompt, /```acceptance-report/);
	});

	test("parses only explicit acceptance-report fences", () => {
		const parsed = parseAcceptanceReport(report());

		assert.ok(parsed.report);
		assert.deepEqual(parsed.report.changedFiles, ["src/file.js"]);
		assert.equal(parsed.error, undefined);

		const genericJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"notes\":\"not an acceptance report\"}\n\`\`\``);
		assert.equal(genericJson.report, undefined);
		assert.match(genericJson.error ?? "", /Structured acceptance report not found/);

		const malformed = parseAcceptanceReport("```acceptance-report\n{bad-json\n```");
		assert.equal(malformed.report, undefined);
		assert.match(malformed.error ?? "", /Failed to parse acceptance-report/);
	});

	test("explicit none disables inferred gates when a reason is present", () => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "none", reason: "parent is doing manual acceptance" },
		});

		assert.equal(acceptance.level, "none");
		assert.deepEqual(acceptance.evidence, []);
	});

	test("checked mode rejects missing required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ testsAddedOrUpdated: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Run completed, but the acceptance gate rejected the result/);
			assert.match(acceptanceFailureMessage(ledger) ?? "", /tests-added evidence missing/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("checked mode distinguishes missing and empty changed-files evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});

			const missing = await evaluateAcceptance({
				acceptance,
				output: report({ changedFiles: undefined }),
				cwd,
			});
			assert.equal(missing.status, "rejected");
			assert.match(acceptanceFailureMessage(missing) ?? "", /changed-files evidence missing from child report/);

			const empty = await evaluateAcceptance({
				acceptance,
				output: report({ changedFiles: [] }),
				cwd,
			});
			assert.equal(empty.status, "rejected");
			assert.match(acceptanceFailureMessage(empty) ?? "", /changed-files evidence was present but empty/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("checked mode rejects not-satisfied required criteria", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked", criteria: [{ id: "regression", must: "Regression is covered" }] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ criteriaSatisfied: [{ id: "regression", status: "not-satisfied", evidence: "test missing" }] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Required criterion 'regression' was reported as not-satisfied/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("verified mode records runtime command success and failure separately from child command claims", async () => {
		const cwd = tempRepo();
		try {
			const passing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "pass", command: "bun -e \"process.exit(0)\"", timeoutMs: 10_000 }] },
			});
			const passLedger = await evaluateAcceptance({ acceptance: passing, output: report(), cwd });
			assert.equal(passLedger.status, "verified");
			assert.equal(passLedger.verifyRuns[0]?.status, "passed");

			const failing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "fail", command: "bun -e \"process.exit(7)\"", timeoutMs: 10_000 }] },
			});
			const failLedger = await evaluateAcceptance({ acceptance: failing, output: report(), cwd });
			assert.equal(failLedger.status, "rejected");
			assert.equal(failLedger.childReport?.commandsRun?.[0]?.result, "passed");
			assert.equal(failLedger.verifyRuns[0]?.status, "failed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reviewed mode records no-blocker and blocker reviewer outcomes", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a risky fix",
				explicit: { level: "reviewed", review: { agent: "reviewer", required: true } },
			});
			const noBlockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: { status: "no-blockers", findings: [] },
			});
			assert.equal(noBlockers.status, "reviewed");
			assert.equal(noBlockers.reviewResult?.status, "no-blockers");

			const blockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: {
					status: "blockers",
					findings: [{ severity: "blocker", issue: "Missing test", rationale: "Acceptance requires test evidence." }],
				},
			});
			assert.equal(blockers.status, "rejected");
			assert.equal(blockers.reviewResult?.status, "blockers");
			assert.match(acceptanceFailureMessage(blockers) ?? "", /Missing test/);

			const mixedSeverityBlockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: {
					status: "blockers",
					findings: [
						{ severity: "non-blocking", file: "src/info.ts", issue: "Style nit", rationale: "Can be cleaned later." },
						{ severity: "blocker", file: "src/cache.ts", issue: "Race still possible", rationale: "Lock can be bypassed." },
					],
				},
			});
			assert.equal(mixedSeverityBlockers.status, "rejected");
			assert.match(acceptanceFailureMessage(mixedSeverityBlockers) ?? "", /src\/cache\.ts: Race still possible/);
			assert.doesNotMatch(acceptanceFailureMessage(mixedSeverityBlockers) ?? "", /Style nit/);
			assert.equal(
				formatAcceptanceLedgerForDisplay(mixedSeverityBlockers),
				"acceptance gate rejected after completion: acceptance review found blockers: src/cache.ts: Race still possible (Lock can be bypassed.)",
			);

			const fallbackIssueBlockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: {
					status: "blockers",
					findings: [
						{ severity: "blocker", issue: "", rationale: "Reviewer omitted details." },
						{ severity: "non-blocking", file: "src/fallback.ts", issue: "Fallback issue", rationale: "First usable issue." },
					],
				},
			});
			assert.match(acceptanceFailureMessage(fallbackIssueBlockers) ?? "", /src\/fallback\.ts: Fallback issue/);

			const unavailable = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(unavailable.status, "rejected");
			assert.equal(unavailable.reviewResult?.status, "needs-parent-decision");
			assert.match(acceptanceFailureMessage(unavailable) ?? "", /Reviewed acceptance requires an independent reviewer result/);
			assert.equal(
				formatAcceptanceLedgerForDisplay({
					...unavailable,
					reviewResult: {
						status: "needs-parent-decision",
						findings: [{ severity: "non-blocking", file: "src/cache.ts", issue: "Race still possible", rationale: "Lock can be bypassed." }],
					},
				}),
				"acceptance gate rejected after completion: acceptance review is required and no automatic reviewer result is available: src/cache.ts: Race still possible (Lock can be bypassed.)",
			);
			assert.equal(
				formatAcceptanceLedgerForDisplay({ ...unavailable, reviewResult: { status: "needs-parent-decision", findings: [] } }),
				"acceptance gate rejected after completion: acceptance review is required and no automatic reviewer result is available",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("does not make explicit checked acceptance an explicit reviewed blocker when inference recommends review", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement each dynamic item",
				dynamic: true,
				explicit: { level: "checked" },
			});

			assert.equal(acceptance.level, "reviewed");
			assert.equal(acceptance.review ? acceptance.review.required : undefined, false);
			const ledger = await evaluateAcceptance({ acceptance, output: report({ criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
				{ id: "criterion-2", status: "satisfied", evidence: "evidence returned" },
			] }), cwd });
			assert.equal(ledger.status, "checked");
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("no-staged-files check ignores ambient Git hook environment", async () => {
		const cwd = tempRepo();
		const ambientRepo = tempRepo();
		const previous = {
			GIT_DIR: process.env.GIT_DIR,
			GIT_WORK_TREE: process.env.GIT_WORK_TREE,
			GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
		};
		try {
			// Sanitize the Git environment so this setup runs against `ambientRepo`
			// and never inherits ambient GIT_DIR/GIT_WORK_TREE from a hook runner
			// (e.g. prek): otherwise `git init` would target the real repo and write
			// core.worktree into the shared config (see git-env.ts).
			spawnSync("git", ["init"], { cwd: ambientRepo, stdio: "ignore", env: createGitEnvironment() });
			fs.writeFileSync(path.join(ambientRepo, "staged.txt"), "staged\n", "utf-8");
			spawnSync("git", ["add", "staged.txt"], { cwd: ambientRepo, stdio: "ignore", env: createGitEnvironment() });
			process.env.GIT_DIR = path.join(ambientRepo, ".git");
			process.env.GIT_WORK_TREE = ambientRepo;
			process.env.GIT_INDEX_FILE = path.join(ambientRepo, ".git", "index");

			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });

			assert.equal(ledger.status, "checked");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "no-staged-files")?.status, "not-applicable");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(cwd, { recursive: true, force: true });
			fs.rmSync(ambientRepo, { recursive: true, force: true });
		}
	});

	test("does not mark reviewed without an independent reviewer result", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: {
					level: "reviewed",
					review: false,
				},
			});
			assert.equal(acceptance.level, "reviewed");

			const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /acceptance review is required/i);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("zero-child aggregate reports do not fabricate required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement dynamic fanout fixes",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: "",
				report: aggregateAcceptanceReport({ results: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /criterion|changed-files|tests-added|commands-run|validation-output|no-staged-files/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("validates invalid disable and verify shapes", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "none" }), ["acceptance.reason is required when level is none."]);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), ["acceptance.verify[0].command is required."]);
	});
});
