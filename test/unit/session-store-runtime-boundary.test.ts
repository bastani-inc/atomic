import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readText } from "../helpers/runtime.js";

test("session storage runtime modules remain portable", async () => {
	for (const file of ["types", "memory-session-store", "session-summary", "errors"]) {
		const source = await readText(
			fileURLToPath(new URL(`../../packages/coding-agent/src/core/storage/session/${file}.ts`, import.meta.url)),
		);
		assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'](?:node:|fs(?:\/|["'])|path["']|bun:)/);
	}
});
