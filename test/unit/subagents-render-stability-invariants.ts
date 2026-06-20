import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { clearLegacyResultAnimationTimer, stopResultAnimations, widgetRenderKey } from "../../packages/subagents/src/tui/render.js";
import { type AsyncJobState, withMockedNow } from "./subagents-render-stability-helpers.js";
describe("subagent render stability invariants", () => {
    afterEach(() => {
        stopResultAnimations();
    });

    test("widget render key is stable when only wall clock changes", () => {
        const job: AsyncJobState = {
            asyncId: "abc123",
            asyncDir: "/tmp/abc123",
            status: "running",
            mode: "single",
            agents: ["worker"],
            updatedAt: 10_000,
            toolCount: 1,
            turnCount: 2,
        };

        const first = withMockedNow(10_000, () => widgetRenderKey(job));
        const second = withMockedNow(10_080, () => widgetRenderKey(job));

        assert.equal(second, first);
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
