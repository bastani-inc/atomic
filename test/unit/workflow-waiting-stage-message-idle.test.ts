import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { makeRig, until } from "./waiting-stage-controller-rig.js";

const T0 = new Date("2026-05-01T00:00:00.000Z").getTime();
/** How long the turn a message starts runs; the stage is idle only from its end. */
const TURN_MS = 5_000;

afterEach(() => {
	vi.useRealTimers();
});

test("a stage that took a message is idle from when the turn it started ended, not from when it was sent (#4309)", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
	const turnEnds = Promise.withResolvers<void>();
	const rig = makeRig({
		customize: () => ({
			async prompt() {
				await turnEnds.promise;
			},
		}),
	});

	const sent = rig.ctx.__sendUserMessage("report");
	await until(() => rig.created() === 1);
	vi.setSystemTime(T0 + TURN_MS);
	turnEnds.resolve();

	assert.equal(await sent, "prompt");
	assert.equal(rig.ctx.__idleSince?.(), T0 + TURN_MS);
});
