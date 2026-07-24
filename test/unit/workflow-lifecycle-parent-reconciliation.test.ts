import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/agent-session-persistent-custom-messages.js";
import {
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { assertWorkflowToolOrdering, lifecycleConfig } from "./workflow-lifecycle-parent-reconciliation-support.js";

describe("workflow lifecycle parent reconciliation", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];
	const unsubscriptions: Array<() => void> = [];

	afterEach(() => {
		while (unsubscriptions.length > 0) unsubscriptions.pop()?.();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	test("a terminal notice arriving during stale final text gets one durable card and a later correcting model turn", async () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-fast-final",
			name: "fast-final",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		const workflowTool: AgentTool = {
			name: "workflow",
			label: "Workflow",
			description: "Launch a named workflow",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "Workflow fast-final started in background (run-fast-final). Status: running" }],
				details: { action: "run", runId: "run-fast-final", status: "running" },
			}),
		};
		const harness = await createHarness({ tools: [workflowTool] });
		harnesses.push(harness);
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => harness.session.sendCustomMessage(message, options),
		}));

		let terminalized = false;
		let reconciliationContext: Context | undefined;
		const unsubscribeEvents = harness.session.subscribe((event) => {
			if (
				!terminalized &&
				harness.faux.state.callCount === 2 &&
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-fast-final", "completed", { summary: "finished quickly" }), true);
				store.recordNotice({ id: "duplicate-terminal-snapshot", level: "info", message: "tick", createdAt: 3 });
				harness.session.clearQueue();
			}
		});
		unsubscriptions.push(unsubscribeEvents);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", {}, { id: "workflow-call-fast-final" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The workflow is still proceeding; I will keep monitoring it."),
			(context) => {
				reconciliationContext = context;
				return fauxAssistantMessage("Correction: fast-final already completed successfully.");
			},
		]);

		await harness.session.prompt("Run fast-final and keep me updated.");

		assert.equal(terminalized, true);
		assert.equal(harness.faux.state.callCount, 3, "final-stream notice must cause a safe later reconciliation");
		assert.ok(reconciliationContext);
		assertWorkflowToolOrdering(reconciliationContext);
		assert.equal(
			reconciliationContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "fast-final" completed'),
			).length,
			1,
		);
		const cards = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		);
		assert.equal(cards.length, 1, "duplicate snapshots and queue clearing must not duplicate the terminal card");
		const card = cards[0];
		assert.equal(card?.role, "custom");
		if (card?.role !== "custom") throw new Error("missing lifecycle custom card");
		assert.equal(card.display, true);
		assert.equal(card.content, '✓ Workflow "fast-final" completed (run run-fast-final). Inspect: /workflow status run-fast-final');
		const cardDetails = card.details as WorkflowLifecycleNoticeDetails | undefined;
		assert.equal(cardDetails?.kind, "completed");
		assert.equal(cardDetails?.scope, "run");
		assert.equal(cardDetails?.runId, "run-fast-final");
		assert.equal(cardDetails?.workflowName, "fast-final");
		assert.equal(cardDetails?.status, "completed");
		const terminalRun = store.runs().find((run) => run.id === "run-fast-final");
		assert.equal(cardDetails?.durationMs, terminalRun?.durationMs);
		assert.equal(cardDetails?.createdAt, terminalRun?.endedAt);
		const persistedCards = harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		);
		assert.equal(persistedCards.length, 1, "terminal card must be durable exactly once");
		assert.equal(persistedCards[0]?.type, "custom_message");
		if (persistedCards[0]?.type === "custom_message") {
			assert.equal(persistedCards[0].content, card.content);
			assert.deepEqual(persistedCards[0].details, card.details);
		}
		const staleFinal = harness.session.messages.find(
			(message) => message.role === "assistant" && getMessageText(message).includes("still proceeding"),
		);
		assert.equal(staleFinal?.role, "assistant");
		if (staleFinal?.role === "assistant") assert.equal(staleFinal.stopReason, "stop", "lifecycle delivery must not interrupt unrelated final text");
		assert.equal(
			harness.session.getLastAssistantText(),
			"Correction: fast-final already completed successfully.",
		);
	});

	test("clearQueue at the core-local in-flight boundary does not restore a duplicate notice alias", async () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-clear-in-flight",
			name: "clear-in-flight",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		const harness = await createHarness();
		harnesses.push(harness);
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => harness.session.sendCustomMessage(message, options),
		}));
		let terminalized = false;
		let clearedInFlight = false;
		let reconciliationContext: Context | undefined;
		unsubscriptions.push(harness.session.subscribe((event) => {
			if (!terminalized && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-clear-in-flight", "completed", {}), true);
			}
		}));
		unsubscriptions.push(harness.session.agent.subscribe((event) => {
			if (terminalized && !clearedInFlight && event.type === "turn_start") {
				clearedInFlight = true;
				harness.session.clearQueue();
			}
		}));
		harness.setResponses([
			fauxAssistantMessage("This stale response finishes without lifecycle interruption."),
			(context) => {
				reconciliationContext = context;
				return fauxAssistantMessage("Correction after clear-in-flight completed.");
			},
		]);

		await harness.session.prompt("Wait for clear-in-flight.");

		assert.equal(clearedInFlight, true);
		assert.equal(harness.faux.state.callCount, 2, "the in-flight reference must not be queued a second time");
		assert.ok(reconciliationContext);
		assert.equal(
			reconciliationContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "clear-in-flight" completed'),
			).length,
			1,
		);
		assert.equal(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length,
			1,
		);
		assert.equal(
			harness.sessionManager.getEntries().filter(
				(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length,
			1,
		);
		assert.equal(
			harness.sessionManager.getEntries().filter(
				(entry) => entry.type === "custom_message" && entry.display === false,
			).length,
			1,
			"clear at the in-flight boundary must persist one hidden reconciliation entry",
		);
	});
	test("a transient hidden-reconciliation persistence failure retries without duplicating the durable card", async () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-persist-retry",
			name: "persist-retry",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		const harness = await createHarness();
		harnesses.push(harness);
		const appendCustomMessageEntry = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
		let hiddenPersistenceAttempts = 0;
		harness.sessionManager.appendCustomMessageEntry = ((customType, content, display, details, excludeFromContext) => {
			if (display === false && hiddenPersistenceAttempts++ === 0) {
				throw new Error("transient hidden reconciliation write failure");
			}
			return appendCustomMessageEntry(customType, content, display, details, excludeFromContext);
		}) as typeof harness.sessionManager.appendCustomMessageEntry;
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => harness.session.sendCustomMessage(message, options),
		}));
		let terminalized = false;
		unsubscriptions.push(harness.session.subscribe((event) => {
			if (!terminalized && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-persist-retry", "completed", {}), true);
			}
		}));
		harness.setResponses([
			fauxAssistantMessage("Stale until persistence retry."),
			fauxAssistantMessage("persist-retry corrected."),
		]);

		await harness.session.prompt("Wait for persist-retry.");

		assert.equal(hiddenPersistenceAttempts, 2, "the transient failure retries only hidden persistence");
		assert.equal(harness.faux.state.callCount, 2);
		assert.equal(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length,
			1,
		);
		const customEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		assert.equal(customEntries.filter((entry) => entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE).length, 1);
		assert.equal(customEntries.filter((entry) => entry.display === false).length, 1, "one hidden reconciliation is durable after retry");
	});
	test("session disposal flushes a consumed reconciliation after repeated transient write failures", async () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-dispose-retry",
			name: "dispose-retry",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		const sessionDir = mkdtempSync(join(tmpdir(), "atomic-lifecycle-dispose-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		const appendCustomMessageEntry = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
		let hiddenPersistenceAttempts = 0;
		harness.sessionManager.appendCustomMessageEntry = ((customType, content, display, details, excludeFromContext) => {
			if (customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE && hiddenPersistenceAttempts++ < 2) {
				throw new Error("repeated transient hidden reconciliation write failure");
			}
			return appendCustomMessageEntry(customType, content, display, details, excludeFromContext);
		}) as typeof harness.sessionManager.appendCustomMessageEntry;
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => harness.session.sendCustomMessage(message, options),
		}));
		let terminalized = false;
		let disposeScheduled = false;
		let resolveDisposed!: () => void;
		const disposed = new Promise<void>((resolve) => {
			resolveDisposed = resolve;
		});
		unsubscriptions.push(harness.session.subscribe((event) => {
			if (!terminalized && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-dispose-retry", "failed", { error: "boom" }), true);
				return;
			}
			if (
				!disposeScheduled &&
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE
			) {
				disposeScheduled = true;
				queueMicrotask(() => {
					harness.session.dispose();
					resolveDisposed();
				});
				throw new Error("listener failure before session replacement");
			}
		}));
		harness.setResponses([
			fauxAssistantMessage("This stale response is still proceeding."),
			fauxAssistantMessage("dispose-retry failed and was reconciled."),
		]);

		await assert.rejects(harness.session.prompt("Wait for dispose-retry."), /listener failure before session replacement/);
		await disposed;

		assert.equal(disposeScheduled, true);
		assert.equal(hiddenPersistenceAttempts, 3, "disposal must make a final persistence attempt before state is lost");
		const sessionFile = harness.sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const reopened = SessionManager.open(sessionFile, harness.sessionManager.getSessionDir());
		const customEntries = reopened.getEntries().filter((entry) => entry.type === "custom_message");
		assert.equal(customEntries.filter((entry) => entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE).length, 1);
		assert.equal(customEntries.filter((entry) => entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE).length, 1);
	});
	test("stage delivery transfer moves queued notice protection while source keeps its core-local in-flight notice", async () => {
		const store = createStore();
		for (const [id, name] of [["run-transfer-a", "transfer-a"], ["run-transfer-b", "transfer-b"]] as const) {
			store.recordRunStart({ id, name, inputs: {}, status: "running", stages: [], startedAt: 1 });
		}
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => source.session.sendCustomMessage(message, options),
		}));
		let terminalized = false;
		let transferred = false;
		let sourceContext: Context | undefined;
		let targetContext: Context | undefined;
		unsubscriptions.push(source.session.subscribe((event) => {
			if (!terminalized && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-transfer-a", "completed", {}), true);
				assert.equal(store.recordRunEnd("run-transfer-b", "completed", {}), true);
			}
		}));
		unsubscriptions.push(source.session.agent.subscribe((event) => {
			if (terminalized && !transferred && event.type === "turn_start") {
				transferred = true;
				(source.session as typeof source.session & { transferWorkflowStageDeliveriesTo(target: object): void })
					.transferWorkflowStageDeliveriesTo(target.session);
				target.session.clearQueue();
			}
		}));
		source.setResponses([
			fauxAssistantMessage("A stale source response finishes before reconciliation."),
			(context) => {
				sourceContext = context;
				return fauxAssistantMessage("Source corrected transfer-a.");
			},
		]);
		target.setResponses([
			(context) => {
				targetContext = context;
				return fauxAssistantMessage("Target corrected transfer-b.");
			},
		]);

		await source.session.prompt("Wait for both transfer workflows.");
		await target.session.prompt("Continue after stage-session replacement.");

		assert.equal(transferred, true);
		assert.equal(source.faux.state.callCount, 2);
		assert.equal(target.faux.state.callCount, 1);
		assert.ok(sourceContext);
		assert.ok(targetContext);
		assert.equal(
			sourceContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "transfer-a" completed'),
			).length,
			1,
			"the already-drained notice remains owned and consumed at the source",
		);
		assert.equal(
			sourceContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "transfer-b" completed'),
			).length,
			0,
		);
		assert.equal(
			targetContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "transfer-b" completed'),
			).length,
			1,
			"target clearQueue must restore the protection transferred with this queued reference",
		);
		assert.equal(
			source.session.messages.filter(
				(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length,
			2,
		);
		assert.equal(
			source.sessionManager.getEntries().filter(
				(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length,
			2,
		);
		assert.equal(
			source.sessionManager.getEntries().filter(
				(entry) => entry.type === "custom_message" && entry.display === false,
			).length,
			1,
			"the core-local in-flight reconciliation persists only at source",
		);
		assert.equal(
			target.sessionManager.getEntries().filter(
				(entry) => entry.type === "custom_message" && entry.display === false,
			).length,
			1,
			"the transferred queued reconciliation persists only at target",
		);
	});
});
