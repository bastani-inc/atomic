import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { WorkflowRunDetail, WorkflowRunSummary } from "../src/core/extensions/workflow-run-control.js";
import { SessionManager } from "../src/core/session-manager.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";
import { createHarness } from "./suite/harness.js";

const run: WorkflowRunSummary = {
	runId: "run-a",
	name: "review",
	status: "paused",
	startedAt: 1,
	elapsedMs: 4,
	activeStages: [],
	awaitingInputCount: 0,
	awaitingInput: [],
	label: "Parser",
	identity: "Parser",
	summary: "Tests pass",
	summarizedThrough: 5,
};
const detail: WorkflowRunDetail = { ...run, inputs: {}, stages: [] };

test("SDK reads stored session summary entries and list markers when generation is disabled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-summary-sdk-"));
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	const through = manager.appendMessage({ role: "user", content: "Build a parser", timestamp: 1 });
	manager.appendSessionSummary("Parser implemented; review remains", through);
	const harness = await createHarness({ sessionManager: manager, settings: { sessionSummary: { enabled: false } } });
	try {
		assert.equal(harness.session.sessionSummary?.summary, "Parser implemented; review remains");
		assert.equal(harness.session.sessionSummary?.summarizedThroughId, through);
		const listed = await SessionManager.list(dir, manager.getSessionDir());
		assert.equal(listed[0]?.summary, "Parser implemented; review remains");
		assert.equal(listed[0]?.summarizedThroughId, through);
		assert.equal((await SessionManager.listAll(manager.getSessionDir()))[0]?.summarizedThroughId, through);
	} finally {
		await harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

const REAL_RPC_SUMMARY_TIMEOUT_MS = 120_000;
test(
	"RpcClient reads session and workflow summaries through the real CLI JSONL transport",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-summary-rpc-"));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const through = manager.appendMessage({ role: "user", content: "Build a parser", timestamp: 1 });
		manager.appendSessionSummary("Parser implemented; review remains", through);
		const extension = join(dir, "summary-control.ts");
		writeFileSync(
			extension,
			`export default function (pi) {
		pi.registerWorkflowRunControl({
			listRuns: async (filter) => { if (!filter.includeDurable) throw new Error("Expected durable history"); return [${JSON.stringify(run)}]; },
			getRun: async (id) => { if (id !== "run-a") throw new Error("Unexpected run"); return ${JSON.stringify(detail)}; },
			getStages: async () => [], pause: async () => {}, quit: async () => {}, resume: async () => {}
		});
	}`,
		);
		const client = new RpcClient({
			cliPath,
			cwd: dir,
			runtimeExecutable: bunExecutable(),
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			args: ["--session", manager.getSessionFile()!, "--no-extensions", "--extension", extension, "--no-tools"],
		});
		try {
			await client.start();
			assert.equal((await client.getSessionSummary())?.summarizedThroughId, through);
			assert.equal(
				(await client.listSessions()).find((item) => item.id === manager.getSessionId())?.summary,
				"Parser implemented; review remains",
			);
			assert.deepEqual(await client.listWorkflowRuns(), [run]);
			assert.deepEqual(await client.getWorkflowRunSummary(run.runId), detail);
			await client.newSession();
			assert.equal(await client.getSessionSummary(), null);
		} finally {
			await client.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_RPC_SUMMARY_TIMEOUT_MS,
);
