import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { StorageUnavailableError } from "../src/core/storage/session/errors.ts";
import {
	detachedResult,
	harnessPool,
	reopenedAfterDetaching,
	settlesWithin,
	transcriptRoles,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

describe("a detached call's result that its session store cannot save (#4309)", () => {
	test("fails the resumed turn with the store's failure, and the session still closes cleanly (#4309)", async () => {
		const tool = waitTool();
		const { reopened, store, sessionId } = await reopenedAfterDetaching(
			pool,
			[tool.definition],
			[waitForCiTurn("ci-1"), fauxAssistantMessage("never requested")],
		);
		const diskFull = new StorageUnavailableError(store.descriptor, new Error("database or disk is full"));
		const append = store.append.bind(store);
		vi.spyOn(store, "append").mockImplementation(async (id, entries, options) => {
			if (entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")) throw diskFull;
			return append(id, entries, options);
		});

		await assert.rejects(reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]), (error) => {
			assert.equal(error, diskFull);
			return true;
		});

		// Nothing after the call was saved, and the model was not asked to go on without its result.
		assert.deepEqual(transcriptRoles(await SessionManager.open(store, sessionId)), ["user", "assistant"]);
		// The failure belongs to the turn that hit it: closing the session does not report it again.
		await settlesWithin(reopened.session.dispose());
	});
});
