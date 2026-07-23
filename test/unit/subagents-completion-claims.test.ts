import { test } from "bun:test";
import assert from "node:assert/strict";
import { deliverClaimedCompletion } from "../../packages/subagents/src/runs/background/completion-claims.js";

test("concurrent completion claims share one promise-owned attempt", async () => {
	let release!: (delivered: boolean) => void;
	let calls = 0;
	const intercom = () => {
		calls += 1;
		return new Promise<boolean>((resolve) => { release = resolve; });
	};
	const first = deliverClaimedCompletion("claim-concurrent", "signature", 60_000, { intercom, local: async () => true });
	const second = deliverClaimedCompletion("claim-concurrent", "signature", 60_000, { intercom, local: async () => true });
	assert.equal(calls, 1);
	release(false);
	assert.deepEqual(await first, { owner: true, status: "retry", noProgressFailures: 1 });
	assert.deepEqual(await second, { owner: false, status: "retry", noProgressFailures: 1 });
	// A later owner may retry only after the exact promise token above cleared.
	const third = deliverClaimedCompletion("claim-concurrent", "signature", 60_000, { intercom: async () => true, local: async () => true });
	assert.equal((await third).status, "delivered");
});

test("partial phase progress survives replacement and exhausts only consecutive no-progress attempts", async () => {
	let intercomCalls = 0;
	let localCalls = 0;
	const phases = {
		intercom: async () => { intercomCalls += 1; return true; },
		local: async () => { localCalls += 1; return false; },
	};
	assert.deepEqual(await deliverClaimedCompletion("claim-partial", "signature", 60_000, phases, 2), {
		owner: true, status: "retry", noProgressFailures: 0,
	});
	assert.deepEqual(await deliverClaimedCompletion("claim-partial", "signature", 60_000, phases, 2), {
		owner: true, status: "retry", noProgressFailures: 1,
	});
	assert.deepEqual(await deliverClaimedCompletion("claim-partial", "signature", 60_000, phases, 2), {
		owner: true, status: "exhausted", noProgressFailures: 2,
	});
	assert.deepEqual(await deliverClaimedCompletion("claim-partial", "signature", 60_000, phases, 2), {
		owner: false, status: "exhausted", noProgressFailures: 2,
	});
	assert.equal(intercomCalls, 1, "the successful phase must not replay across retries or replacement callers");
	assert.equal(localCalls, 3);
});

test("new phase progress resets an earlier no-progress failure", async () => {
	let intercomCalls = 0;
	const phases = {
		intercom: async () => ++intercomCalls > 1,
		local: async () => false,
	};
	assert.equal((await deliverClaimedCompletion("claim-progress-reset", "signature", 60_000, phases, 2)).noProgressFailures, 1);
	assert.equal((await deliverClaimedCompletion("claim-progress-reset", "signature", 60_000, phases, 2)).noProgressFailures, 0);
	assert.equal((await deliverClaimedCompletion("claim-progress-reset", "signature", 60_000, phases, 2)).status, "retry");
	assert.equal((await deliverClaimedCompletion("claim-progress-reset", "signature", 60_000, phases, 2)).status, "exhausted");
});

test("completion claims reject conflicting aliases in flight and after terminal states", async () => {
	let release!: (value: boolean) => void;
	const first = deliverClaimedCompletion("claim-conflict", "signature-a", 60_000, {
		intercom: () => new Promise<boolean>((resolve) => { release = resolve; }),
		local: async () => true,
	});
	assert.deepEqual(await deliverClaimedCompletion("claim-conflict", "signature-b", 60_000, {
		local: async () => true,
	}), { owner: false, status: "conflict", noProgressFailures: 0 });
	release(true);
	assert.equal((await first).status, "delivered");
	assert.deepEqual(await deliverClaimedCompletion("claim-conflict", "signature-b", 60_000, {
		local: async () => true,
	}), { owner: false, status: "conflict", noProgressFailures: 0 });
});

test("completion claims preserve alias signatures after exhaustion", async () => {
	const phases = { local: async () => false };
	assert.equal((await deliverClaimedCompletion("claim-exhausted-conflict", "signature-a", 60_000, phases, 1)).status, "exhausted");
	assert.equal((await deliverClaimedCompletion("claim-exhausted-conflict", "signature-a", 60_000, phases, 1)).status, "exhausted");
	assert.equal((await deliverClaimedCompletion("claim-exhausted-conflict", "signature-b", 60_000, {
		local: async () => true,
	}, 1)).status, "conflict");
});
