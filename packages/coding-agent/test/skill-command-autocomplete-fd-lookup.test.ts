import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { it, vi } from "vitest";

/** The fd lookups started, and the way to finish the one in flight: finding fd on PATH starts a process. */
const fdLookup = vi.hoisted(() => ({ started: 0, finish: (_path: string | null) => {} }));

vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/tools-manager.ts")>();
	return {
		...actual,
		getToolPath(tool: "fd" | "rg" | "git") {
			if (tool !== "fd") return (actual.getToolPath as (name: typeof tool) => Promise<string | null>)(tool);
			fdLookup.started++;
			return new Promise<string | null>((resolve) => {
				fdLookup.finish = resolve;
			});
		},
	};
});

import { createSessionSkillAutocompleteProvider } from "../src/modes/interactive/skill-command-autocomplete.ts";

/** Turns a completion that needs no lookup settles within. */
const COMPLETION_TURNS = 20;

it("a / menu in a stage or subagent chat opens without waiting for the fd lookup that only @ mentions use", async () => {
	const provider = createSessionSkillAutocompleteProvider(async () => ({
		cwd: process.cwd(),
		skillCommands: [{ name: "skill:review", description: "Review changes" }],
	}));
	const signal = new AbortController().signal;

	const slash = provider.getSuggestions(["/"], 0, 1, { signal });
	const outcome = await Promise.race([
		slash,
		(async () => {
			for (let turn = 0; turn < COMPLETION_TURNS; turn++) await nextTurn();
			return "waiting" as const;
		})(),
	]);
	assert.notEqual(outcome, "waiting", "the / menu waited for fd to be found");
	const values = outcome === "waiting" ? [] : (outcome?.items.map((item) => item.value) ?? []);
	assert.ok(values.includes("tasks") && values.includes("skill:review"), values.join(", "));
	assert.equal(fdLookup.started, 0);

	const mention = provider.getSuggestions(["@READ"], 0, 5, { signal });
	for (let turn = 0; turn < COMPLETION_TURNS && fdLookup.started === 0; turn++) await nextTurn();
	assert.equal(fdLookup.started, 1, "an @ mention looks fd up");
	fdLookup.finish(null);
	await mention;
});
