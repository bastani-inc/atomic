import assert from "node:assert/strict";
import type { ExtensionAPI, UserBlock, UserBlockReason } from "@bastani/atomic";
import { test } from "vitest";

/**
 * Negative compile assertions against the *public* block door.
 *
 * The package-level test asserts the exported names of the internal
 * `user-blocks` module, but that file is not part of the root `tsc` program, and
 * a runtime name check cannot see a type. The contract clause — a block ends
 * only through its own handle — lives on `ExtensionAPI`, so it is checked here,
 * where root `tsc --noEmit` compiles it.
 *
 * These `@ts-expect-error` comments are the assertion. If a release-by-id method
 * were ever added, or the reason union widened, or `release()` given a
 * parameter, the comment becomes unused and the typecheck fails. A positive
 * assignment check would keep compiling through exactly those changes and prove
 * nothing.
 *
 * The function is never called; compiling it is the whole point.
 */
function publicBlockDoorStaysHandleOnly(pi: ExtensionAPI): void {
	const block: UserBlock = pi.awaitUserDecision("Approve deploy?", "dialog");
	block.release();

	// @ts-expect-error a block must not be endable by id from the public API.
	pi.releaseUserBlock(block.id);

	// @ts-expect-error nor by label.
	pi.releaseUserBlockByLabel(block.label);

	// @ts-expect-error nor all at once.
	pi.clearUserBlocks();

	// @ts-expect-error the reason union is closed.
	pi.awaitUserDecision("Invalid", "not-a-reason");

	// @ts-expect-error release() takes no argument, so it cannot target another block.
	block.release(block.id);
}

void publicBlockDoorStaysHandleOnly;

test("the public block door exposes the documented reasons", () => {
	// The compile assertions above are the real test. This keeps the file a
	// runnable suite and pins the reason union's members, which the wire label
	// and the docs both depend on.
	const reasons: UserBlockReason[] = ["dialog", "project_trust", "workflow_prompt", "supervisor_ask"];
	assert.equal(new Set(reasons).size, 4);
});
