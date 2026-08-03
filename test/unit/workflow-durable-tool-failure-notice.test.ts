import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/agent-session-persistent-custom-messages.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type {
	ExtensionAPI,
	PiExecuteContext,
	PiToolOpts,
	WorkflowToolArgs,
} from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { registerWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore, store as workflowStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures.js";
import { sleep } from "../helpers/runtime.js";
import { lifecycleConfig } from "./workflow-lifecycle-parent-reconciliation-support.js";

interface PersistedEntry {
	readonly id: string;
	readonly type: string;
	readonly payload: Record<string, WorkflowSerializableValue>;
}

describe("interactive durable tool failure lifecycle", () => {
	let harness: Harness | undefined;
	let unsubscribeLifecycle: (() => void) | undefined;

	afterEach(() => {
		unsubscribeLifecycle?.();
		unsubscribeLifecycle = undefined;
		harness?.cleanup();
		harness = undefined;
		workflowStore.clear();
		setDurableBackend(undefined);
	});

	test("reports one failed notice and reconciliation when a post-admission durable callback throws", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const store = workflowStore;
		store.clear();
		const jobs = createJobTracker();
		const cancellation = createCancellationRegistry();
		const callbackEntered = Promise.withResolvers<void>();
		const releaseFailure = Promise.withResolvers<void>();
		const persisted: PersistedEntry[] = [];
		const lifecycleState = createWorkflowLifecycleNotificationState();
		const definition = workflow({
			name: "post-admission-tool-failure",
			description: "Fail a durable tool after named-run startup admission.",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("commit-docs", {}, async () => {
					callbackEntered.resolve();
					await releaseFailure.promise;
					throw Object.assign(new Error("outer callback wrapper"), {
						code: "CANCELLED",
						cause: Object.assign(new Error("commit hook rejected docs"), {
							exitCode: 1,
							stderr: "docs check failed",
						}),
					});
				});
				return {};
			},
		});
		const runtime = createExtensionRuntime({
			definitions: [definition],
			store,
			jobs,
			cancellation,
			persistence: {
				appendEntry(type, payload) {
					const id = `entry-${persisted.length + 1}`;
					persisted.push({ id, type, payload: { ...payload } as Record<string, WorkflowSerializableValue> });
					return id;
				},
				setLabel() {},
			},
		});
		const executeWorkflow = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => undefined,
		);
		let registeredTool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
		const extensionApi = {
			registerTool(options: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>) {
				registeredTool = options;
			},
		} as ExtensionAPI;
		let launchPolicyMode: string | undefined;
		registerWorkflowTool(extensionApi, executeWorkflow, async (policy, execute) => {
			launchPolicyMode = policy.mode;
			return await execute();
		});
		assert.ok(registeredTool);
		const interactiveTool = registeredTool;
		const interactiveContext: PiExecuteContext = { hasUI: true };
		let runId = "";
		let admissionContext: Context | undefined;
		let providerContext: Context | undefined;
		let failureReleased = false;
		const workflowTool: AgentTool = {
			name: interactiveTool.name,
			label: interactiveTool.label,
			description: interactiveTool.description,
			parameters: interactiveTool.parameters as AgentTool["parameters"],
			execute: async (toolCallId, params, signal) => {
				const result = await interactiveTool.execute(
					toolCallId,
					params as WorkflowToolArgs,
					signal,
					undefined,
					interactiveContext,
				);
				runId = result.details.action === "run" ? result.details.runId : "";
				return {
					content: result.content.map((part) => {
						if (part.type !== "text") throw new Error("unexpected workflow tool image result");
						return part;
					}),
					details: result.details,
				};
			},
		};
		harness = await createHarness({ tools: [workflowTool] });
		unsubscribeLifecycle = installWorkflowLifecycleNotifications({
			store,
			state: lifecycleState,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => harness!.session.sendCustomMessage(message, options),
		});
		harness.session.subscribe((event) => {
			if (
				!failureReleased &&
				harness!.faux.state.callCount === 2 &&
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				failureReleased = true;
				releaseFailure.resolve();
			}
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"workflow",
					{
						action: "run",
						workflow: "post-admission-tool-failure",
					},
					{ id: "workflow-call-post-admission" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				admissionContext = context;
				return fauxAssistantMessage("The admitted workflow is still running.");
			},
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("I inspected the failed workflow notice.");
			},
		]);

		const prompt = harness.session.prompt("Run post-admission-tool-failure.");
		await Promise.race([
			callbackEntered.promise,
			sleep(2_000).then(() => {
				throw new Error(
					`callback did not start; calls=${harness!.faux.state.callCount} messages=${JSON.stringify(harness!.session.messages)} runs=${JSON.stringify(store.runs())}`,
				);
			}),
		]);
		await Promise.race([
			prompt,
			sleep(2_000).then(() => {
				throw new Error(
					`prompt did not settle; calls=${harness!.faux.state.callCount} released=${failureReleased} runs=${JSON.stringify(store.runs())}`,
				);
			}),
		]);

		const failed = store.runs().find((run) => run.id === runId);
		assert.ok(failed);
		assert.equal(failed.status, "failed");
		assert.equal(failed.failureKind, "unknown");
		assert.equal(failed.failureCode, "unknown");
		assert.equal(failed.failureRecoverability, "unknown");
		assert.equal(failed.failureDisposition, "terminal_failed");
		assert.equal(failed.error, "commit hook rejected docs");
		assert.equal(failed.toolNodes?.length, 1);
		assert.equal(failed.toolNodes?.[0]?.status, "failed");
		assert.equal(failed.toolNodes?.[0]?.error, "commit hook rejected docs");
		assert.equal(failed.failedToolNodeId, failed.toolNodes?.[0]?.id);
		const persistedRunEnd = persisted.find(
			(entry) => entry.type === "workflow.run.end" && entry.payload.runId === runId,
		);
		assert.equal(persistedRunEnd?.payload.failedToolNodeId, failed.failedToolNodeId);
		assert.equal((persistedRunEnd?.payload.failedToolNode as { status?: string } | undefined)?.status, "failed");
		const failureCheckpoint = backend
			.listCheckpoints(runId)
			.find((checkpoint) => checkpoint.kind === "tool" && checkpoint.throwingFailureError !== undefined);
		assert.equal(failureCheckpoint?.kind, "tool");
		assert.equal(
			failureCheckpoint?.kind === "tool" ? failureCheckpoint.throwingFailureError : undefined,
			"commit hook rejected docs",
		);
		assert.equal(backend.getToolCheckpoint(runId, failed.toolNodes![0]!.argsHash), undefined);
		assert.equal(failureReleased, true, "the durable callback fails only after the startup result reaches chat");
		assert.ok(admissionContext);
		const admittedResult = admissionContext.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "workflow",
		);
		assert.equal(admittedResult?.role, "toolResult");
		assert.equal(
			admittedResult?.role === "toolResult"
				? (admittedResult.details as { status?: string } | undefined)?.status
				: undefined,
			"running",
			"the callback must throw only after the named launch reports startup admission",
		);
		assert.equal(launchPolicyMode, "interactive");
		assert.equal(harness.faux.state.callCount, 3, "the hidden reconciliation must schedule a correcting turn");

		const cards = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		);
		assert.equal(cards.length, 1);
		const details = cards[0]?.role === "custom" ? (cards[0].details as WorkflowLifecycleNoticeDetails) : undefined;
		assert.equal(details?.kind, "failed");
		assert.equal(details?.runId, runId);
		assert.equal(details?.error, "commit hook rejected docs");
		const cardContent = String(cards[0]?.role === "custom" ? cards[0].content : "");
		assert.ok(cardContent.includes(runId));
		assert.match(cardContent, /commit hook rejected docs/);
		assert.doesNotMatch(cardContent, /outer callback wrapper/);

		assert.ok(providerContext);
		assert.equal(
			providerContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes(`failed (run ${runId}`),
			).length,
			1,
			"the failed notice must trigger one hidden reconciliation turn",
		);
		assert.equal(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
				).length,
			1,
		);
		const status = await interactiveTool.execute(
			"workflow-status-after-failure",
			{ action: "status", runId },
			undefined,
			undefined,
			interactiveContext,
		);
		assert.equal(status.details.action, "statusDetail");
		assert.ok("detail" in status.details);
		assert.equal(status.details.detail.status, "failed");
		assert.equal(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length,
			1,
			"status inspection must not duplicate the notice",
		);

		unsubscribeLifecycle();
		unsubscribeLifecycle = undefined;
		store.removeRun(runId);
		const productionState = createWorkflowExtensionRuntimeState({} as ExtensionAPI, {} as never);
		const resumableCatalog = await productionState.runtimeProxy.prepareDurableResumable(runId);
		const completedCatalog = await productionState.runtimeProxy.prepareCompletedDurable?.();
		assert.deepEqual(
			resumableCatalog.map((entry) => entry.workflowId),
			[runId],
			"a checkpointed resumable failure must remain on the execution-resume path",
		);
		assert.deepEqual(
			completedCatalog?.map((entry) => entry.workflowId),
			[],
			"completed history must not shadow a resumable failed root",
		);
		assert.equal(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length,
			1,
			"durable catalog inspection must not duplicate the notice",
		);

		const restoredStore = createStore();
		restoreOnSessionStart(
			{ getEntries: () => persisted as SessionEntry[] },
			{ resumeInFlight: "never", persistRuns: true },
			restoredStore,
		);
		const restored = restoredStore.runs().find((run) => run.id === runId);
		assert.equal(restored?.status, "failed");
		assert.equal(restored?.failureKind, "unknown");
		assert.equal(restored?.failureCode, "unknown");
		assert.equal(restored?.failureRecoverability, "unknown");
		assert.equal(restored?.failureDisposition, "terminal_failed");
		assert.equal(restored?.failedToolNodeId, failed.failedToolNodeId);
		assert.equal(restored?.toolNodes?.length, 1);
		assert.equal(restored?.toolNodes?.[0]?.id, failed.failedToolNodeId);
		assert.equal(restored?.toolNodes?.[0]?.name, "commit-docs");
		assert.equal(restored?.toolNodes?.[0]?.status, "failed");
		assert.equal(restored?.toolNodes?.[0]?.error, "commit hook rejected docs");
		const restoredNotices: WorkflowLifecycleNoticeDetails[] = [];
		const stopRestoredNotifications = installWorkflowLifecycleNotifications({
			store: restoredStore,
			state: createWorkflowLifecycleNotificationState(),
			config: lifecycleConfig,
			sendMessage(message) {
				restoredNotices.push((message as { details: WorkflowLifecycleNoticeDetails }).details);
			},
		});
		stopRestoredNotifications();
		assert.deepEqual(
			restoredNotices,
			[],
			"restoring a historical terminal run must seed dedupe without re-notifying",
		);
	});

	test("keeps abort wrappers with empty process buffers classified as cancellation", () => {
		const failure = classifyWorkflowFailure({
			name: "AbortError",
			message: "workflow killed",
			code: "ABORT_ERR",
			exitCode: null,
			stdout: "",
			stderr: new Uint8Array(),
		});
		assert.equal(failure.kind, "cancelled");
		assert.equal(failure.code, "cancelled");
		assert.equal(failure.disposition, "terminal_killed");
	});

	test("lets nested command failure evidence beat a cancellation-like wrapper", () => {
		const failure = classifyWorkflowFailure(
			Object.assign(new Error("wrapper aborted"), {
				code: "CANCELLED",
				cause: Object.assign(new Error("commit hook rejected docs"), {
					exitCode: 1,
					stderr: "docs check failed",
				}),
			}),
		);
		assert.equal(failure.kind, "unknown");
		assert.equal(failure.code, "unknown");
		assert.equal(failure.disposition, "terminal_failed");
	});

	test("lets aggregate command failure evidence beat a cancellation-like member", () => {
		const failure = classifyWorkflowFailure(
			new AggregateError(
				[
					Object.assign(new Error("commit hook rejected docs"), {
						code: "CANCELLED",
						exitCode: 1,
						stderr: "docs check failed",
					}),
				],
				"aggregate command failure",
			),
		);
		assert.equal(failure.kind, "unknown");
		assert.equal(failure.code, "unknown");
		assert.equal(failure.disposition, "terminal_failed");
	});
});
