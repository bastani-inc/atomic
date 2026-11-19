import assert from "node:assert/strict";
import { it } from "vitest";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";

it("explains retired workflow history URLs without opening session storage", async () => {
	const router = createHistoryRouter({
		cwd: "/project",
		sessionStore: () => {
			throw new Error("must not open storage");
		},
	});
	for (const url of [
		"history://workflows",
		"history://workflows/old-run:1-4",
		"history://workflows?run=old-run&cursor=1",
	]) {
		assert.match((await router.read!(url)) ?? "", /no longer available/i);
		assert.match(
			(await router.search!(url, {
				pattern: "missing",
				literal: false,
				ignoreCase: false,
				contextAfter: 0,
				contextBefore: 0,
			})) ?? "",
			/no longer available/i,
		);
	}
});
