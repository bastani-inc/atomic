import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { clearStartupStatus, showStartupStatus } from "../src/cli/startup-status.ts";
import { withEarlyInputHeldForStartupDialog } from "../src/main-early-input.ts";
import { refreshColorEnvironment } from "../src/modes/interactive/theme/color-utils.ts";

const ERASE_LINE = "\r\x1b[2K";

function terminal(columns: number) {
	const writes: string[] = [];
	return { writes, output: { isTTY: true, columns, write: (text: string) => writes.push(text) } };
}

afterEach(() => {
	clearStartupStatus();
	refreshColorEnvironment();
});

test("the startup status line fits a narrow terminal on one row and follows NO_COLOR (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const narrow = terminal(10);
	showStartupStatus(narrow.output);
	assert.deepEqual(narrow.writes, ["\rStarting…\x1b[K"]);
	clearStartupStatus();
	assert.deepEqual(narrow.writes.slice(1), [ERASE_LINE]);

	refreshColorEnvironment({});
	const wide = terminal(80);
	showStartupStatus(wide.output);
	assert.match(wide.writes[0] ?? "", /^\r\x1b\[2mStarting atomic…\x1b\[22m\x1b\[K$/);
});

test("a startup dialog hides the status line, which returns while startup still runs (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output } = terminal(80);
	showStartupStatus(output);
	await withEarlyInputHeldForStartupDialog(async () => {
		// The dialog draws on a line that no longer holds the status.
		assert.deepEqual(writes, ["\rStarting atomic…\x1b[K", ERASE_LINE]);
	});
	assert.deepEqual(writes.slice(2), ["\rStarting atomic…\x1b[K"]);

	clearStartupStatus();
	await withEarlyInputHeldForStartupDialog(async () => {});
	// Once the first screen took its place, a later dialog brings nothing back.
	assert.deepEqual(writes.slice(3), [ERASE_LINE]);
});
