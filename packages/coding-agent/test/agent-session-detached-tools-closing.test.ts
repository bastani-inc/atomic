/**
 * A session that is closed while a detached turn is being resumed (#4309) records nothing more of it and does not
 * continue the turn: the results stay with the host for the session reopened from the store.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { isToolDetachmentError } from "../src/index.ts";
import {
	detachedResult,
	harnessPool,
	reopenedAfterDetaching,
	settlesWithin,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

test("a session closed while its results are finalized refuses with the closed-session error and runs no turn (#4309)", async () => {
	const inHandler = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { reopened, sessionId } = await reopenedAfterDetaching(
		pool,
		[waitTool().definition],
		[waitForCiTurn("ci-1")],
		[
			(pi) => {
				pi.on("tool_result", async () => {
					inHandler.resolve();
					await release.promise;
				});
			},
		],
	);
	reopened.setResponses([fauxAssistantMessage("must not run")]);
	const resumed = reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]).then(
		() => undefined,
		(error: unknown) => error,
	);
	await settlesWithin(inHandler.promise);

	const closing = reopened.session.dispose();
	release.resolve();
	const refusal = await settlesWithin(resumed);
	await closing;

	assert.ok(isToolDetachmentError(refusal), `resuming raised ${String(refusal)}`);
	assert.equal(refusal.code, "session-closed");
	assert.deepEqual(refusal.fields, { sessionId });
	assert.equal(reopened.getPendingResponseCount(), 1, "the turn was not continued");
});

test("a session reloaded while its results are finalized refuses with the closed-session error and runs no turn (#4309)", async () => {
	const session: { reload?: () => Promise<void> } = {};
	let reloaded = false;
	const { reopened, sessionId } = await reopenedAfterDetaching(
		pool,
		[waitTool().definition],
		[waitForCiTurn("ci-1")],
		[
			(pi) => {
				pi.on("tool_result", async () => {
					if (reloaded) return;
					reloaded = true;
					// The reload ends the generation the continuation started in, and completes before the handler returns.
					await session.reload?.();
				});
			},
		],
	);
	session.reload = () => reopened.session.reload();
	reopened.setResponses([fauxAssistantMessage("must not run")]);

	const refusal = await settlesWithin(
		reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]).then(
			() => undefined,
			(error: unknown) => error,
		),
	);

	assert.equal(reloaded, true);
	assert.ok(isToolDetachmentError(refusal), `resuming raised ${String(refusal)}`);
	assert.equal(refusal.code, "session-closed");
	assert.deepEqual(refusal.fields, { sessionId });
	assert.equal(reopened.getPendingResponseCount(), 1, "the turn was not continued");
});
