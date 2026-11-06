import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { detachingOne, makeRig, until } from "./waiting-stage-controller-rig.js";

const RED = { type: "image", data: "cmVk", mimeType: "image/png" } as const;
const BLUE = { type: "image", data: "Ymx1ZQ==", mimeType: "image/png" } as const;
const GREEN = { type: "image", data: "Z3JlZW4=", mimeType: "image/jpeg" } as const;

/**
 * What the stage's first session still had queued when the stage released it: two steering messages with the same
 * text and different images, one without images, and follow-ups with and without images.
 */
function queuedWithImages() {
	return {
		steering: ["look", "look", "look"],
		followUp: ["then this", "plain"],
		images: { steering: [[RED], [BLUE], undefined], followUp: [[GREEN, RED], undefined] },
	};
}

/** What the reopened session (#2) was given, in order. */
function deliveredToReopened(log: readonly string[]): string[] {
	return log.filter((entry) => /^(steer|followUp|resume)#2/.test(entry));
}

const EXPECTED_DELIVERY = [
	'steer#2:look:{"expandPromptTemplates":false}:images=[{"type":"image","data":"cmVk","mimeType":"image/png"}]',
	'steer#2:look:{"expandPromptTemplates":false}:images=[{"type":"image","data":"Ymx1ZQ==","mimeType":"image/png"}]',
	'steer#2:look:{"expandPromptTemplates":false}',
	'followUp#2:then this:{"expandPromptTemplates":false}:images=[{"type":"image","data":"Z3JlZW4=","mimeType":"image/jpeg"},{"type":"image","data":"cmVk","mimeType":"image/png"}]',
	'followUp#2:plain:{"expandPromptTemplates":false}',
];

describe("messages queued in a stage's session when it is released keep their images (#4309)", () => {
	test("a stage released on a tool wait gives every queued message, each with its own images, to the reopened session before the turn continues (#4309)", async () => {
		const rig = makeRig({
			detachOnPrompt: detachingOne(),
			customize: (number) => (number === 1 ? { clearQueue: queuedWithImages } : {}),
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await turn;

		assert.deepEqual(deliveredToReopened(rig.log), [...EXPECTED_DELIVERY, "resume#2:c1"]);
	});

	test("a stage released with release() gives every queued message, each with its own images, to the session rehydrate() reopens (#4309)", async () => {
		const rig = makeRig({ customize: (number) => (number === 1 ? { clearQueue: queuedWithImages } : {}) });
		await rig.ctx.prompt("plan");

		await rig.ctx.release();
		await rig.ctx.rehydrate();

		assert.deepEqual(deliveredToReopened(rig.log), EXPECTED_DELIVERY);
	});
});
