import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import {
	createGate,
	createRig,
	DUPLICATE_DELIVERY_SETTLE_MS,
	holdTool,
	type Rig,
	releaseOpenGates,
	sleep,
	waitFor,
} from "./helpers/busy-submission-rig.ts";
import { pressAltUp } from "./helpers/interactive-submission-host.ts";
import { getUserTexts } from "./suite/harness.ts";

/** Long enough that the engine's reply to a request is still in flight while the test acts. */
const ENGINE_TO_HOST_LAG_MS = 150;

function isDeepEqual(actual: unknown, expected: unknown): boolean {
	try {
		assert.deepEqual(actual, expected);
		return true;
	} catch {
		return false;
	}
}

/** Let every request and reply between the host and the engine arrive and be handled. */
async function settleTraffic(rig: Rig): Promise<void> {
	if (rig.pair) await rig.pair.drain();
	else await sleep(DUPLICATE_DELIVERY_SETTLE_MS);
}

describe.each(["local", "isolated"] as const)(
	"Alt+Up while the engine's queue is ahead of the host (%s host)",
	(wiring) => {
		const rigs: Rig[] = [];
		afterEach(async () => {
			releaseOpenGates();
			while (rigs.length > 0) await rigs.pop()?.stop();
		});

		/** A turn that stays open on a tool, so messages typed meanwhile queue behind it. */
		async function startBusyTurn(): Promise<{ rig: Rig; finishTurn: () => void }> {
			const toolHold = createGate();
			const rig = await createRig(wiring, "quiet", { tools: [holdTool(toolHold)] });
			rigs.push(rig);
			rig.engine.setResponses([
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("answered"),
				fauxAssistantMessage("unexpected extra reply"),
			]);
			await rig.host.defaultEditor.onSubmit?.("first");
			await toolHold.entered.promise;
			await waitFor("the host to see the running turn", () => rig.host.session.isStreaming);
			return { rig, finishTurn: () => toolHold.release.resolve() };
		}

		test("restores a message the engine queued before the host heard about it, exactly once (#4257)", async () => {
			const { rig, finishTurn } = await startBusyTurn();
			rig.pair?.setLag({ toHostMs: ENGINE_TO_HOST_LAG_MS });

			// The engine takes the message and answers, but the answer is still on its way to the host.
			const submitted = rig.host.defaultEditor.onSubmit?.("queued in the engine");
			await waitFor("the engine to queue the message", () =>
				isDeepEqual(rig.engine.session.getSteeringMessages(), ["queued in the engine"]),
			);
			if (rig.pair) assert.deepEqual(rig.host.session.getSteeringMessages(), [], "the host must not know of it yet");

			pressAltUp(rig.host);
			await settleTraffic(rig);
			await submitted;

			assert.equal(rig.host.editor.getText(), "queued in the engine");
			assert.deepEqual(rig.engine.session.getSteeringMessages(), []);
			assert.deepEqual(rig.host.getAllQueuedMessages(), { steering: [], followUp: [] });

			finishTurn();
			await waitFor("the turn to finish", () => !rig.engine.session.isStreaming);
			await settleTraffic(rig);
			assert.deepEqual(getUserTexts(rig.engine), ["first"], "a restored message must not also be sent");
		});

		test("restores nothing for a message the engine already took into its turn, so it is not sent twice (#4257)", async () => {
			const { rig, finishTurn } = await startBusyTurn();
			await rig.host.defaultEditor.onSubmit?.("taken into the turn");
			await waitFor("the host to list the queued message", () =>
				isDeepEqual(rig.host.session.getSteeringMessages(), ["taken into the turn"]),
			);

			// The turn takes the message at its next boundary; what the host hears about that is still on its way.
			rig.pair?.setLag({ toHostMs: ENGINE_TO_HOST_LAG_MS });
			finishTurn();
			await waitFor("the engine to take the message into the turn", () =>
				getUserTexts(rig.engine).includes("taken into the turn"),
			);
			if (rig.pair) {
				assert.deepEqual(
					rig.host.session.getSteeringMessages(),
					["taken into the turn"],
					"the host still lists it",
				);
			}

			pressAltUp(rig.host);
			await settleTraffic(rig);

			assert.equal(rig.host.editor.getText(), "");
			assert.deepEqual(
				rig.host.notices.filter((notice) => notice.startsWith("status:")),
				["status: No queued messages to restore"],
			);
			await waitFor("the turn to finish", () => !rig.engine.session.isStreaming);
			await settleTraffic(rig);
			assert.deepEqual(getUserTexts(rig.engine), ["first", "taken into the turn"]);
		});
	},
);
