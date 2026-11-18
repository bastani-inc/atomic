import assert from "node:assert/strict";
import { beforeAll, test, vi } from "vitest";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.ts";

/** Something a suite spies on, the way most files spy on a store, journal or session method. */
class Journal {
	append(entry: { readonly text: string }): { readonly appended: number } {
		return { appended: entry.text.length };
	}
}

const journal = new Journal();
const tracked = trackCollection();

beforeAll(() => {
	// What a test before this one leaves behind: a spy that saw a large call, put back the way most files put spies back.
	const append = vi.spyOn(journal, "append");
	const entry = { text: "stage output\n".repeat(50_000) };
	const receipt = journal.append(entry);
	assert.deepEqual(append.mock.calls, [[entry]]);
	tracked.track(entry);
	tracked.track(receipt);
	vi.restoreAllMocks();
});

test("a test does not keep what spies recorded before it started (#5552)", async () => {
	await collectEverythingTracked(tracked, 100);
	assert.deepEqual(
		tracked.uncollected(),
		[],
		"a restored spy's arguments and results must be released once the next test starts",
	);
});
