/**
 * Tests for HeadlessClaudeSessionWrapper.disconnect().
 *
 * Regression coverage for the headless-stage deadlock: when an Agent SDK
 * `query()` ends cleanly with `stop_reason: end_turn`, the spawned `claude`
 * child stays alive (the `stream-json` transport is long-lived across
 * turns). disconnect() must:
 *   1. Force the SDK's `Query.return()` path so the transport closes
 *      stdin and SIGTERMs the child.
 *   2. Run `claudeOffloadCleanup` against the last-known session id so
 *      the per-session marker files do not leak.
 */

import { test, expect, describe } from "bun:test";
import { HeadlessClaudeSessionWrapper } from "./claude.ts";

type Maybe<T> = T | undefined;

/**
 * Minimal stand-in for the SDK's `Query` generator. Only `return()` is
 * exercised by disconnect(); the other AsyncGenerator methods exist purely
 * so the structural cast lines up.
 */
function makeFakeQuery(): {
  query: {
    return: (value?: unknown) => Promise<IteratorResult<unknown>>;
    next: () => Promise<IteratorResult<unknown>>;
    throw: (err: unknown) => Promise<IteratorResult<unknown>>;
    [Symbol.asyncIterator]: () => AsyncGenerator<unknown>;
  };
  returnCalls: number;
} {
  let returnCalls = 0;
  const query = {
    return: async (value?: unknown) => {
      returnCalls += 1;
      return { value, done: true } as IteratorResult<unknown>;
    },
    next: async () => ({ value: undefined, done: true } as IteratorResult<unknown>),
    throw: async (_err: unknown) =>
      ({ value: undefined, done: true } as IteratorResult<unknown>),
    [Symbol.asyncIterator]: function () {
      return this as unknown as AsyncGenerator<unknown>;
    },
  };
  return {
    query,
    get returnCalls() {
      return returnCalls;
    },
  } as unknown as { query: typeof query; returnCalls: number };
}

describe("HeadlessClaudeSessionWrapper.disconnect()", () => {
  test("no active query, no session id → resolves silently", async () => {
    const wrapper = new HeadlessClaudeSessionWrapper("/tmp/atomic-test-project");
    await expect(wrapper.disconnect()).resolves.toBeUndefined();
  });

  test("calls Query.return() on the in-flight SDK generator", async () => {
    const wrapper = new HeadlessClaudeSessionWrapper("/tmp/atomic-test-project");
    const fake = makeFakeQuery();
    // The wrapper's `_activeQuery` is private but the runtime contract is
    // that disconnect() drives whichever Query is currently held — set it
    // via a structural cast to exercise that path.
    (wrapper as unknown as { _activeQuery: Maybe<typeof fake.query> })._activeQuery =
      fake.query;

    await wrapper.disconnect();

    expect(fake.returnCalls).toBe(1);
    // disconnect() must clear the slot so a second call is a no-op even if
    // the first call's transport teardown was already in flight.
    expect(
      (wrapper as unknown as { _activeQuery: Maybe<unknown> })._activeQuery,
    ).toBeUndefined();
  });

  test("swallows errors thrown from Query.return()", async () => {
    const wrapper = new HeadlessClaudeSessionWrapper("/tmp/atomic-test-project");
    const exploding = {
      return: async () => {
        throw new Error("boom");
      },
      next: async () => ({ value: undefined, done: true }) as IteratorResult<unknown>,
      throw: async () =>
        ({ value: undefined, done: true }) as IteratorResult<unknown>,
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    (
      wrapper as unknown as { _activeQuery: Maybe<typeof exploding> }
    )._activeQuery = exploding;

    await expect(wrapper.disconnect()).resolves.toBeUndefined();
  });

  test("idempotent — second call with no active query is a no-op", async () => {
    const wrapper = new HeadlessClaudeSessionWrapper("/tmp/atomic-test-project");
    const fake = makeFakeQuery();
    (wrapper as unknown as { _activeQuery: Maybe<typeof fake.query> })._activeQuery =
      fake.query;

    await wrapper.disconnect();
    await wrapper.disconnect();

    expect(fake.returnCalls).toBe(1);
  });

  test("resolves within the deadline even if Query.return() never resolves", async () => {
    // Regression test for the cleanup-hang risk: if the SDK's
    // transport.close() / child-exit waits wedge (e.g. uninterruptible
    // sleep, stuck transcript flush), the wrapper must not block the
    // stage cleanup forever. Exercise the helper directly with a tight
    // 100ms deadline — disconnect()'s production value is ~10s, but the
    // mechanism under test is identical.
    const { awaitReturnWithDeadline } = await import("./claude.ts");
    const neverResolving = {
      return: () => new Promise<IteratorResult<unknown>>(() => {}),
      next: async () =>
        ({ value: undefined, done: true }) as IteratorResult<unknown>,
      throw: async () =>
        ({ value: undefined, done: true }) as IteratorResult<unknown>,
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const start = Date.now();
    await awaitReturnWithDeadline(
      neverResolving as unknown as Parameters<typeof awaitReturnWithDeadline>[0],
      100,
    );
    const elapsed = Date.now() - start;
    // Should be ≈100ms; allow generous slack for slow CI hosts but stay
    // well under "would have hung indefinitely" territory.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
  });
});
