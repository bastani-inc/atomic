import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { createQueuedUserMessageConsumptionWatcher } from "../../packages/workflows/src/runs/foreground/executor-queued-user-message.js";
import { RESUME_CONTINUATION_PROMPT } from "../../packages/workflows/src/shared/resume-continuation.js";

function userMessage(text: string): AgentSessionEvent {
  return {
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  } as AgentSessionEvent;
}

describe("queued user message consumption watcher", () => {
  test("arms only for user messages consumed after the prompt that started an agent run", () => {
    let armCount = 0;
    const watch = createQueuedUserMessageConsumptionWatcher(() => { armCount += 1; });

    watch({ type: "agent_start" });
    watch(userMessage("initial stage prompt"));
    assert.equal(armCount, 0);

    watch(userMessage("consumed steer"));
    watch(userMessage("consumed follow-up"));
    assert.equal(armCount, 2);

    watch({ type: "agent_end", messages: [] });
    watch({ type: "agent_start" });
    watch(userMessage("idle-session prompt"));
    assert.equal(armCount, 2);
  });

  test("queue additions and clears cannot arm a later matching idle prompt", () => {
    let armCount = 0;
    const watch = createQueuedUserMessageConsumptionWatcher(() => { armCount += 1; });

    watch({ type: "agent_start" });
    watch(userMessage("initial"));
    watch({ type: "queue_update", steering: ["cleared"], followUp: [] });
    watch({ type: "queue_update", steering: [], followUp: [] });
    watch({ type: "agent_end", messages: [] });

    watch({ type: "agent_start" });
    watch(userMessage("cleared"));
    assert.equal(armCount, 0);
  });

  test("recognizes a queued message consumed first in a follow-on agent run", () => {
    let armCount = 0;
    const watch = createQueuedUserMessageConsumptionWatcher(() => { armCount += 1; });

    watch({ type: "agent_start" });
    watch(userMessage("initial"));
    watch({ type: "queue_update", steering: [], followUp: ["late follow-up"] });
    watch({ type: "agent_end", messages: [] });

    watch({ type: "agent_start" });
    watch({ type: "queue_update", steering: [], followUp: [] });
    // An unrelated queue update may arrive while extensions process the
    // consumed message, before public message_start listeners are notified.
    watch({ type: "queue_update", steering: ["later steer"], followUp: [] });
    watch(userMessage("late follow-up"));
    assert.equal(armCount, 1);
  });

  test("the continuation injection starts a new run and cannot re-arm itself", () => {
    let armCount = 0;
    const watch = createQueuedUserMessageConsumptionWatcher(() => { armCount += 1; });

    watch({ type: "agent_start" });
    watch(userMessage("initial"));
    watch(userMessage("consumed steer"));
    watch({ type: "agent_end", messages: [] });
    assert.equal(armCount, 1);

    watch({ type: "agent_start" });
    watch(userMessage(RESUME_CONTINUATION_PROMPT));
    watch({ type: "agent_end", messages: [] });
    assert.equal(armCount, 1);
  });
});
