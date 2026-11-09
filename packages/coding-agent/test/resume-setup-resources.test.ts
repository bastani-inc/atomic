import assert from "node:assert/strict";
import { test } from "vitest";
import { cliResumeTrust } from "../src/main-session.ts";

test("CLI trust for a restored worktree: the command-line override, then the saved decision, then the default (#4329)", () => {
	const store = { get: (path: string) => (path === "/saved-yes" ? true : path === "/saved-no" ? false : null) };
	assert.equal(cliResumeTrust(false, store, "always")("/saved-yes"), false);
	assert.equal(cliResumeTrust(true, store, "never")("/saved-no"), true);
	assert.equal(cliResumeTrust(undefined, store, "never")("/saved-yes"), true);
	assert.equal(cliResumeTrust(undefined, store, "always")("/saved-no"), false);
	assert.equal(cliResumeTrust(undefined, store, "always")("/unknown"), true);
	assert.equal(cliResumeTrust(undefined, store, "ask")("/unknown"), false);
});
