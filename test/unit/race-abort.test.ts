/**
 * Regression tests for `raceAbort` orphaning an in-flight promise.
 *
 * Background: stage turns run as `await raceAbort(call(), ownController.signal)`.
 * `call()` is evaluated (and the prompt starts) before `raceAbort` runs, so when
 * a workflow is killed mid-prompt the signal is already aborted by the time
 * `raceAbort` is entered. The aborted branch must still observe the in-flight
 * promise; otherwise its eventual rejection (commonly
 * "No API key found for ...") becomes an unhandled rejection that escapes every
 * workflow error boundary and crashes the entire CLI.
 *
 * cross-ref: packages/workflows/src/runs/foreground/executor.ts raceAbort
 */

import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { raceAbort } from "../../packages/workflows/src/runs/foreground/executor.js";

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
};

beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
});

/** Let microtasks and a couple of macrotask turns flush so any orphaned
 * rejection is delivered to the process `unhandledRejection` listener. */
async function flushPendingRejections(): Promise<void> {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

test("raceAbort does not orphan an in-flight rejection when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("workflow killed");
    controller.abort(reason);

    // Simulate `call()` already in flight: a prompt that rejects on a later tick
    // (e.g. AgentSession.prompt throwing "No API key found for undefined").
    const sentinel = new Error("late prompt failure: No API key found for undefined");
    const inFlight = new Promise<void>((_resolve, rejectInFlight) => {
        setTimeout(() => rejectInFlight(sentinel), 5);
    });

    await assert.rejects(raceAbort(inFlight, controller.signal), (err) => err === reason);

    await flushPendingRejections();
    assert.equal(
        unhandled.includes(sentinel),
        false,
        "the orphaned in-flight rejection must be observed, not left unhandled",
    );
});

test("raceAbort rejects with the abort reason yet still observes a later mid-flight rejection", async () => {
    const controller = new AbortController();
    const sentinel = new Error("late mid-flight failure");
    const inFlight = new Promise<void>((_resolve, rejectInFlight) => {
        setTimeout(() => rejectInFlight(sentinel), 5);
    });

    const raced = raceAbort(inFlight, controller.signal);
    const reason = new Error("killed mid-flight");
    controller.abort(reason);

    await assert.rejects(raced, (err) => err === reason);

    await flushPendingRejections();
    assert.equal(unhandled.includes(sentinel), false);
});

test("raceAbort resolves with the promise value when the signal never aborts", async () => {
    const controller = new AbortController();
    const value = await raceAbort(Promise.resolve("ok"), controller.signal);
    assert.equal(value, "ok");
});

test("raceAbort propagates a normal rejection when the signal never aborts", async () => {
    const controller = new AbortController();
    const failure = new Error("normal failure");
    await assert.rejects(raceAbort(Promise.reject(failure), controller.signal), (err) => err === failure);
});
