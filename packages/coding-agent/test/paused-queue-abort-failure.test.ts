import { afterEach, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type PauseBoundarySession = AgentSession & {
  _agentEventQueue: Promise<void>;
  readonly _queuedMessagesPauseAbortBoundary: Promise<void> | undefined;
};

describe("paused queue abort failure", () => {
  const harnesses: Harness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  test("a failed abort boundary blocks one explicit resume and remains retryable", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const session = harness.session as PauseBoundarySession;
    const eventSettlement = Promise.withResolvers<void>();
    const abortError = new Error("abort event settlement rejected");

    harness.session.pauseQueuedMessages();
    await harness.session.steer("held across failed abort");
    session._agentEventQueue = eventSettlement.promise;
    const abort = harness.session.abort();
    eventSettlement.reject(abortError);
    await expect(abort).rejects.toBe(abortError);

    expect(harness.session.queuedMessagesPaused).toBe(true);
    expect(session._queuedMessagesPauseAbortBoundary).toBeDefined();
    await expect(harness.session.resumeQueuedMessages()).rejects.toBe(abortError);
    expect(harness.session.queuedMessagesPaused).toBe(true);
    expect(session._queuedMessagesPauseAbortBoundary).toBeUndefined();

    expect(await harness.session.resumeQueuedMessages()).toBe(true);
    expect(harness.session.queuedMessagesPaused).toBe(false);
  });
});
