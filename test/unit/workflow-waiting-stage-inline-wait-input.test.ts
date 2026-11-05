import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { makeResumedRig, names, until } from "./waiting-stage-controller-rig.js";

/** Longer than any test runs: the stage keeps its session for the whole wait and never releases it. */
const INLINE_WAIT_MS = 600_000;

/**
 * A stage resumed after its process died, over a transcript that ends on call `c1`: the call starts again and the stage
 * waits on it with its session still live, inline for `afterMs`, or for the whole wait when it may not release.
 */
async function waitingInline(policy: { readonly afterMs: number } | undefined) {
	const rig = await makeResumedRig({ policy, pendingTurn: true, redispatch: (ci) => [ci.call("c1")] });
	const turn = rig.ctx.prompt("the original prompt");
	turn.catch(() => {});
	await until(() => rig.ci.calls.has("c1"));
	return { rig, turn };
}

describe("a message to a resumed stage while it waits on a tool call with its session live (#4309)", () => {
	for (const [label, policy] of [
		["inline before it would release", { afterMs: INLINE_WAIT_MS }],
		["resident for the whole wait", undefined],
	] as const) {
		test(`waiting ${label}, a message joins the waiting turn after the results instead of starting a turn of its own (#4309)`, async () => {
			const { rig, turn } = await waitingInline(policy);

			assert.equal(rig.ctx.__holdsInput?.(), true);
			assert.equal(await rig.ctx.__sendUserMessage("steer text", { deliverAs: "steer" }), "steer");
			assert.equal(await rig.ctx.__sendUserMessage("follow-up text"), "followUp");
			rig.ci.finish("c1");
			await turn;

			assert.deepEqual(
				rig.log.filter((entry) => /^(prompt|steer|followUp|resume)#/.test(entry)),
				[
					'steer#1:steer text:{"expandPromptTemplates":false}',
					'followUp#1:follow-up text:{"expandPromptTemplates":false}',
					"resume#1:c1",
				],
			);
			assert.equal(rig.created(), 1);
			assert.deepEqual(names(rig.log, "enter:"), []);
			assert.equal(rig.ctx.__holdsInput?.(), false);
		});
	}
});
