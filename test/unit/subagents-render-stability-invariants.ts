import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { clearLegacyResultAnimationTimer, stopResultAnimations } from "../../packages/subagents/src/tui/render.js";

describe("subagent render stability invariants", () => {
	afterEach(() => {
		stopResultAnimations();
	});

	test("clears legacy result animation timers", () => {
		let fired = false;
		const timer = setInterval(() => {
			fired = true;
		}, 10_000);
		const context: {
			state: {
				subagentResultAnimationTimer?: ReturnType<typeof setInterval>;
			};
		} = {
			state: { subagentResultAnimationTimer: timer },
		};

		clearLegacyResultAnimationTimer(context);

		assert.equal(context.state.subagentResultAnimationTimer, undefined);
		assert.equal(fired, false);
	});
});
