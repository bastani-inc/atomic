import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectSubagentStatus } from "../../packages/subagents/src/runs/background/run-status.js";
import type { AcceptanceLedger, AsyncStatus } from "../../packages/subagents/src/shared/types.js";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function writeStatus(asyncRoot: string, runId: string, status: AsyncStatus): string {
	const asyncDir = path.join(asyncRoot, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
	return asyncDir;
}

function acceptanceLedger(status: AcceptanceLedger["status"], overrides: Partial<AcceptanceLedger> = {}): AcceptanceLedger {
	return {
		status,
		explicit: false,
		effectiveAcceptance: {
			level: "checked",
			explicit: false,
			inferredReason: [],
			criteria: [],
			evidence: [],
			verify: [],
			stopRules: [],
		},
		inferredReason: [],
		criteria: [],
		runtimeChecks: [],
		verifyRuns: [],
		...overrides,
	};
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("subagent async status fast-mode labels (issue #1153)", () => {
	test("active status list includes fast after thinking", () => {
		const asyncRoot = makeTempRoot("atomic-subagent-status-fast-async-");
		const resultsDir = makeTempRoot("atomic-subagent-status-fast-results-");
		writeStatus(asyncRoot, "run-fast", {
			runId: "run-fast",
			mode: "single",
			state: "running",
			startedAt: 1_000,
			lastUpdate: 2_000,
			currentStep: 0,
			steps: [{
				agent: "worker",
				status: "running",
				model: "openai/gpt-5.1-codex",
				thinking: "medium",
				fastMode: true,
			}],
		});

		const result = inspectSubagentStatus({ action: "status" }, { asyncDirRoot: asyncRoot, resultsDir });
		const firstContent = result.content[0];
		const text = firstContent?.type === "text" ? firstContent.text : "";

		assert.match(text, /gpt-5\.1-codex · thinking medium · fast/);
	});

	test("exact status output includes fast after thinking", () => {
		const asyncRoot = makeTempRoot("atomic-subagent-status-fast-async-");
		const resultsDir = makeTempRoot("atomic-subagent-status-fast-results-");
		const asyncDir = writeStatus(asyncRoot, "run-fast", {
			runId: "run-fast",
			mode: "single",
			state: "running",
			startedAt: 1_000,
			lastUpdate: 2_000,
			currentStep: 0,
			steps: [{
				agent: "worker",
				status: "running",
				model: "openai/gpt-5.1-codex",
				thinking: "medium",
				fastMode: true,
			}],
		});

		const result = inspectSubagentStatus({ action: "status", dir: asyncDir }, { asyncDirRoot: asyncRoot, resultsDir });
		const firstContent = result.content[0];
		const text = firstContent?.type === "text" ? firstContent.text : "";

		assert.match(text, /Step 1: worker running \(gpt-5\.1-codex · thinking medium · fast\)/);
	});

	test("exact status output explains acceptance rejection as a completed run gate failure", () => {
		const asyncRoot = makeTempRoot("atomic-subagent-status-acceptance-async-");
		const resultsDir = makeTempRoot("atomic-subagent-status-acceptance-results-");
		const asyncDir = writeStatus(asyncRoot, "run-acceptance", {
			runId: "run-acceptance",
			mode: "single",
			state: "complete",
			startedAt: 1_000,
			lastUpdate: 2_000,
			currentStep: 0,
			steps: [{
				agent: "worker",
				status: "completed",
				acceptance: acceptanceLedger("rejected", {
					runtimeChecks: [{ id: "commands-run", status: "failed", message: "commands-run evidence missing from child report" }],
				}),
			}],
		});

		const result = inspectSubagentStatus({ action: "status", dir: asyncDir }, { asyncDirRoot: asyncRoot, resultsDir });
		const firstContent = result.content[0];
		const text = firstContent?.type === "text" ? firstContent.text : "";

		assert.match(text, /Step 1: worker completed, acceptance gate rejected after completion: commands-run evidence missing from child report/);
		assert.doesNotMatch(text, /acceptance: rejected/);
	});
});
