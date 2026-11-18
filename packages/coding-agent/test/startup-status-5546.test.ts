import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test } from "vitest";
import {
	clearStartupStatus,
	leaveStartupStatusLine,
	restoreStartupStatus,
	showStartupStatus,
} from "../src/cli/startup-status.ts";
import { runCommand } from "../src/core/package-manager-command.ts";
import { withEarlyInputHeldForStartupDialog } from "../src/main-early-input.ts";
import { refreshColorEnvironment } from "../src/modes/interactive/theme/color-utils.ts";

/** The line as a finished row of its own: the cursor waits at the start of the row below it. */
const line = (text: string) => `${text}\r\n`;
/** From the row below the line: up to the line's row, and erase it. */
const ERASE = "\r\x1b[1A\x1b[2K";
const STATUS = line("Starting Atomic…");

/** A terminal that records what each writer sends it, in order. */
function terminal(columns: number) {
	const writes: string[] = [];
	const output = Object.assign(new EventEmitter(), {
		isTTY: true,
		columns,
		rows: 24,
		write: (text: string | Uint8Array) => writes.push(typeof text === "string" ? text : `bytes:${Buffer.from(text)}`),
	});
	const stderr = { isTTY: true, write: (text: string) => writes.push(`stderr:${text}`) };
	const console = {
		log: (...args: unknown[]) => writes.push(`console:${args.join(" ")}\n`),
		assert: (condition: unknown) => {
			if (!condition) writes.push("console:Assertion failed\n");
		},
	};
	return { writes, output, stderr, console, neighbors: { streams: [stderr], console } };
}

afterEach(() => {
	clearStartupStatus();
	refreshColorEnvironment();
});

test("the startup status line is a finished line of its own, fits a narrow terminal and follows NO_COLOR (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const narrow = terminal(10);
	showStartupStatus(narrow.output, narrow.neighbors);
	assert.deepEqual(narrow.writes, [line("Starting…")]);
	// Nothing else was written: erasing the row above the cursor erases the line and nothing else.
	clearStartupStatus();
	assert.deepEqual(narrow.writes.slice(1), [ERASE]);

	refreshColorEnvironment({});
	const wide = terminal(80);
	showStartupStatus(wide.output, wide.neighbors);
	assert.deepEqual(wide.writes, [line("\x1b[2mStarting Atomic…\x1b[22m")]);
});

test("whatever else is written while the line shows goes below it untouched, and the line then stays whole (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, stderr, console, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);

	output.write("界面: é");
	console.assert(true);
	output.write(" suffix\n");
	stderr.write("Warning: slow");
	console.log("extension loading");

	// Nothing is erased or drawn around them: a row someone else started may still be theirs.
	assert.deepEqual(writes, [STATUS, "界面: é", " suffix\n", "stderr:Warning: slow", "console:extension loading\n"]);
	clearStartupStatus();
	assert.deepEqual(writes.length, 5);
	// Once startup is over, the writers are left as they were.
	console.log("after");
	assert.deepEqual(writes.slice(5), ["console:after\n"]);
});

test("a write that only switches a mode leaves the line on the screen for good (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);

	output.write(Buffer.from("\x1b[?25l"));
	output.write("\x1b[33mcolored\n\x1b[0m");

	assert.deepEqual(writes, [STATUS, "bytes:\x1b[?25l", "\x1b[33mcolored\n\x1b[0m"]);
	clearStartupStatus();
	assert.equal(writes.length, 3);
});

test("a terminal that changed size keeps the whole line, which it may have rewrapped (#5546)", () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);

	// A resize event that changed nothing changes nothing.
	output.emit("resize");
	output.columns = 4;
	output.emit("resize");
	output.columns = 80;
	output.emit("resize");

	assert.deepEqual(writes, [STATUS]);
	clearStartupStatus();
	assert.deepEqual(writes, [STATUS]);
});

test("a startup dialog's first frame erases the line in the same write, and the line returns in the write that clears it (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);
	await withEarlyInputHeldForStartupDialog(async () => {
		// Taking the terminal draws nothing yet, so the line stays until the dialog's first frame.
		output.write("\x1b[?2004h");
		output.write(Buffer.from("\x1b[>7u\x1b[?u\x1b]7501;?\x1b\\\x1b[c"));
		assert.deepEqual(writes.slice(1), ["\x1b[?2004h", "bytes:\x1b[>7u\x1b[?u\x1b]7501;?\x1b\\\x1b[c"]);
		// Its first frame, which starts with a synchronized update as every frame of Atomic's renderer, erases the line in it.
		output.write("\x1b[?2026hTrust project folder?\x1b[?2026l");
		assert.deepEqual(writes.slice(3), [`\x1b[?2026h${ERASE}Trust project folder?\x1b[?2026l`]);
		// The dialog redraws what it shows; the line is not drawn over it.
		output.write("\x1b[?2026h\r\x1b[2KTrust project folder? (yes)\x1b[?2026l");
		// Clearing its rows leaves the cursor on the first, where the line was, and the line comes back with it.
		const restored = restoreStartupStatus(() => {
			output.write("\x1b[?2026h\r\x1b[2K");
			output.write("\x1b[?2026l");
		});
		assert.equal(restored, true);
		assert.deepEqual(writes.slice(5), [`bytes:\x1b[?2026h\r\x1b[2K\x1b[?2026l\r${STATUS}`]);
		// What the dialog writes as it lets go of the terminal leaves the line alone.
		output.write("\x1b[?25h\x1b[?2004l");
	});
	assert.equal(writes.length, 7);

	clearStartupStatus();
	assert.deepEqual(writes.slice(7), [ERASE]);
	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("Second dialog");
	});
	// Once startup is over, a later dialog brings nothing back.
	assert.deepEqual(writes.slice(8), ["Second dialog"]);
});

test("the line comes back when a dialog that took its place closes, below what anyone else wrote meanwhile (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, stderr, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);
	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("\x1b[?2026hPick one");
	});
	// The dialog left the cursor at the start of the rows it used.
	assert.deepEqual(writes.slice(1), [`\x1b[?2026h${ERASE}Pick one`, `\r${STATUS}`]);

	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("\x1b[?2026hPick another");
		stderr.write("Warning: slow");
	});
	assert.deepEqual(writes.slice(3), [`\x1b[?2026h${ERASE}Pick another`, "stderr:Warning: slow", `\r\n${STATUS}`]);
});

test("a dialog draws below a line that is no longer Atomic's alone, and brings no second line (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, console, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);
	// Some runtimes write a console call past the streams, as this console does.
	console.log("extension loading");
	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("\x1b[?2026hTrust project folder?\x1b[?2026l");
		assert.equal(
			restoreStartupStatus(() => output.write("unexpected")),
			false,
		);
	});
	assert.deepEqual(writes, [STATUS, "console:extension loading\n", "\x1b[?2026hTrust project folder?\x1b[?2026l"]);
	clearStartupStatus();
	assert.equal(writes.length, 3);
});

test("what anyone else writes while a dialog has the terminal is not taken for the dialog's frame (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, stderr, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);
	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("loading");
		stderr.write("Warning: slow\n");
		// The line is no longer right above the cursor, so the dialog draws below everything, the line included.
		output.write("\x1b[?2026hTrust project folder?\x1b[?2026l");
		// The line did not give way to the dialog, so the dialog clears its rows as it would.
		assert.equal(
			restoreStartupStatus(() => output.write("unexpected")),
			false,
		);
		output.write("\x1b[?2026h\r\x1b[2K\x1b[?2026l");
	});
	clearStartupStatus();
	assert.deepEqual(writes, [
		STATUS,
		"loading",
		"stderr:Warning: slow\n",
		"\x1b[?2026hTrust project folder?\x1b[?2026l",
		"\x1b[?2026h\r\x1b[2K\x1b[?2026l",
	]);
});

test("a package command, which writes to the terminal itself, leaves the line as it is (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);

	// npm and git print straight to the terminal, past any writer Atomic can see, so the line is never erased again.
	await runCommand(process.execPath, ["-e", ""]);
	clearStartupStatus();
	assert.deepEqual(writes, [STATUS]);
});

test("extension code running in the interactive process leaves the line as it is (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { writes, output, neighbors } = terminal(80);
	showStartupStatus(output, neighbors);
	leaveStartupStatusLine();
	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("Trust project folder?");
	});
	clearStartupStatus();
	assert.deepEqual(writes, [STATUS, "Trust project folder?"]);
});
