import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import {
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { assertWorkflowToolOrdering, lifecycleConfig } from "./workflow-lifecycle-parent-reconciliation-support.js";

describe("workflow lifecycle parent reconciliation admission boundaries", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];
	const unsubscriptions: Array<() => void> = [];

	afterEach(() => {
		while (unsubscriptions.length > 0) unsubscriptions.pop()?.();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	test("send admission makes a tool-pending terminal card visible and file-durable before model consumption", async () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-tool-pending",
			name: "tool-pending",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		const sessionDir = mkdtempSync(join(tmpdir(), "atomic-lifecycle-session-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		let harness!: Harness;
		let delivery: Promise<void> | undefined;
		let sentNotice: Parameters<Harness["session"]["sendCustomMessage"]>[0] | undefined;
		let admissionObserved = false;
		const workflowTool: AgentTool = {
			name: "workflow",
			label: "Workflow",
			description: "Launch a named workflow",
			parameters: Type.Object({}),
			execute: async () => {
				assert.equal(store.recordRunEnd("run-tool-pending", "completed", { summary: "instant" }), true);
				assert.ok(delivery, "the terminal snapshot must start lifecycle delivery synchronously");
				await delivery;
				const cardsAtAdmission = harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
				);
				assert.equal(cardsAtAdmission.length, 1, "send admission must include the visible card");
				const cardAtAdmission = cardsAtAdmission[0];
				assert.equal(cardAtAdmission?.role, "custom");
				if (cardAtAdmission?.role !== "custom") throw new Error("missing lifecycle card at admission");
				assert.equal(cardAtAdmission.display, true);
				assert.equal(cardAtAdmission.content, sentNotice?.content, "raw lifecycle content must not be rewritten");
				assert.equal(cardAtAdmission.details, sentNotice?.details, "the visible card keeps the exact details object");
				const details = cardAtAdmission.details as WorkflowLifecycleNoticeDetails;
				assert.equal("error" in details, false, "omitted optional lifecycle fields stay omitted");
				assert.equal("stageId" in details, false);
				const persistedAtAdmission = sessionManager.getEntries().filter(
					(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
				);
				assert.equal(persistedAtAdmission.length, 1, "send admission must include one durable lifecycle card");
				const sessionFile = sessionManager.getSessionFile();
				assert.ok(sessionFile);
				const reopenedAtAdmission = SessionManager.open(sessionFile, sessionDir, process.cwd());
				assert.equal(
					reopenedAtAdmission.getEntries().filter(
						(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
					).length,
					1,
					"the admission receipt must be physically reopenable before the tool result exists",
				);
				admissionObserved = true;
				return {
					content: [{ type: "text", text: "Workflow tool-pending started in background (run-tool-pending). Status: running" }],
					details: { action: "run", runId: "run-tool-pending", status: "running" },
				};
			},
		};
		harness = await createHarness({ tools: [workflowTool], sessionManager });
		harnesses.push(harness);
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => {
				sentNotice = message;
				delivery = harness.session.sendCustomMessage(message, options);
				return delivery;
			},
		}));
		let providerContext: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", {}, { id: "workflow-call-tool-pending" }), { stopReason: "toolUse" }),
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("tool-pending completed successfully.");
			},
		]);

		await harness.session.prompt("Run tool-pending.");

		assert.equal(admissionObserved, true);
		assert.ok(providerContext);
		assertWorkflowToolOrdering(providerContext);
		const terminalUserMessages = providerContext.messages.filter(
			(message) => message.role === "user" && getMessageText(message).includes('Workflow "tool-pending" completed'),
		);
		assert.equal(terminalUserMessages.length, 1, `provider context: ${JSON.stringify(providerContext.messages)}`);
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const rawEntries = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const rawCards = rawEntries.filter((entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE);
		assert.equal(rawCards.length, 1);
		assert.equal(rawCards[0]?.content, sentNotice?.content);
		assert.deepEqual(rawCards[0]?.details, sentNotice?.details);
		assert.equal(rawEntries.filter((entry) => entry.type === "custom_message" && entry.display === false).length, 1);
		const reopened = SessionManager.open(sessionFile, sessionDir, process.cwd());
		const reopenedMessages = convertToLlm(reopened.buildSessionContext().messages);
		assertWorkflowToolOrdering({ messages: reopenedMessages });
		assert.equal(
			reopenedMessages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "tool-pending" completed'),
			).length,
			1,
		);
	});

	test("a terminal notice between completed tool turns joins the next provider step", async () => {
		const store = createStore();
		store.recordRunStart({ id: "run-between-tools", name: "between-tools", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const workflowTool: AgentTool = {
			name: "workflow",
			label: "Workflow",
			description: "Launch a named workflow",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "Workflow between-tools started. Status: running" }],
				details: { action: "run", runId: "run-between-tools", status: "running" },
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
		unsubscriptions.push(harness.session.agent.subscribe((event) => {
			if (!terminalized && event.type === "turn_end") {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-between-tools", "completed", {}), true);
			}
		}));
		let providerContext: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", {}, { id: "workflow-call-between-tools" }), { stopReason: "toolUse" }),
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("between-tools completed.");
			},
		]);

		await harness.session.prompt("Run between-tools.");

		assert.equal(harness.faux.state.callCount, 2);
		assert.ok(providerContext);
		assertWorkflowToolOrdering(providerContext);
		assert.equal(
			providerContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "between-tools" completed'),
			).length,
			1,
		);
	});

	test("an idle parent starts one lifecycle prompt with the durable terminal card", async () => {
		const store = createStore();
		store.recordRunStart({ id: "run-idle", name: "idle", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const harness = await createHarness();
		harnesses.push(harness);
		let delivery: Promise<void> | undefined;
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage(message, options) {
				delivery = harness.session.sendCustomMessage(message, options);
				return delivery;
			},
		}));
		let providerContext: Context | undefined;
		harness.setResponses([(context) => {
			providerContext = context;
			return fauxAssistantMessage("I saw idle complete.");
		}]);

		assert.equal(store.recordRunEnd("run-idle", "completed", {}), true);
		await delivery;
		await harness.session.agent.waitForIdle();

		assert.equal(harness.faux.state.callCount, 1);
		assert.ok(providerContext);
		assert.equal(
			providerContext.messages.filter(
				(message) => message.role === "user" && getMessageText(message).includes('Workflow "idle" completed'),
			).length,
			1,
		);
		assert.equal(harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		).length, 1);
		assert.equal(harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		).length, 1);
	});

	test("a paced ordinary abort stops the stale turn but completes one correcting lifecycle response", async () => {
		const store = createStore();
		store.recordRunStart({ id: "run-abort-survival", name: "abort-survival", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const workflowTool: AgentTool = {
			name: "workflow",
			label: "Workflow",
			description: "Launch a named workflow",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "Workflow abort-survival started in background. Status: running" }],
				details: { action: "run", runId: "run-abort-survival", status: "running" },
			}),
		};
		const harness = await createHarness({
			tools: [workflowTool],
			fauxProvider: { tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } },
		});
		harnesses.push(harness);
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => harness.session.sendCustomMessage(message, options),
		}));
		let terminalized = false;
		let abortPromise: Promise<void> | undefined;
		let reconciliationContext: Context | undefined;
		unsubscriptions.push(harness.session.subscribe((event) => {
			if (!terminalized && harness.faux.state.callCount === 2 && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-abort-survival", "completed", {}), true);
				abortPromise = harness.session.abort();
			}
		}));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", {}, { id: "workflow-call-abort-survival" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("This stale answer is long enough to be aborted after its first streaming delta."),
			(context) => {
				reconciliationContext = context;
				return fauxAssistantMessage("abort-survival completed; the terminal notice survived the abort.");
			},
		]);

		await harness.session.prompt("Run abort-survival.");
		await abortPromise;

		assert.equal(terminalized, true);
		assert.equal(harness.faux.state.callCount, 3);
		const assistants = harness.session.messages.filter((message) => message.role === "assistant");
		const stale = assistants.find((message) => getMessageText(message).startsWith("This"));
		assert.equal(stale?.role, "assistant");
		if (stale?.role === "assistant") assert.equal(stale.stopReason, "aborted", "the paced stale turn must be the aborted request");
		const correcting = assistants.find((message) => getMessageText(message).includes("terminal notice survived"));
		assert.equal(correcting?.role, "assistant");
		if (correcting?.role === "assistant") assert.equal(correcting.stopReason, "stop", "the correcting response must complete");
		assert.ok(reconciliationContext);
		assert.equal(reconciliationContext.messages.filter(
			(message) => message.role === "user" && getMessageText(message).includes('Workflow "abort-survival" completed'),
		).length, 1);
		assert.equal(harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		).length, 1);
		assert.equal(harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		).length, 1);
	});
});
