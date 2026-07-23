import { test } from "bun:test";
import assert from "node:assert/strict";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { makeMockSession, makeOpts } from "./stage-runner-helpers.js";

test("generation close waits for an in-flight session creation and closes the attached session", async () => {
    const creation = Promise.withResolvers<ReturnType<typeof makeMockSession>["session"]>();
    let closeCalls = 0;
    const context = createStageContext(makeOpts({
        adapters: {
            agentSession: {
                async create() { return creation.promise; },
            },
        },
    }));
    const ensure = context.__ensureSession();
    let closeResolved = false;
    const close = context.__closeGeneration().then(() => { closeResolved = true; });
    await Promise.resolve();
    assert.equal(closeResolved, false);

    creation.resolve(makeMockSession({
        async closeWorkflowStageGeneration() { closeCalls += 1; },
    }).session);
    await Promise.all([ensure, close]);

    assert.equal(closeCalls, 1);
    assert.equal(closeResolved, true);
});
