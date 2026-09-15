import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import {
	createExtensionRuntime,
	getExtensionRuntimeEventBus,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import type { SupervisorAuthorization } from "../../packages/intercom/broker/client.js";
import type { InboundMessageEntry } from "../../packages/intercom/intercom-utils.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const root = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "history-broker-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { createHarness } = await import("../../packages/coding-agent/test/suite/harness.js");
const brokerReceipts: string[] = [];

beforeAll(async () => {
	const broker = spawn(
		process.execPath,
		[
			getJitiCliPath(join(root, "packages/intercom")),
			join(root, "test/fixtures/intercom-supervisor-history-broker.ts"),
		],
		{
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	brokerFixture.trackBroker(broker);
	let pending = "";
	broker.stdout!.on("data", (chunk: Buffer) => {
		pending += chunk.toString();
		for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
			const line = pending.slice(0, end);
			pending = pending.slice(end + 1);
			brokerReceipts.push(line);
			process.stdout.write(`BROKER ${line}\n`);
		}
	});
	broker.stderr!.on("data", (chunk: Buffer) => console.error(chunk.toString()));
	await vi.waitFor(
		async () => {
			brokerFixture.assertRunning();
			assert.ok(
				await new Promise<boolean>((done) => {
					const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
					socket.once("connect", () => {
						socket.destroy();
						done(true);
					});
					socket.once("error", () => done(false));
				}),
			);
		},
		{ timeout: 10_000, interval: 20 },
	);
});
afterAll(() => brokerFixture.cleanup());

// #3039: these are instrumented schedules, not attribution of the historical incident.
for (const busy of ["model", "tool"] as const) {
	test(`real broker supervisor snapshots and owner completion remain bounded while parent is busy in ${busy}`, async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const result = Promise.withResolvers<TaskResult>();
		const runId = `history-${busy}-run`;
		const childName = `history-${busy}-child`;
		const lateId = `${busy}-U3`;
		let activeSignal: AbortSignal | undefined;
		let context!: ExtensionContext;
		let api!: ExtensionAPI;
		let taskId = "not-started";
		let childId = "not-connected";
		let parentBrokerId = "not-connected";
		const trace: Array<{ boundary: string; id: string; at: number }> = [];
		const record = (boundary: string, id: string, extra: object = {}) => {
			const row = {
				boundary,
				id,
				at: Date.now(),
				runId,
				taskId,
				childId,
				parentBrokerId,
				parentSession: context?.sessionManager.getSessionId(),
				generation: "single unchanged session_start",
				busy,
				...extra,
			};
			trace.push(row);
			process.stdout.write(`HISTORY ${JSON.stringify(row)}\n`);
		};
		const working: AgentTool = {
			name: "history_work",
			label: "History work",
			description: "Finite test gate",
			parameters: Type.Object({}),
			async execute(_id, _args, signal) {
				activeSignal = signal;
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "work finished" }], details: {} };
			},
		};
		// Match production: task completion and extensions must share the runtime event bus.
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				api = pi;
				intercomHeavy(pi);
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
			root,
			getExtensionRuntimeEventBus(runtime),
			runtime,
			"<history-intercom>",
		);
		const parent = await createHarness({
			tools: [working],
			fauxProvider: { provider: `faux-history-${busy}` },
			settings: { sessionSummary: { enabled: false } },
			resourceLoader: createTestResourceLoader({
				extensionsResult: { runtime, extensions: [extension], errors: [] },
			}),
		});
		await parent.session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
		const child = new IntercomClient();
		let forwardLate: (() => boolean) | undefined;
		const emit = IntercomClient.prototype.emit;
		const spy = vi.spyOn(IntercomClient.prototype, "emit").mockImplementation(function (
			this: InstanceType<typeof IntercomClient>,
			event,
			...args
		) {
			if (event === "message") {
				const [from, message, channel] = args as [SessionInfo, Message, "supervisor" | undefined];
				if (channel === "supervisor" && message.source?.subagentRunId === runId) {
					record("parent-transport-receipt", message.id, {
						sentAt: message.timestamp,
						from: from.id,
						name: from.name,
						hasUI: context.hasUI,
						idle: context.isIdle(),
					});
					const forward = () => {
						record("handler-admission-entry", message.id);
						return emit.call(this, event, ...args);
					};
					if (message.id === lateId) {
						forwardLate = forward;
						return true;
					}
					return forward();
				}
			}
			return emit.call(this, event, ...args);
		});
		const visible: InboundMessageEntry[] = [];
		const unsubscribe = parent.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "custom") return;
			if (event.message.customType === "task-completion") record("sdk-message-end", "terminal");
			if (event.message.customType !== "intercom_message") return;
			const entry = event.message.details as InboundMessageEntry;
			visible.push(entry);
			record("sdk-message-end", entry.message.id, {
				sentAt: entry.message.timestamp,
				sdkTimestamp: event.message.timestamp,
				content: event.message.content,
			});
			const renderer = extension.messageRenderers.get("intercom_message");
			assert.ok(renderer);
			const component = renderer(
				event.message,
				{} as never,
				{ fg: (_color: string, text: string) => text } as never,
			);
			assert.ok(component);
			const lines = component.render(240);
			record("registered-renderer", entry.message.id, { lines });
			assert.match(lines.join("\n"), /not current task status/);
		});
		let execution: Promise<void> | undefined;
		try {
			const authorization: { childName: string; completion?: Promise<SupervisorAuthorization> } = { childName };
			api.events.emit("subagent:supervisor-authorization", authorization);
			assert.ok(authorization.completion);
			const granted = await authorization.completion;
			parentBrokerId = granted.supervisorSessionId;
			await child.connect(
				{
					name: childName,
					cwd: root,
					model: "test-child",
					pid: process.pid,
					startedAt: Date.now(),
					lastActivity: Date.now(),
					group: "isolated-child",
				},
				granted,
				undefined,
				{ subagentRunId: runId, subagentAgent: "worker", subagentIndex: 0 },
			);
			childId = child.sessionId!;
			const host = context.getAgentTaskHost!();
			const launched = await host.startAgentTask(
				{ kind: "agent", agent: "test", task: "history child" },
				`history-${busy}` as OperationId,
				(taskContext) => {
					taskContext.bindTranscript({
						getSessionId: () => childId,
						getEntries: () => [],
						completionSource: { runId, intercomTarget: childName },
					});
					return { result: result.promise, cleanup: Promise.resolve({ kind: "reaped" }) };
				},
			);
			assert.ok(launched.ok);
			taskId = launched.value.taskId;
			await host.observeAgentLaunch(launched.value.taskId, { kind: "background" });
			const watched = host.watchOwnerTasks();
			assert.ok(watched.ok);
			const outcome: TaskResult = { kind: "completed", output: watched.value.snapshot.tasks[0]!.output };
			watched.value.dispose();
			parent.setResponses([
				busy === "tool"
					? () => fauxAssistantMessage(fauxToolCall("history_work", {}), { stopReason: "toolUse" })
					: async () => {
							started.resolve();
							await release.promise;
							return fauxAssistantMessage("parent model finished");
						},
				() => fauxAssistantMessage("parent reconciled historical snapshots and final result"),
				() => fauxAssistantMessage("parent done"),
			]);
			execution = parent.session.prompt("finite parent work");
			await started.promise;
			for (const [suffix, text] of [
				["U1", "Hypothesis: transport bug"],
				["U2", "Correction: historical transport cause is not proved"],
				["U3", "Earlier snapshot: still investigating"],
			]) {
				const id = `${busy}-${suffix}`;
				record("send-invocation", id);
				const receipt = await child.sendToSupervisor(parentBrokerId, {
					messageId: id,
					text: text!,
					expectsReply: false,
				});
				assert.equal(receipt.delivered, true);
				record("broker-forward-confirmed-receipt", id, { receipt });
			}
			await vi.waitFor(() => assert.ok(forwardLate));
			assert.equal(visible.length, 0, "busy parent queues rather than interrupting");
			assert.notEqual(activeSignal?.aborted, true);
			record("child-result-resolved", "terminal");
			result.resolve(outcome);
			await host.waitForTask(launched.value.taskId);
			await vi.waitFor(() =>
				assert.ok(trace.some((row) => row.id === "terminal" && row.boundary === "sdk-message-end")),
			);
			assert.deepEqual(
				visible.map((entry) => entry.message.id),
				[`${busy}-U1`, `${busy}-U2`],
			);
			assert.notEqual(activeSignal?.aborted, true, "completion does not cancel parent's work");
			// Completion has already published while this accepted transport message is unavailable to the handler.
			forwardLate!();
			forwardLate!(); // Replay the same original message through real inbound admission.
			const duplicate = await child.sendToSupervisor(parentBrokerId, {
				messageId: lateId,
				text: "Earlier snapshot: still investigating",
				expectsReply: false,
			});
			assert.equal(duplicate.delivered, true);
			release.resolve();
			await execution;
			await vi.waitFor(() => assert.equal(visible.length, 3));
			assert.deepEqual(
				visible.map((entry) => entry.message.id),
				[`${busy}-U1`, `${busy}-U2`, lateId],
			);
			assert.deepEqual(
				trace.filter((row) => row.boundary === "sdk-message-end").map((row) => row.id),
				[`${busy}-U1`, `${busy}-U2`, "terminal", lateId],
			);
			assert.equal(visible[2]!.message.content.text, "Earlier snapshot: still investigating");
			assert.ok(visible[2]!.message.timestamp <= trace.find((row) => row.id === "terminal")!.at);
			for (const entry of visible) {
				assert.match(entry.bodyText, /later correction or final result supersedes/);
				assert.ok(entry.bodyText.includes(new Date(entry.message.timestamp).toISOString()));
				await vi.waitFor(() =>
					assert.ok(brokerReceipts.some((line) => line.includes(`"id":"${entry.message.id}"`))),
				);
			}
		} finally {
			release.resolve();
			await execution?.catch(() => {});
			unsubscribe();
			spy.mockRestore();
			await child.disconnect();
			await parent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			parent.cleanup();
		}
	});
}
