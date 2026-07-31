/**
 * Ownership bookkeeping for in-flight RPC requests.
 *
 * Two rules are pinned here because the real child cannot be made to reproduce
 * them on demand: an admission frame still queued when the child dies must be
 * seen before the requests are failed, and a request the child never took must
 * stay classified as unsent so its text can go back to the editor.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { EXIT_DRAIN_TIMEOUT_MS } from "../../packages/coding-agent/src/modes/rpc/rpc-command-timeouts.ts";
import { RpcPendingRequests } from "../../packages/coding-agent/src/modes/rpc/rpc-pending-requests.ts";
import { RpcTerminalDrain } from "../../packages/coding-agent/src/modes/rpc/rpc-terminal-drain.ts";
import {
	isRpcRequestAcceptedFailure,
	isRpcTransportFailure,
	rpcTransportError,
} from "../../packages/coding-agent/src/modes/rpc/rpc-transport-error.ts";
import { sleep } from "../helpers/runtime.js";

interface Settled {
	rejected?: unknown;
	resolved?: unknown;
}

function track(pending: RpcPendingRequests, id: string): Settled {
	const settled: Settled = {};
	pending.add(id, {
		resolve: (response) => {
			settled.resolved = response;
		},
		reject: (error) => {
			settled.rejected = error;
		},
	});
	return settled;
}

const EXIT = () => rpcTransportError("Agent process exited (code=null signal=SIGKILL). Stderr: ");

test("one engine exit classifies accepted and unaccepted requests differently", () => {
	const pending = new RpcPendingRequests();
	const accepted = track(pending, "req_1");
	const unaccepted = track(pending, "req_2");
	pending.markAccepted("req_1");

	const exit = EXIT();
	pending.rejectAll(exit);

	assert.ok(isRpcRequestAcceptedFailure(accepted.rejected), "the accepted request lost its ownership marker");
	assert.equal(isRpcRequestAcceptedFailure(unaccepted.rejected), false);
	assert.ok(isRpcTransportFailure(unaccepted.rejected), "both are still transport failures");
	assert.equal(unaccepted.rejected, exit, "the shared error must not be copied for an unaccepted request");
	assert.equal((accepted.rejected as { cause?: unknown }).cause, exit, "the accepted copy keeps the original");
	assert.equal(pending.size, 0);
});

test("a request accepted while the exit rejection waits for the drain is not reported as unsent", async () => {
	const pending = new RpcPendingRequests();
	const settled = track(pending, "req_1");
	let markDrained!: () => void;
	const drained = new Promise<void>((resolve) => {
		markDrained = resolve;
	});

	const drain = new RpcTerminalDrain();
	void drain.begin(1, drained, EXIT(), (error) => pending.rejectAll(error));
	assert.equal(settled.rejected, undefined, "the request must not fail before the reader has drained");

	// The admission frame was still in the pipe when the child exited.
	pending.markAccepted("req_1");
	markDrained();
	await sleep(0);

	assert.ok(isRpcRequestAcceptedFailure(settled.rejected), "the queued admission was ignored");
});

test("a drain that never completes still fails pending requests", async () => {
	const pending = new RpcPendingRequests();
	const settled = track(pending, "req_1");
	void new RpcTerminalDrain().begin(1, new Promise<void>(() => {}), EXIT(), (error) => pending.rejectAll(error));

	await sleep(EXIT_DRAIN_TIMEOUT_MS + 50);
	assert.ok(isRpcTransportFailure(settled.rejected), "a descendant holding stdout must not strand the caller");
	assert.equal(isRpcRequestAcceptedFailure(settled.rejected), false);
});

test("the first terminal cause owns the error, and settlement happens once", async () => {
	const pending = new RpcPendingRequests();
	const settled = track(pending, "req_1");
	const drain = new RpcTerminalDrain();
	const exit = EXIT();
	let markDrained!: () => void;
	const drained = new Promise<void>((resolve) => {
		markDrained = resolve;
	});

	const first = drain.begin(2, drained, exit, (error) => pending.rejectAll(error));
	// A recovery stop joins the same phase; its own error must not take over.
	const joined = drain.begin(2, Promise.resolve(), rpcTransportError("Agent process stopped"), () => {
		throw new Error("a second settle ran for one generation");
	});
	assert.equal(joined, first, "the second caller must join, not start another phase");
	assert.equal(drain.isDraining(2), true);

	markDrained();
	await first;
	assert.equal((settled.rejected as Error).message, exit.message, "the stop relabelled the original exit");
	assert.equal(await drain.settled(2), undefined);
	assert.equal(await drain.settled(3), undefined, "an untouched generation settles immediately");
});

test("only ownership frames survive a dead generation", () => {
	const drain = new RpcTerminalDrain();
	const accepted: string[] = [];
	const observe = (line: string) => drain.observe(1, line, (id) => accepted.push(id));
	assert.equal(
		observe(JSON.stringify({ type: "engine_request_accepted", requestId: "req_1", command: "prompt" })),
		false,
		"a generation that never died has nothing to drain",
	);

	void drain.begin(1, new Promise<void>(() => {}), EXIT(), () => {});
	assert.equal(
		observe(JSON.stringify({ type: "engine_request_accepted", requestId: "req_1", command: "prompt" })),
		true,
	);
	assert.deepEqual(accepted, ["req_1"]);
	// Every other frame from the dead generation is swallowed, not applied.
	assert.equal(observe(JSON.stringify({ type: "engine_heartbeat", at: 1 })), true);
	assert.equal(observe(JSON.stringify({ type: "response", id: "req_1", success: true })), false);
	assert.deepEqual(accepted, ["req_1"]);
});

test("a response settles its request and admission for an unknown id is ignored", () => {
	const pending = new RpcPendingRequests();
	const settled = track(pending, "req_1");
	pending.markAccepted("req_unknown");
	assert.equal(pending.resolve("req_1", { type: "response", id: "req_1", success: true, data: 1 } as never), true);
	assert.deepEqual(settled.resolved, { type: "response", id: "req_1", success: true, data: 1 });
	assert.equal(pending.resolve("req_1", {} as never), false, "a settled request must not resolve twice");
	assert.equal(pending.size, 0);
});
