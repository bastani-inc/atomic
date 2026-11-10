import assert from "node:assert/strict";
import { cleanupSessionResources, registerSessionResourceCleanup } from "@bastani/pi-ai/session-resources";
import { test } from "vitest";
import aiPackageJson from "../../packages/ai/package.json" with { type: "json" };

test("@bastani/pi-ai exports the session-resources subpath from its built entry", () => {
	assert.deepEqual(aiPackageJson.exports["./session-resources"], {
		types: "./dist/session-resources.d.ts",
		import: "./dist/session-resources.js",
	});
});

test("@bastani/pi-ai/session-resources resolves and runs registered cleanups for a session", () => {
	const cleanedSessions: Array<string | undefined> = [];
	const unregister = registerSessionResourceCleanup((sessionId) => {
		cleanedSessions.push(sessionId);
	});

	cleanupSessionResources("session-1");
	unregister();
	cleanupSessionResources("session-2");

	assert.deepEqual(cleanedSessions, ["session-1"]);
});
