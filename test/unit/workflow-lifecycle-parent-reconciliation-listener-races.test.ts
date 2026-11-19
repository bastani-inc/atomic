import assert from "node:assert/strict";
import { type Context, fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { sleep } from "../helpers/runtime.js";

const HIDDEN_RECONCILIATION_CUSTOM_TYPE = "atomic:protected-streaming-reconciliation";

async function waitUntil(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for streaming custom-message delivery");
		await sleep(2);
	}
}

describe("workflow lifecycle listener and admission races", () => {
	const harnesses: Harness[] = [];
	const unsubscriptions: Array<() => void> = [];

	afterEach(async () => {
		while (unsubscriptions.length > 0) unsubscriptions.pop()?.();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
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
			unsubscriptions.push(
				harness.session.subscribe((event) => {
					if (!delivery && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
						delivery = harness.session.sendCustomMessage(
							{
								customType,
								content: rawContent,
								display: true,
								details,
							},
							{
								persistWhenStreaming: true,
								...(triggerTurn === undefined ? {} : { triggerTurn }),
							},
						);
					}
				}),
			);

			await harness.session.prompt("answer once");
			await waitUntil(() => delivery !== undefined);
			await delivery;
			await harness.session.agent.waitForIdle();

			assert.equal(harness.faux.state.callCount, 1, "display-only persistence must not wake the provider");
			assert.equal(harness.session.messages.filter((message) => message.role === "assistant").length, 1);
			assert.equal(
				harness.session.messages.some((message) => getMessageText(message).includes("UNREQUESTED")),
				false,
			);
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
			const durable = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
			assert.equal(durable.length, 1);
			assert.equal(durable[0]?.type, "custom_message");
			if (durable[0]?.type === "custom_message") {
				assert.equal(durable[0].customType, customType);
				assert.equal(durable[0].content, rawContent);
				assert.deepEqual(durable[0].details, details);
				assert.equal(durable[0].display, true);
				assert.equal("excludeFromContext" in durable[0], false);
			}
			const protectedEntries = (
				harness.session as typeof harness.session & {
					_protectedStreamingCustomMessages: object[];
				}
			)._protectedStreamingCustomMessages;
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
		unsubscriptions.push(
			harness.session.subscribe((event) => {
				if (!delivery && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					delivery = harness.session.sendCustomMessage(
						{
							customType,
							content: sentinel,
							display: true,
							details,
						},
						{ triggerTurn: true, persistWhenStreaming: true, excludeFromContext: true },
					);
				}
			}),
		);

		await harness.session.prompt("answer once");
		await waitUntil(() => delivery !== undefined);
		await delivery;
		await harness.session.agent.waitForIdle();

		assert.equal(
			harness.faux.state.callCount,
			1,
			"excluded status must preserve the active turn's one provider call",
		);
		assert.equal(
			providerContexts.some((context) =>
				context.messages.some((message) => getMessageText(message).includes(sentinel)),
			),
			false,
			"excluded raw content must never reach a provider",
		);
		assert.equal(harness.session.messages.filter((message) => message.role === "assistant").length, 1);
		assert.equal(
			harness.session.messages.some((message) => getMessageText(message).includes("UNREQUESTED PRIVATE")),
			false,
		);
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
		assert.equal(
			harness.events.filter(
				(event) =>
					event.type === "message_start" &&
					event.message.role === "custom" &&
					event.message.customType === customType,
			).length,
			1,
			"the excluded card is displayed exactly once",
		);
		const durable = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
		assert.equal(durable.length, 1);
		assert.equal(durable[0]?.type, "custom_message");
		if (durable[0]?.type === "custom_message") {
			assert.equal(durable[0].customType, customType);
			assert.equal(durable[0].content, sentinel);
			assert.deepEqual(durable[0].details, details);
			assert.equal(durable[0].display, true);
			assert.equal(durable[0].excludeFromContext, true);
		}
		assert.equal(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE,
				).length,
			0,
		);
		const protectedEntries = (
			harness.session as typeof harness.session & {
				_protectedStreamingCustomMessages: object[];
			}
		)._protectedStreamingCustomMessages;
		assert.equal(protectedEntries.length, 0, "excluded content must not leave a protected orphan");
	});

	test("idle persistWhenStreaming keeps an excluded message on the direct prompt path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sentinel = "IDLE-SECRET-MUST-NOT-ENTER-PROVIDER";
		const details = { marker: "idle-verbatim" };
		let providerContext: Context | undefined;
		harness.setResponses([
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("Idle excluded delivery completed.");
			},
		]);

		await harness.session.sendCustomMessage(
			{
				customType: "review:idle-private-status",
				content: sentinel,
				display: true,
				details,
			},
			{ triggerTurn: true, persistWhenStreaming: true, excludeFromContext: true },
		);
		await harness.session.agent.waitForIdle();

		assert.equal(harness.faux.state.callCount, 1, "the direct idle trigger still owns one provider turn");
		assert.equal(
			providerContext?.messages.some((message) => getMessageText(message).includes(sentinel)),
			false,
		);
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
		const durable = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "review:idle-private-status");
		assert.equal(durable.length, 1);
		assert.equal(durable[0]?.type, "custom_message");
		if (durable[0]?.type === "custom_message") {
			assert.equal(durable[0].content, sentinel);
			assert.deepEqual(durable[0].details, details);
			assert.equal(durable[0].excludeFromContext, true);
		}
		assert.equal(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === HIDDEN_RECONCILIATION_CUSTOM_TYPE,
				).length,
			0,
		);
		const protectedEntries = (
			harness.session as typeof harness.session & {
				_protectedStreamingCustomMessages: object[];
			}
		)._protectedStreamingCustomMessages;
		assert.equal(protectedEntries.length, 0, "idle exclusion must not create a protected copy");
	});
});
