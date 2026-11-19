import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";
import { createHarness } from "./suite/harness.js";

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
	"RpcClient reads session summaries through the real CLI JSONL transport",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-summary-rpc-"));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionSummary: { enabled: false } }));
		const manager = await SessionManager.create(dir, join(dir, "sessions"));
		const through = await manager.appendMessage({ role: "user", content: "Build a parser", timestamp: 1 });
		await manager.appendSessionSummary("Parser implemented; review remains", through);
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
				"--no-tools",
			],
		});
		try {
			await client.start();
			for (const type of [
				"list_workflow_runs",
				"get_workflow_run_summary",
				"get_workflow_resume_entries",
				"resume_workflow_from_picker",
				"delete_workflow_from_picker",
			] as const) {
				// An older client can still send a command that the public TS union no longer accepts.
				// @ts-expect-error This request deliberately uses a removed wire command.
				await assert.rejects(client.requestInternal({ type }), new RegExp(`Unknown command: ${type}`));
			}
			assert.equal((await client.getSessionSummary())?.summarizedThroughId, through);
			assert.equal(
				(await client.listSessions()).find((item) => item.id === manager.getSessionId())?.summary,
				"Parser implemented; review remains",
			);
			await client.newSession();
			assert.equal(await client.getSessionSummary(), null);
		} finally {
			await client.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	REAL_RPC_SUMMARY_TIMEOUT_MS,
);

test("RPC get_session_summary reports no summary for an unsaved session (#4726)", async () => {
	const harness = await createHarness();
	try {
		const through = await harness.sessionManager.appendMessage({
			role: "user",
			content: "Build a parser",
			timestamp: 1,
		});
		await harness.sessionManager.appendSessionSummary("Parser implemented", through);
		const handle = createRpcCommandHandler({
			runtimeHost: { session: harness.session } as unknown as AgentSessionRuntime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: () => {},
		});

		const response = await handle({ id: "summary", type: "get_session_summary" });

		assert.deepEqual(response, {
			id: "summary",
			type: "response",
			command: "get_session_summary",
			success: true,
			data: { summary: null },
		});
	} finally {
		await harness.cleanup();
	}
});
