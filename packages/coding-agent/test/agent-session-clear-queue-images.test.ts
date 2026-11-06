import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
import { waitFor } from "./helpers/busy-submission-rig.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

const RED: ImageContent = { type: "image", data: "cmVk", mimeType: "image/png" };
const BLUE: ImageContent = { type: "image", data: "Ymx1ZQ==", mimeType: "image/png" };
const GREEN: ImageContent = { type: "image", data: "Z3JlZW4=", mimeType: "image/jpeg" };

/** A tool that holds the run open until the test releases it, so messages stay queued. */
function heldTool(): { tool: AgentTool; entered: Promise<void>; release: () => void } {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		tool: {
			name: "hold",
			label: "Hold",
			description: "Holds the run open until released",
			parameters: Type.Object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "held" }], details: {} };
			},
		},
		entered: entered.promise,
		release: () => release.resolve(),
	};
}

const harnesses: Harness[] = [];
const heldCompactions: Array<() => void> = [];
afterEach(async () => {
	for (const release of heldCompactions.splice(0)) release();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

async function startHeldTurn(): Promise<{ harness: Harness; release: () => void }> {
	const hold = heldTool();
	const harness = await createHarness({ tools: [hold.tool] });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	void harness.session.prompt("first").catch(() => {});
	await hold.entered;
	return { harness, release: hold.release };
}

describe("clearQueue() gives back the images of queued messages (#4309)", () => {
	test("returns each queued message's own images, in queue order, also for messages with the same text (#4309)", async () => {
		const { harness, release } = await startHeldTurn();

		await harness.session.steer("look", [RED]);
		await harness.session.steer("look", [BLUE]);
		await harness.session.steer("look");
		await harness.session.followUp("then this", [GREEN, RED]);
		await harness.session.followUp("plain");

		const cleared = harness.session.clearQueue();
		release();

		assert.deepEqual(cleared.steering, ["look", "look", "look"]);
		assert.deepEqual(cleared.followUp, ["then this", "plain"]);
		assert.deepEqual(cleared.images, {
			steering: [[RED], [BLUE], undefined],
			followUp: [[GREEN, RED], undefined],
		});
		assert.deepEqual(harness.session.getSteeringMessages(), []);
	});

	test("leaves images out when no queued message has any, so the result keeps its text-only shape (#4309)", async () => {
		const { harness, release } = await startHeldTurn();

		await harness.session.steer("look");
		await harness.session.followUp("plain");

		const cleared = harness.session.clearQueue();
		release();

		assert.deepEqual(cleared, { steering: ["look"], followUp: ["plain"] });
	});

	test("skips custom messages queued in the same lane, which carry no queued text (#4309)", async () => {
		const { harness, release } = await startHeldTurn();

		await harness.session.steer("look", [RED]);
		await harness.session.sendCustomMessage(
			{ customType: "note", content: "a note", display: false },
			{ deliverAs: "steer" },
		);

		const cleared = harness.session.clearQueue();
		release();

		assert.deepEqual(cleared.steering, ["look"]);
		assert.deepEqual(cleared.images, { steering: [[RED]], followUp: [] });
	});
});

describe("clearQueue() gives back the images of input held while the session compacts (#4309)", () => {
	test("returns the images of held prompts with the same text, each with its own, and sends none of them (#4309)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const compactionHeld = Promise.withResolvers<undefined>();
		heldCompactions.push(() => compactionHeld.resolve(undefined));
		vi.spyOn(
			harness.session as unknown as { _applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined> },
			"_applyVerbatimCompaction",
		).mockImplementation(() => compactionHeld.promise);
		const compaction = harness.session.compact().catch((error: Error) => error);
		await waitFor("compaction to start", () => harness.session.isCompacting);

		const first = harness.session.prompt("look", { images: [RED] });
		const second = harness.session.prompt("look", { images: [BLUE], streamingBehavior: "followUp" });
		const third = harness.session.prompt("look");
		await waitFor("the held prompts to be listed", () => harness.session.getSteeringMessages().length === 2);

		const cleared = harness.session.clearQueue();
		compactionHeld.resolve(undefined);
		await Promise.all([compaction, first, second, third]);

		assert.deepEqual(cleared.steering, ["look", "look"]);
		assert.deepEqual(cleared.followUp, ["look"]);
		assert.deepEqual(cleared.images, { steering: [[RED], undefined], followUp: [[BLUE]] });
		assert.deepEqual(getUserTexts(harness), []);
	});
});
