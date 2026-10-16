import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	const through = await manager.appendMessage({ role: "user", content: "Build a parser", timestamp: 1 });
	await manager.appendSessionSummary("Parser implemented; review remains", through);
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
		const manager = await SessionManager.create(dir, join(dir, "sessions"));
		const through = await manager.appendMessage({ role: "user", content: "Build a parser", timestamp: 1 });
		await manager.appendSessionSummary("Parser implemented; review remains", through);
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
			args: [
				"--session-dir",
				manager.getSessionDir(),
				"--session",
				manager.getSessionId(),
				"--no-extensions",
				"--extension",
				extension,
				"--no-tools",
			],
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

test(
	"RpcClient resume respects disabled workflow summary context while stored summaries stay readable",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-summary-resume-rpc-"));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
		const controlModule = fileURLToPath(
			new URL("../../workflows/src/extension/workflow-session-run-control.ts", import.meta.url),
		);
		const summaryModule = fileURLToPath(
			new URL("../../workflows/src/extension/workflow-resume-summary.ts", import.meta.url),
		);
		const extension = join(dir, "summary-resume-control.ts");
		writeFileSync(
			extension,
			`
import { createSessionRunControl } from ${JSON.stringify(controlModule)};
import { injectWorkflowResumeSummary } from ${JSON.stringify(summaryModule)};
export default function (pi) {
	let context;
	const snapshot = { id: "run-a", name: "review", status: "paused", inputs: {}, stages: [], startedAt: 1, summary: "Stored review context", summarizedThrough: 5 };
	const control = createSessionRunControl({
		context: () => context,
		store: { runs: () => [snapshot] },
		catalog: async () => {
			const saved = { workflowId: "saved-local", name: "review", status: "paused", completedCheckpoints: 0, pendingPrompts: 0, createdAt: 1, updatedAt: 5, modelOwner: "owner", invocationCwd: context.cwd, summary: "Saved local summary" };
			return {
				resumable: [saved, { ...saved, workflowId: "foreign-paused", invocationCwd: ${JSON.stringify(join(dir, "foreign"))} }],
				completed: [{ ...saved, workflowId: "foreign-completed", status: "completed", invocationCwd: ${JSON.stringify(join(dir, "foreign"))} }]
			};
		},
		execute: async (args, ctx) => {
			if (args.action === "resume") {
				await injectWorkflowResumeSummary(pi, ctx, "run-a", snapshot);
				return { action: "resume", runId: "run-a", status: "running", message: "Resumed" };
			}
			if (args.runId) return { action: "statusDetail", detail: ${JSON.stringify({ ...detail, summary: "Stored review context" })} };
			return { action: "status", runs: [${JSON.stringify(run)}] };
		}
	});
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.registerWorkflowRunControl(control);
	pi.registerCommand("resume-summary", { description: "Resume fixture", handler: async () => { await control.resume("run-a"); } });
}`,
		);
		const client = new RpcClient({
			cliPath,
			cwd: dir,
			runtimeExecutable: bunExecutable(),
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			args: ["--no-extensions", "--extension", extension, "--no-tools"],
		});
		try {
			await client.start();
			assert.equal((await client.getWorkflowRunSummary("run-a")).summary, "Stored review context");
			assert.deepEqual(
				(await client.listWorkflowRuns()).map((entry) => entry.runId),
				["run-a", "saved-local"],
			);
			await client.prompt("/resume-summary");
			assert.equal(
				(await client.getMessages()).some((message) => message.role === "custom"),
				false,
			);
		} finally {
			await client.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_RPC_SUMMARY_TIMEOUT_MS,
);
