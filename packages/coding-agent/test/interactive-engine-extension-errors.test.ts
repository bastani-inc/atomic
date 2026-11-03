/**
 * Interactive mode runs its session in an engine process, which reports each extension error on its event stream
 * (`extension_error`). The host must hand those to its own session's error listeners, which interactive mode shows
 * in the chat. A session that could not save a message reports why only this way (#4226).
 */

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ExtensionError } from "../src/core/extensions/index.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";

let pair: EngineHostPair | undefined;

afterEach(async () => {
	await pair?.cleanup();
	pair = undefined;
});

test("an extension error from the interactive engine reaches the host session's error listeners (#4226)", async () => {
	pair = await createEngineHostPair({});
	const errors: ExtensionError[] = [];
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {}, onError: (error) => errors.push(error) });
	const reported = {
		extensionPath: "<session>",
		event: "message_end",
		error: "could not persist the user message: Session conflict: s1, expected 4, actual 5",
	};

	pair.engineOutput({ type: "extension_error", ...reported });

	await vi.waitFor(() => assert.equal(errors.length, 1));
	assert.deepEqual(errors[0], reported);
});
