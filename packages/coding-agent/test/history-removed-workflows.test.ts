import assert from "node:assert/strict";
import { it } from "vitest";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";

const searchRequest = { pattern: "missing", literal: false, ignoreCase: false, contextAfter: 0, contextBefore: 0 };

async function outcome(run: () => Promise<string | undefined>): Promise<string> {
	try {
		return `result: ${await run()}`;
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

it("reads and searches history://workflows exactly like an unknown history resource, without opening storage", async () => {
	const router = createHistoryRouter({
		cwd: "/project",
		sessionStore: () => {
			throw new Error("must not open storage");
		},
	});
	for (const suffix of ["", "/", "/old-run", "/old-run:1-4", "?run=old-run&cursor=1", "?limit=2", "#x"]) {
		const removed = `history://workflows${suffix}`;
		const unknown = `history://never-a-resource${suffix}`;
		const expectedRead = (await outcome(() => router.read!(unknown))).replaceAll("never-a-resource", "workflows");
		const expectedSearch = (await outcome(() => router.search!(unknown, searchRequest))).replaceAll(
			"never-a-resource",
			"workflows",
		);
		assert.match(expectedRead, /^error: /, unknown);
		assert.equal(await outcome(() => router.read!(removed)), expectedRead, removed);
		assert.equal(await outcome(() => router.search!(removed, searchRequest)), expectedSearch, removed);
	}
});
