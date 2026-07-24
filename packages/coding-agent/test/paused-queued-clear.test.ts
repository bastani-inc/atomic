import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.ts";
import { StageSessionPause } from "../../workflows/src/runs/foreground/stage-runner-pause.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type PausedSession = AgentSession & {
	readonly _activeInterruptQueueHold?: {
		readonly steering: AgentMessage[];
		readonly followUp: AgentMessage[];
	};
};

describe("explicit paused queue removal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("clearing the final held item keeps later prompts paused until explicit resume", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("resumed queue consumed")]);
		harness.session.pauseQueuedMessages();
		await harness.session.steer("remove final held item");
		const providerResponses = harness.getPendingResponseCount();

		expect(harness.session.clearQueue()).toEqual({
			steering: ["remove final held item"],
			followUp: [],
		});

		expect(harness.session.queuedMessagesPaused).toBe(true);
		expect((harness.session as PausedSession)._activeInterruptQueueHold).toEqual({ steering: [], followUp: [] });
		await harness.session.prompt("late after clear");
		expect(harness.getPendingResponseCount()).toBe(providerResponses);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect((harness.session as PausedSession)._activeInterruptQueueHold?.steering).toHaveLength(1);

		expect(await harness.session.resumeQueuedMessages()).toBe(true);
		await harness.session.prompt("explicit resume driver");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	test("workflow pause stays closed after clear until its explicit resume", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("workflow resumed queue consumed")]);
		const workflowPause = new StageSessionPause(() => harness.session);
		await workflowPause.requestPause();
		await harness.session.followUp("clear workflow held item");

		expect(harness.session.clearQueue()).toEqual({
			steering: [],
			followUp: ["clear workflow held item"],
		});
		await harness.session.prompt("late workflow prompt after clear");

		expect(workflowPause.isPaused()).toBe(true);
		expect(harness.session.queuedMessagesPaused).toBe(true);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);

		expect(await workflowPause.resume()).toEqual({
			releasedQueuedMessages: true,
			runnerOwnedDeliveryPending: false,
		});
		await harness.session.prompt("workflow explicit resume driver");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	test("partial clear keeps pause while a protected held item remains", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("protected consumed")]);
		harness.session.pauseQueuedMessages();
		await harness.session.steer("remove visible held item");
		await harness.session.sendCustomMessage(
			{
				customType: "protected-paused-card",
				content: "protected raw reconciliation",
				display: true,
				details: { optional: { retained: true } },
			},
			{ triggerTurn: true, persistWhenStreaming: true },
		);

		expect(harness.session.clearQueue()).toEqual({
			steering: ["remove visible held item"],
			followUp: [],
		});

		const hold = (harness.session as PausedSession)._activeInterruptQueueHold;
		expect(harness.session.queuedMessagesPaused).toBe(true);
		expect(hold?.steering).toHaveLength(1);
		expect(hold?.steering[0]).toMatchObject({
			role: "custom",
			customType: PROTECTED_RECONCILIATION_CUSTOM_TYPE,
			content: "protected raw reconciliation",
			display: false,
		});
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.session.resumeQueuedMessages();
		await harness.session.prompt("consume protected hold");
	});
});
