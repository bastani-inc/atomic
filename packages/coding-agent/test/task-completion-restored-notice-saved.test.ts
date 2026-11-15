import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { describe, test, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.js";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import {
	pendingTaskCompletionIntents,
	TASK_COMPLETION_MESSAGE_TYPE,
	type TaskCompletionEnvelope,
	TaskCompletionOutbox,
} from "../src/core/tasks/completion.js";
import type { OwnerId, Sequence, TaskId } from "../src/core/tasks/contracts.js";
import { createHarness } from "./suite/harness.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/restored-task-notice-host.ts", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const COMPLETION_ID = "completion-from-earlier-process";
/** Loading the agent session through jiti in a new process: structural, not a slow test. */
const HOST_TIMEOUT_MS = 120_000;

const intent: TaskCompletionEnvelope = {
	completionId: COMPLETION_ID,
	ownerId: "owner-9-9" as OwnerId,
	taskId: "task-9-9-0" as TaskId,
	terminalSequence: "7" as Sequence,
	result: { kind: "failed", code: "fixture", message: "done" },
	display: false,
	taskKind: "agent",
};

function notices(manager: SessionManager): number {
	return manager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === TASK_COMPLETION_MESSAGE_TYPE &&
				entry.stageAdmissionKey === COMPLETION_ID,
		).length;
}

/** After any crash a completion is either still owed or shown, never both and never neither. */
function assertOwedOrShownOnce(manager: SessionManager): void {
	const pending = pendingTaskCompletionIntents(manager).length;
	const shown = notices(manager);
	assert.ok(
		(pending === 1 && shown === 0) || (pending === 0 && shown === 1),
		`pending intents ${pending}, saved notices ${shown}`,
	);
}

function blockingTool(entered: PromiseWithResolvers<void>, gate: Promise<void>) {
	return {
		name: "block",
		label: "block",
		description: "a tool that runs until released",
		parameters: Type.Object({}),
		async execute() {
			entered.resolve();
			await gate;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	} as never;
}

describe("restored task completion notices are acknowledged only once saved", () => {
	test("a notice restored while a turn streams is saved before its acknowledgement and shown once (#5047)", async () => {
		const root = mkdtempSync(join(tmpdir(), "restored-notice-"));
		const dir = join(root, "sessions");
		const manager = await SessionManager.create(root, dir);
		await manager.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
		await manager.appendCustomEntry("task-completion-intent", intent);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const harness = await createHarness({
			sessionManager: manager,
			customTools: [blockingTool(entered, gate.promise)],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		try {
			const session = harness.session as unknown as AgentSessionInternalSurface;
			const turn = harness.session.prompt("go");
			await entered.promise;
			assert.equal(harness.session.isStreaming, true);
			session.getAgentTaskHost();
			await session._taskCompletionOutbox!.flushRestored();

			// A crash now leaves exactly what the file holds.
			assertOwedOrShownOnce(await SessionManager.open(manager.getSessionFile()!, dir, root));

			gate.resolve();
			await turn;
			await vi.waitFor(() => assert.equal(pendingTaskCompletionIntents(manager).length, 0));
			assert.equal(notices(manager), 1);
			assertOwedOrShownOnce(await SessionManager.open(manager.getSessionFile()!, dir, root));
		} finally {
			gate.resolve();
			await harness.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(
		"killing the process mid-turn after a restored flush leaves the notice owed or shown once, and reopening shows it once (#5047)",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "restored-notice-kill-"));
			const dir = join(root, "sessions");
			const child = spawn(process.execPath, ["--import", "jiti/register", FIXTURE, root, dir], {
				cwd: REPOSITORY,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			let output = "";
			let errors = "";
			child.stderr.on("data", (chunk: Buffer) => {
				errors += chunk.toString();
			});
			try {
				const ready = await new Promise<{ file: string }>((resolve, reject) => {
					child.stdout.on("data", (chunk: Buffer) => {
						output += chunk.toString();
						const line = output.split("\n").find((candidate) => candidate.startsWith("{"));
						if (line && output.includes("\n")) resolve(JSON.parse(line) as { file: string });
					});
					child.once("exit", () => reject(new Error(`the host ended before it was ready: ${errors}`)));
				});
				child.kill("SIGKILL");
				await ended;

				const reopened = await SessionManager.open(ready.file, dir, root);
				assertOwedOrShownOnce(reopened);

				const harness = await createHarness({ sessionManager: reopened });
				try {
					const session = harness.session as unknown as AgentSessionInternalSurface;
					session.getAgentTaskHost();
					await session._taskCompletionOutbox!.flushRestored();
					assert.equal(pendingTaskCompletionIntents(reopened).length, 0);
					assert.equal(notices(reopened), 1);
				} finally {
					await harness.cleanup();
				}
			} finally {
				child.kill("SIGKILL");
				await ended;
				rmSync(root, { recursive: true, force: true });
			}
		},
		HOST_TIMEOUT_MS,
	);

	test("an intent whose notice was saved before a crash is acknowledged without a second notice (#5047)", async () => {
		const session = await SessionManager.create(new MemorySessionStore(), process.cwd());
		await session.appendCustomEntry("task-completion-intent", intent);
		await session.appendCustomMessageEntry(
			TASK_COMPLETION_MESSAGE_TYPE,
			"notice",
			true,
			undefined,
			undefined,
			undefined,
			COMPLETION_ID,
		);
		const admitted: string[] = [];
		const restoredDelivered: string[] = [];
		const outbox = new TaskCompletionOutbox(
			session,
			() => true,
			async (envelope) => {
				admitted.push(envelope.completionId);
			},
			() => {},
			() => true,
			(envelope) => restoredDelivered.push(envelope.completionId),
		);

		assert.equal(await outbox.flushRestored(), 1);
		assert.deepEqual(admitted, []);
		assert.deepEqual(restoredDelivered, [COMPLETION_ID]);
		assert.equal(pendingTaskCompletionIntents(session).length, 0);
	});
});
