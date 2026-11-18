import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test } from "vitest";
import { clearStartupStatus, showStartupStatus } from "../src/cli/startup-status.ts";
import { runCommand } from "../src/core/package-manager-command.ts";
import { withEarlyInputHeldForStartupDialog } from "../src/main-early-input.ts";
import { refreshColorEnvironment } from "../src/modes/interactive/theme/color-utils.ts";

/** Back to the first column and erase `rows` rows from there, leaving the cursor at the start of the first. */
const eraseRows = (rows: number) => `\r\x1b7\x1b[2K${"\x1b[1B\x1b[2K".repeat(rows - 1)}\x1b8`;
const ERASE = eraseRows(1);
const line = (text: string, rows = 1) => `${eraseRows(rows)}${text}\r`;

/** A terminal that records what each writer sends it, in order. */
function terminal(columns: number) {
	const writes: string[] = [];
	const output = Object.assign(new EventEmitter(), {
		isTTY: true,
		columns,
		write: (text: string) => writes.push(text),
	});
	const stderr = { isTTY: true, write: (text: string) => writes.push(`stderr:${text}`) };
	const console = { log: (...args: unknown[]) => writes.push(`console:${args.join(" ")}\n`) };
	return { writes, output, stderr, console, neighbors: { streams: [stderr], console } };
}

afterEach(() => {
	clearStartupStatus();
	refreshColorEnvironment();
});

test("the startup status line fits a narrow terminal on one row and follows NO_COLOR (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const narrow = terminal(10);
	showStartupStatus(narrow.output, narrow.neighbors);
	assert.deepEqual(narrow.writes, [line("Starting…")]);
	clearStartupStatus();
	assert.deepEqual(narrow.writes.slice(1), [ERASE]);

	refreshColorEnvironment({});
	const wide = terminal(80);
	showStartupStatus(wide.output, wide.neighbors);
	assert.deepEqual(wide.writes, [line("\x1b[2mStarting Atomic…\x1b[22m")]);
});

test("output written while the status line shows gets rows of its own, with the line below it (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, stderr, console, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);

	console.log("extension loading");
	stderr.write("Warning: slow\n");
	output.write("partial");
	output.write(" line\n");

	assert.deepEqual(writes, [
		line("Starting Atomic…"),
		ERASE,
		"console:extension loading\n",
		line("Starting Atomic…"),
		ERASE,
		"stderr:Warning: slow\n",
		line("Starting Atomic…"),
		ERASE,
		"partial",
		// The line waits until the output ended its row.
		" line\n",
		line("Starting Atomic…"),
	]);

	// Modes and terminal queries neither draw nor move the cursor, so the line stays.
	output.write("\x1b[?2004h\x1b[c");
	assert.deepEqual(writes.slice(11), ["\x1b[?2004h\x1b[c"]);

	clearStartupStatus();
	assert.deepEqual(writes.slice(12), [ERASE]);
	// Once the line is gone for good, the writers are left as they were.
	console.log("after");
	assert.deepEqual(writes.slice(13), ["console:after\n"]);
});

test("the status line is drawn again to fit a terminal that was made narrower (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);

	output.columns = 8;
	output.emit("resize");
	// Too narrow for any text: what the terminal wrapped is erased, and the line returns once there is room.
	output.columns = 1;
	output.emit("resize");
	output.columns = 40;
	output.emit("resize");

	assert.deepEqual(writes, [
		line("Starting Atomic…"),
		// The 16 columns the line took wrap onto two rows of 8.
		line("Starti…", 2),
		eraseRows(7),
		line("Starting Atomic…"),
	]);
});

test("a startup dialog's first frame replaces the status line, which returns while startup still runs (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);
	await withEarlyInputHeldForStartupDialog(async () => {
		// Taking the terminal draws nothing yet, so the line stays until the dialog's first frame erases it.
		output.write("\x1b[?2004h");
		assert.deepEqual(writes, [line("Starting Atomic…"), "\x1b[?2004h"]);
		output.write("Trust project folder?");
		assert.deepEqual(writes.slice(2), [ERASE, "Trust project folder?"]);
		output.write(ERASE);
	});
	assert.deepEqual(writes.slice(5), [line("Starting Atomic…")]);

	clearStartupStatus();
	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("Second dialog");
	});
	// Once the first screen took its place, a later dialog brings nothing back.
	assert.deepEqual(writes.slice(6), [ERASE, "Second dialog"]);
});

test("a package command that writes to the terminal itself has it while it runs, and the line returns after (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);

	// npm and git print straight to the terminal, past any writer the line can see, so it steps aside first.
	const ran = runCommand(process.execPath, ["-e", ""]);
	assert.deepEqual(writes, [line("Starting Atomic…"), ERASE]);
	await ran;
	assert.deepEqual(writes.slice(2), [line("Starting Atomic…")]);
});
