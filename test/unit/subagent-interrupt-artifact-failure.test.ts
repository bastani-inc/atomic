import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { getArtifactPaths } from "../../packages/subagents/src/shared/artifacts.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const LIVE_CHILD_TIMEOUT_MS = 120_000;
const CONDITION_WAIT_MS = 20_000;
const cleanups: Array<() => void> = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) cleanups.pop()?.();
	clearSubagentControls();
});

function agent(root: string): AgentConfig {
	return {
		name: "worker",
		description: "worker agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(root, "worker.md"),
	};
}

async function until(predicate: () => boolean, timeoutMs = CONDITION_WAIT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), "condition never held");
}

test.each(["unwritable", "writable"] as const)(
	"an interrupted subagent whose JSONL artifact is %s still delivers session events and completes on the next message (#5224)",
	async (artifactState) => {
		const env = await liveChildEnvironment(cleanups);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block", {}, { id: "block-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("answered the next message"),
		]);
		const artifactsDir = join(env.root, "artifacts");
		const runId = `interrupt-artifact-${artifactState}`;
		const { jsonlPath } = getArtifactPaths(artifactsDir, runId, "worker", 0);
		const appendFile = fs.appendFile;
		let artifactWritten = false;
		let failArtifactWrites = false;
		let rejectedArtifactWrites = 0;
		vi.spyOn(fs, "appendFile").mockImplementation(async (path, ...args) => {
			// Leave the live file in place and let at least one append succeed before injecting the failure (#6813).
			if (path === jsonlPath && artifactWritten && failArtifactWrites) {
				rejectedArtifactWrites += 1;
				throw Object.assign(new Error("Cannot append to artifact"), { code: "EISDIR" });
			}
			await appendFile(path, ...args);
			if (path === jsonlPath) artifactWritten = true;
		});
		let source: TaskTranscriptSource | undefined;
		const stop = new AbortController();
		let settled = false;
		let settledTurns = 0;
		const run = runSingleInProcess(env.root, agent(env.root), "run until interrupted", {
			...env.options(runId, {
				signal: stop.signal,
				index: 0,
				artifactsDir,
				artifactConfig: {
					enabled: true,
					includeInput: true,
					includeOutput: true,
					includeJsonl: true,
					includeMetadata: true,
					cleanupDays: 7,
				},
				taskExecution: {
					signal: stop.signal,
					reportActivity() {},
					bindTranscript(bound) {
						if (source !== undefined || bound.chatSession === undefined) return;
						source = bound;
						(bound.chatSession as AgentSession).subscribe((event) => {
							if (event.type === "agent_settled") settledTurns += 1;
						});
					},
					onExecution() {},
				},
			}),
		}).finally(() => {
			settled = true;
		});
		let unsubscribeLater: (() => void) | undefined;
		try {
			await until(() => env.blockStarted(), LIVE_CHILD_START_WAIT_MS);
			const session = source!.chatSession as AgentSession;
			await source!.interruptTurn!();
			await until(() => settledTurns === 1 && !source!.isRunning?.());
			let laterSettledTurns = 0;
			unsubscribeLater = source!.subscribe!((event) => {
				if (event.type === "agent_settled") laterSettledTurns += 1;
			});
			failArtifactWrites = artifactState === "unwritable";
			await session.sendCustomMessage(
				{ customType: "intercom", content: "finish the task", display: true },
				{ triggerTurn: true },
			);
			await until(() => settledTurns === 2);
			assert.equal(laterSettledTurns, 1);
			await until(() => settled);
			const result = await run;
			assert.equal(existsSync(jsonlPath), true);
			assert.equal(rejectedArtifactWrites, artifactState === "unwritable" ? 1 : 0);
			assert.equal(result.status, "ok");
			assert.equal(result.finalOutput, "answered the next message");
		} finally {
			unsubscribeLater?.();
			stop.abort("user");
			await run.catch(() => undefined);
		}
	},
	LIVE_CHILD_TIMEOUT_MS,
);
