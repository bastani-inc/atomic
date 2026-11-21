import assert from "node:assert/strict";
import { cleanupSessionResources, registerSessionResourceCleanup } from "@bastani/atomic-ai/session-resources";
import { test } from "vitest";
import aiPackageJson from "../../packages/ai/package.json" with { type: "json" };

test("@bastani/atomic-ai exports the session-resources subpath from its built entry", () => {
	const entry = aiPackageJson.exports["./session-resources"];
	assert.equal(entry.types, "./dist/session-resources.d.ts");
	assert.equal(entry.import, "./dist/session-resources.js");
});

test("@bastani/atomic-ai/session-resources resolves and runs registered cleanups for a session", () => {
	const cleanedSessions: Array<string | undefined> = [];
	const unregister = registerSessionResourceCleanup((sessionId) => {
		cleanedSessions.push(sessionId);
	});

	cleanupSessionResources("session-1");
	unregister();
	cleanupSessionResources("session-2");

	assert.deepEqual(cleanedSessions, ["session-1"]);
});
