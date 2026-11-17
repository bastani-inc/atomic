import assert from "node:assert/strict";
import { test } from "vitest";
import {
	abortSessionWork,
	sessionLifetime,
	trackSessionWork,
} from "../../packages/coding-agent/src/core/session-lifecycle-work.js";
import { type CollectionCount, collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";

function startSharedService(): ReturnType<typeof setInterval> {
	return setInterval(() => {}, 3_600_000);
}

async function endOwner(tracked: CollectionCount): Promise<ReturnType<typeof setInterval>> {
	const owner = { closed: false };
	tracked.track(owner);
	sessionLifetime(owner).addEventListener("abort", () => {
		owner.closed = true;
	});
	const service = await trackSessionWork(owner, async () => startSharedService());
	abortSessionWork(owner);
	assert.equal(owner.closed, true);
	return service;
}

test("a shared service started in session work does not retain its ended owner (#5324)", async () => {
	const tracked = trackCollection();
	const service = await endOwner(tracked);
	try {
		await collectEverythingTracked(tracked);
		assert.equal(tracked.collected(), tracked.created, "the shared service must not own the ended session");
	} finally {
		clearInterval(service);
	}
});
