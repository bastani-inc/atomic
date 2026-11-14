import assert from "node:assert/strict";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ToolDefinition } from "../src/core/extensions/index.js";
import type { OperationId, TaskId } from "../src/core/tasks/contracts.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { createHarness, type Harness } from "./suite/harness.js";

const MINUTE = 60_000;
const HEARTBEAT = "♥ Task heartbeat";
const harnesses: Harness[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const harness of harnesses.splice(0)) {
		await harness.session.closeSessionTasks();
		harness.cleanup();
	}
});

/** A tool that runs until its call is aborted, so an interrupt can land mid-tool-call. */
const blockingTool: ToolDefinition = {
	name: "block",
	label: "Block",
	description: "Runs until it is cancelled",
	parameters: Type.Object({}),
	execute: (_toolCallId, _params, signal) =>
		new Promise((_resolve, reject) => {
			const stop = () => reject(new Error("Operation aborted"));
			if (signal?.aborted) stop();
			else signal?.addEventListener("abort", stop, { once: true });
		}),
};

async function sessionHarness(settings: Record<string, unknown> = {}, tools: ToolDefinition[] = []): Promise<Harness> {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const harness = await createHarness({
		initialActiveToolNames: ["bash", "block", ...tools.map((tool) => tool.name)],
		customTools: [blockingTool, ...tools],
		settings: { tasks: { heartbeatMs: MINUTE, ...settings } },
	});
	harnesses.push(harness);
	return harness;
}

function bash(session: AgentSession) {
	const registered = session.agent.state.tools.find((item) => item.name === "bash");
	assert.ok(registered, "bash must be registered on the session");
	return registered;
}

async function launch(session: AgentSession, command = "read value"): Promise<TaskId> {
	const result = await bash(session).execute("launch", { command, wait: { kind: "background" }, timeout: 600 });
	const observation = (result.details as BashToolDetails).observation;
	assert.equal(observation?.kind, "yielded");
	return observation.taskId;
}

async function release(session: AgentSession, taskId: TaskId): Promise<void> {
	const host = session.getAgentTaskHost();
	const task = host.resolveTask(taskId);
	assert.ok(task.ok);
	const { supervisor } = host.ownerBinding;
	const input = supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("done\n"),
	});
	await host.waitForTask(taskId);
}

function contextText(context: Context): string {
	return JSON.stringify(context.messages);
}

function lastMessageText(context: Context): string {
	return JSON.stringify(context.messages.at(-1));
}

/** Runs a turn the user interrupts as Esc does: pause queued input, then abort. */
async function interrupt(harness: Harness, where: "text" | "tool"): Promise<void> {
	const started = Promise.withResolvers<void>();
	const blockingResponse = async (_context: Context, options?: { signal?: AbortSignal }) => {
		started.resolve();
		await new Promise<void>((resolve) => {
			if (options?.signal?.aborted) resolve();
			else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage("partial answer");
	};
	if (where === "text") harness.setResponses([blockingResponse]);
	else {
		harness.setResponses([fauxAssistantMessage([fauxToolCall("block", {})], { stopReason: "toolUse" })]);
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") started.resolve();
		});
	}
	const active = harness.session.prompt("Start the long job.");
	await started.promise;
	harness.session.pauseQueuedMessages();
	await harness.session.abort();
	await active;
	assert.equal(harness.session.isStreaming, false);
	assert.equal(harness.getPendingResponseCount(), 0);
}

function turnStarts(harness: Harness): number {
	return harness.eventsOfType("agent_start").length;
}

/** The model contexts of the turns started after `from`, recorded by each answer. */
function answerHeartbeats(harness: Harness, count: number): Context[] {
	const seen: Context[] = [];
	harness.setResponses(
		Array.from({ length: count }, (_, index) => (context: Context) => {
			seen.push(context);
			return fauxAssistantMessage(`Heartbeat handled ${index + 1}; the job keeps running.`);
		}),
	);
	return seen;
}

for (const where of ["text", "tool"] as const)
	test.runIf(process.platform !== "win32")(
		`a task heartbeat starts one turn right away when the chat is idle after an interrupt mid-${where === "text" ? "response" : "tool-call"} (#4795)`,
		async () => {
			const harness = await sessionHarness();
			const { session } = harness;
			const taskId = await launch(session);
			await interrupt(harness, where);
			const before = turnStarts(harness);
			const seen = answerHeartbeats(harness, 2);

			await vi.advanceTimersByTimeAsync(MINUTE + 1000);
			await vi.waitFor(() => assert.equal(seen.length, 1), { timeout: 5000 });
			await vi.waitFor(() => assert.equal(session.isStreaming, false), { timeout: 5000 });

			assert.equal(turnStarts(harness) - before, 1, "one turn, started without the user");
			assert.match(lastMessageText(seen[0]!), new RegExp(`${HEARTBEAT} \\(shell ${taskId}`));
			assert.equal(
				contextText(seen[0]!).match(/Start the long job\./g)?.length,
				1,
				"the interrupted prompt is not replayed",
			);
			assert.equal(session.queuedMessagesPaused, false);
			await release(session, taskId);
		},
	);

test.runIf(process.platform !== "win32")(
	"a task heartbeat for a busy chat still waits for the current tool call (#4795)",
	async () => {
		const toolStarted = Promise.withResolvers<void>();
		const finishTool = Promise.withResolvers<void>();
		const slowTool: ToolDefinition = {
			name: "slow",
			label: "Slow",
			description: "Finishes when the test says so",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await finishTool.promise;
				return { content: [{ type: "text", text: "slow done" }], details: undefined };
			},
		};
		const harness = await sessionHarness({}, [slowTool]);
		const { session } = harness;
		const taskId = await launch(session);
		const seen: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("Tool done and heartbeat read.");
			},
		]);
		const turn = session.prompt("Run the slow tool.");
		await toolStarted.promise;
		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await vi.waitFor(() =>
			assert.ok(session.sessionManager.getEntries().some((entry) => entry.type === "custom_message")),
		);
		assert.equal(seen.length, 0, "the heartbeat does not cut into the running tool call");
		finishTool.resolve();
		await turn;

		assert.equal(turnStarts(harness), 1, "the heartbeat joined the running turn");
		const text = contextText(seen[0]!);
		assert.ok(text.indexOf("slow done") < text.indexOf(HEARTBEAT), "delivered after the tool result");
		await release(session, taskId);
	},
);

test.runIf(process.platform !== "win32")(
	"heartbeats due together after an interrupt start one turn that stacks them (#4795)",
	async () => {
		const harness = await sessionHarness();
		const { session } = harness;
		const first = await launch(session, "echo one; read value");
		const second = await launch(session, "echo two; read value");
		await interrupt(harness, "text");
		const before = turnStarts(harness);
		const seen = answerHeartbeats(harness, 3);

		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await vi.waitFor(() => assert.equal(seen.length, 1), { timeout: 5000 });
		await vi.waitFor(() => assert.equal(session.isStreaming, false), { timeout: 5000 });

		assert.equal(turnStarts(harness) - before, 1);
		const delivered = lastMessageText(seen[0]!);
		assert.ok(delivered.includes(`shell ${first}`) && delivered.includes(`shell ${second}`), delivered);
		await release(session, first);
		await release(session, second);
	},
);

test.runIf(process.platform !== "win32")(
	"heartbeats arriving while a heartbeat turn is starting join that turn (#4795)",
	async () => {
		const harness = await sessionHarness();
		const { session } = harness;
		await interrupt(harness, "text");
		const before = turnStarts(harness);
		const seen = answerHeartbeats(harness, 3);
		const options = {
			triggerTurn: true,
			deliverAs: "steer",
			persistWhenStreaming: true,
			wakeIdleSession: true,
		} as const;
		const card = (id: number) => ({
			customType: "probe-heartbeat",
			content: `${HEARTBEAT} probe ${id}`,
			display: true,
			details: { id },
		});

		await Promise.all([session.sendCustomMessage(card(1), options), session.sendCustomMessage(card(2), options)]);
		await vi.waitFor(() => assert.ok(seen.length >= 1), { timeout: 5000 });
		await vi.waitFor(() => assert.equal(session.isStreaming, false), { timeout: 5000 });

		assert.equal(turnStarts(harness) - before, 1, "one turn for both");
		const text = contextText(seen.at(-1)!);
		assert.ok(text.includes("probe 1") && text.includes("probe 2"), text);
	},
);

test.runIf(process.platform !== "win32")(
	"with tasks.heartbeatWakesIdleSession off, a heartbeat after an interrupt waits for the user (#4795)",
	async () => {
		const harness = await sessionHarness({ heartbeatWakesIdleSession: false });
		const { session } = harness;
		const taskId = await launch(session);
		await interrupt(harness, "text");
		const before = turnStarts(harness);
		const seen = answerHeartbeats(harness, 1);

		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await vi.waitFor(() =>
			assert.ok(
				session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.customType === "task-heartbeat"),
			),
		);
		await vi.advanceTimersByTimeAsync(5000);
		assert.equal(turnStarts(harness), before, "no turn until the user sends a message");
		assert.equal(seen.length, 0);
		assert.equal(session.queuedMessagesPaused, true);
		await release(session, taskId);
	},
);

test.runIf(process.platform !== "win32")(
	"a heartbeat never sends text the user typed but has not sent (#4795)",
	async () => {
		const harness = await sessionHarness();
		const { session } = harness;
		const taskId = await launch(session);
		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("partial answer");
			},
		]);
		const active = session.prompt("Start the long job.");
		await started.promise;
		await session.steer("typed but not meant to send yet");
		// Ctrl+C keeps typed messages queued; it does not put them back in the editor as Esc does.
		session.pauseQueuedMessages();
		await session.abort();
		await active;
		const before = turnStarts(harness);
		const seen = answerHeartbeats(harness, 1);

		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await vi.waitFor(() =>
			assert.ok(
				session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.customType === "task-heartbeat"),
			),
		);
		await vi.advanceTimersByTimeAsync(5000);
		assert.equal(turnStarts(harness), before, "the typed text is not sent by a heartbeat");
		assert.equal(seen.length, 0);
		assert.deepEqual(session.getSteeringMessages(), ["typed but not meant to send yet"]);
		await release(session, taskId);
	},
);

test.runIf(process.platform !== "win32")(
	"a heartbeat turn does not wake the chat again before the next heartbeat is due (#4795)",
	async () => {
		const harness = await sessionHarness();
		const { session } = harness;
		const taskId = await launch(session);
		await interrupt(harness, "text");
		const before = turnStarts(harness);
		const seen = answerHeartbeats(harness, 3);

		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await vi.waitFor(() => assert.equal(seen.length, 1), { timeout: 5000 });
		await vi.waitFor(() => assert.equal(session.isStreaming, false), { timeout: 5000 });
		await vi.advanceTimersByTimeAsync(MINUTE - 10_000);
		assert.equal(turnStarts(harness) - before, 1, "nothing more until the next boundary");

		await vi.advanceTimersByTimeAsync(10_000);
		await vi.waitFor(() => assert.equal(seen.length, 2), { timeout: 5000 });
		await vi.waitFor(() => assert.equal(session.isStreaming, false), { timeout: 5000 });
		assert.equal(turnStarts(harness) - before, 2, "one turn per heartbeat");
		await release(session, taskId);
	},
);
