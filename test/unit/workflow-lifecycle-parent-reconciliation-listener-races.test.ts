import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import {
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	lifecycleConfig,
	providerSawWorkflowState,
} from "./workflow-lifecycle-parent-reconciliation-support.js";

const HIDDEN_RECONCILIATION_CUSTOM_TYPE = "atomic:protected-streaming-reconciliation";

async function waitUntil(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for streaming custom-message delivery");
		await Bun.sleep(2);
	}
}


describe("workflow lifecycle listener and admission races", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];
	const unsubscriptions: Array<() => void> = [];

	afterEach(() => {
		while (unsubscriptions.length > 0) unsubscriptions.pop()?.();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	for (const listenerEvent of ["message_start", "message_end"] as const) {
		test(`a one-shot public ${listenerEvent} listener error cannot duplicate an admitted lifecycle card`, async () => {
			const store = createStore();
			store.recordRunStart({ id: `run-${listenerEvent}`, name: listenerEvent, inputs: {}, status: "running", stages: [], startedAt: 1 });
			const harness = await createHarness({ fauxProvider: { tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } } });
			harnesses.push(harness);
			unsubscriptions.push(installWorkflowLifecycleNotifications({
				store,
				config: lifecycleConfig,
				seedExisting: false,
				sendMessage: (message, options) => harness.session.sendCustomMessage(message, options),
			}));
			let terminalized = false;
			let threw = false;
			unsubscriptions.push(harness.session.subscribe((event) => {
				if (!terminalized && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					terminalized = true;
					assert.equal(store.recordRunEnd(`run-${listenerEvent}`, "failed", { error: "boom" }), true);
					return;
				}
				if (
					!threw &&
					event.type === listenerEvent &&
					event.message.role === "custom" &&
					event.message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE
				) {
					threw = true;
					throw new Error(`one-shot ${listenerEvent} subscriber failure after durable append`);
				}
			}));
			harness.setResponses([
				fauxAssistantMessage("This stale response is still proceeding."),
				fauxAssistantMessage(`Correction: ${listenerEvent} failed.`),
			]);

			await harness.session.prompt("wait");
			await harness.session.agent.waitForIdle();

			assert.equal(threw, true);
			assert.equal(harness.faux.state.callCount, 2, "listener failure must not make lifecycle delivery retry");
			assert.equal(harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
			).length, 1, "the visible card remains live exactly once");
			const durable = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			assert.equal(durable.filter((entry) => entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE).length, 1);
			assert.equal(durable.filter((entry) => entry.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE).length, 1);
		});
	}

	test("an unrelated prompt winning idle admission safely owns the queued reconciliation", async () => {
		const store = createStore();
		store.recordRunStart({ id: "idle-race", name: "idle-race", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const harness = await createHarness();
		harnesses.push(harness);
		const providerContexts: Context[] = [];
		harness.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("Unrelated active chat finished.");
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("Lifecycle correction finished.");
			},
		]);
		let unrelated: Promise<void> | undefined;
		let delivery: Promise<void> | undefined;
		let started = false;
		unsubscriptions.push(harness.session.subscribe((event) => {
			if (
				!started &&
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE
			) {
				started = true;
				unrelated = harness.session.agent.prompt({
					role: "user",
					content: [{ type: "text", text: "An unrelated user prompt won the idle admission race." }],
					timestamp: Date.now(),
				});
			}
		}));
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage(message, options) {
				delivery = harness.session.sendCustomMessage(message, options);
				return delivery;
			},
		}));

		assert.equal(store.recordRunEnd("idle-race", "failed", { error: "failed immediately" }), true);
		await delivery;
		await unrelated;
		await harness.session.agent.waitForIdle();

		assert.equal(started, true);
		assert.equal(providerContexts.some((context) => providerSawWorkflowState(context, "idle-race", "failed")), true);
		assert.equal(harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		).length, 1);
		assert.equal(harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE,
		).length, 1);
		const protectedEntries = (harness.session as typeof harness.session & {
			_protectedStreamingCustomMessages: object[];
		})._protectedStreamingCustomMessages;
		assert.equal(protectedEntries.length, 0, "no protected reconciliation may be orphaned");
		const unrelatedAssistant = harness.session.messages.find(
			(message) => message.role === "assistant" && getMessageText(message) === "Unrelated active chat finished.",
		);
		assert.equal(unrelatedAssistant?.role, "assistant");
		if (unrelatedAssistant?.role === "assistant") {
			assert.equal(unrelatedAssistant.stopReason, "stop", "lifecycle admission must not abort the unrelated turn");
		}
	});

	test("a one-shot hidden message_end listener error still persists the consumed boundary exactly once", async () => {
		const store = createStore();
		store.recordRunStart({ id: "run-hidden-listener", name: "hidden-listener", inputs: {}, status: "running", stages: [], startedAt: 1 });
		const sessionDir = mkdtempSync(join(tmpdir(), "atomic-lifecycle-hidden-listener-"));
		tempDirs.push(sessionDir);
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		unsubscriptions.push(installWorkflowLifecycleNotifications({
			store,
			config: lifecycleConfig,
			seedExisting: false,
			sendMessage: (message, options) => harness.session.sendCustomMessage(message, options),
		}));
		let terminalized = false;
		let threw = false;
		let reconciliationContext: Context | undefined;
		unsubscriptions.push(harness.session.subscribe((event) => {
			if (!terminalized && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				terminalized = true;
				assert.equal(store.recordRunEnd("run-hidden-listener", "failed", undefined, "boom"), true);
				return;
			}
			if (
				!threw &&
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE
			) {
				threw = true;
				throw new Error("one-shot hidden message listener failure before persistence");
			}
		}));
		harness.setResponses([
			fauxAssistantMessage("This stale response is still proceeding."),
			(context) => {
				reconciliationContext = context;
				return fauxAssistantMessage("Correction: hidden-listener failed.");
			},
		]);

		await harness.session.prompt("wait");
		await harness.session.agent.waitForIdle();

		assert.equal(threw, true);
		assert.equal(harness.faux.state.callCount, 2, "persistence recovery must not re-queue provider input");
		assert.equal(providerSawWorkflowState(reconciliationContext, "hidden-listener", "failed"), true);
		const entries = sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
		assert.equal(entries.filter((entry) => entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE).length, 1);
		assert.equal(entries.filter((entry) => entry.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE).length, 1);
		const protectedEntries = (harness.session as typeof harness.session & {
			_protectedStreamingCustomMessages: object[];
		})._protectedStreamingCustomMessages;
		assert.equal(protectedEntries.length, 0);
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const reopened = SessionManager.open(sessionFile, sessionDir, process.cwd());
		const reopenedCustom = reopened.getEntries().filter((entry) => entry.type === "custom_message");
		assert.equal(reopenedCustom.filter((entry) => entry.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE).length, 1);
		assert.equal(reopenedCustom.filter((entry) => entry.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE).length, 1);
	});

	for (const triggerTurn of [false, undefined] as const) {
		test(`persistWhenStreaming with triggerTurn ${String(triggerTurn)} stays durable and display-only`, async () => {
			const harness = await createHarness({ fauxProvider: { tokensPerSecond: 80, tokenSize: { min: 1, max: 1 } } });
			harnesses.push(harness);
			const customType = `review:display-only-${String(triggerTurn)}`;
			const rawContent = `display-only-${String(triggerTurn)}-raw`;
			const details = { marker: `details-${String(triggerTurn)}` };
			harness.setResponses([
				fauxAssistantMessage("An unrelated active answer should finish without another model step. ".repeat(2)),
				fauxAssistantMessage("UNREQUESTED ASSISTANT RESPONSE"),
			]);
			let delivery: Promise<void> | undefined;
			unsubscriptions.push(harness.session.subscribe((event) => {
				if (!delivery && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					delivery = harness.session.sendCustomMessage({
						customType,
						content: rawContent,
						display: true,
						details,
					}, {
						persistWhenStreaming: true,
						...(triggerTurn === undefined ? {} : { triggerTurn }),
					});
				}
			}));

			await harness.session.prompt("answer once");
			await waitUntil(() => delivery !== undefined);
			await delivery;
			await harness.session.agent.waitForIdle();

			assert.equal(harness.faux.state.callCount, 1, "display-only persistence must not wake the provider");
			assert.equal(harness.session.messages.filter((message) => message.role === "assistant").length, 1);
			assert.equal(harness.session.messages.some((message) => getMessageText(message).includes("UNREQUESTED")), false);
			const cards = harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === customType,
			);
			assert.equal(cards.length, 1);
			const card = cards[0];
			assert.equal(card?.role, "custom");
			if (card?.role !== "custom") throw new Error("missing display-only custom card");
			assert.equal(card.customType, customType);
			assert.equal(card.content, rawContent, "raw custom content stays exact");
			assert.equal(card.details, details, "details object identity stays exact");
			assert.equal(card.display, true);
			assert.equal("excludeFromContext" in card, false, "omitted optional fields stay omitted");
			const durable = harness.sessionManager.getEntries().filter(
				(entry) => entry.type === "custom_message" && entry.customType === customType,
			);
			assert.equal(durable.length, 1);
			assert.equal(durable[0]?.type, "custom_message");
			if (durable[0]?.type === "custom_message") {
				assert.equal(durable[0].customType, customType);
				assert.equal(durable[0].content, rawContent);
				assert.deepEqual(durable[0].details, details);
				assert.equal(durable[0].display, true);
				assert.equal("excludeFromContext" in durable[0], false);
			}
			const protectedEntries = (harness.session as typeof harness.session & {
				_protectedStreamingCustomMessages: object[];
			})._protectedStreamingCustomMessages;
			assert.equal(protectedEntries.length, 0, "display-only persistence must not leave a protected orphan");
		});
	}

	test("persistWhenStreaming never reconciles context-excluded content during an active turn", async () => {
		const harness = await createHarness({ fauxProvider: { tokensPerSecond: 80, tokenSize: { min: 1, max: 1 } } });
		harnesses.push(harness);
		const sentinel = "SECRET-MUST-NOT-ENTER-PROVIDER";
		const customType = "review:private-status";
		const details: { marker: string; optionalNote?: string } = { marker: "verbatim" };
		const providerContexts: Context[] = [];
		harness.setResponses([
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("An unrelated active answer should finish. ".repeat(2));
			},
			(context) => {
				providerContexts.push(context);
				return fauxAssistantMessage("UNREQUESTED PRIVATE FOLLOW-UP");
			},
		]);
		let delivery: Promise<void> | undefined;
		unsubscriptions.push(harness.session.subscribe((event) => {
			if (!delivery && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				delivery = harness.session.sendCustomMessage({
					customType,
					content: sentinel,
					display: true,
					details,
				}, { triggerTurn: true, persistWhenStreaming: true, excludeFromContext: true });
			}
		}));

		await harness.session.prompt("answer once");
		await waitUntil(() => delivery !== undefined);
		await delivery;
		await harness.session.agent.waitForIdle();

		assert.equal(harness.faux.state.callCount, 1, "excluded status must preserve the active turn's one provider call");
		assert.equal(providerContexts.some((context) => context.messages.some(
			(message) => getMessageText(message).includes(sentinel),
		)), false, "excluded raw content must never reach a provider");
		assert.equal(harness.session.messages.filter((message) => message.role === "assistant").length, 1);
		assert.equal(harness.session.messages.some((message) => getMessageText(message).includes("UNREQUESTED PRIVATE")), false);
		const cards = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === customType,
		);
		assert.equal(cards.length, 1);
		const card = cards[0];
		assert.equal(card?.role, "custom");
		if (card?.role !== "custom") throw new Error("missing excluded custom card");
		assert.equal(card.customType, customType);
		assert.equal(card.content, sentinel, "raw excluded content stays exact in its display card");
		assert.equal(card.details, details, "excluded card keeps the exact details object");
		assert.equal("optionalNote" in details, false, "omitted detail fields stay omitted");
		assert.equal(card.display, true);
		assert.equal((card as typeof card & { excludeFromContext?: boolean }).excludeFromContext, true);
		assert.equal(harness.events.filter(
			(event) => event.type === "message_start" && event.message.role === "custom" && event.message.customType === customType,
		).length, 1, "the excluded card is displayed exactly once");
		const durable = harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === customType,
		);
		assert.equal(durable.length, 1);
		assert.equal(durable[0]?.type, "custom_message");
		if (durable[0]?.type === "custom_message") {
			assert.equal(durable[0].customType, customType);
			assert.equal(durable[0].content, sentinel);
			assert.deepEqual(durable[0].details, details);
			assert.equal(durable[0].display, true);
			assert.equal(durable[0].excludeFromContext, true);
		}
		assert.equal(harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE,
		).length, 0);
		const protectedEntries = (harness.session as typeof harness.session & {
			_protectedStreamingCustomMessages: object[];
		})._protectedStreamingCustomMessages;
		assert.equal(protectedEntries.length, 0, "excluded content must not leave a protected orphan");
	});

	test("idle persistWhenStreaming keeps an excluded message on the direct prompt path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sentinel = "IDLE-SECRET-MUST-NOT-ENTER-PROVIDER";
		const details = { marker: "idle-verbatim" };
		let providerContext: Context | undefined;
		harness.setResponses([(context) => {
			providerContext = context;
			return fauxAssistantMessage("Idle excluded delivery completed.");
		}]);

		await harness.session.sendCustomMessage({
			customType: "review:idle-private-status",
			content: sentinel,
			display: true,
			details,
		}, { triggerTurn: true, persistWhenStreaming: true, excludeFromContext: true });
		await harness.session.agent.waitForIdle();

		assert.equal(harness.faux.state.callCount, 1, "the direct idle trigger still owns one provider turn");
		assert.equal(providerContext?.messages.some((message) => getMessageText(message).includes(sentinel)), false);
		const cards = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "review:idle-private-status",
		);
		assert.equal(cards.length, 1);
		const card = cards[0];
		assert.equal(card?.role, "custom");
		if (card?.role !== "custom") throw new Error("missing idle excluded card");
		assert.equal(card.content, sentinel);
		assert.equal(card.details, details);
		assert.equal(card.display, true);
		assert.equal((card as typeof card & { excludeFromContext?: boolean }).excludeFromContext, true);
		const durable = harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === "review:idle-private-status",
		);
		assert.equal(durable.length, 1);
		assert.equal(durable[0]?.type, "custom_message");
		if (durable[0]?.type === "custom_message") {
			assert.equal(durable[0].content, sentinel);
			assert.deepEqual(durable[0].details, details);
			assert.equal(durable[0].excludeFromContext, true);
		}
		assert.equal(harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE,
		).length, 0);
		const protectedEntries = (harness.session as typeof harness.session & {
			_protectedStreamingCustomMessages: object[];
		})._protectedStreamingCustomMessages;
		assert.equal(protectedEntries.length, 0, "idle exclusion must not create a protected copy");
	});
});
