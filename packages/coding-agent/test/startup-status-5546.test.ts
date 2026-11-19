import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	clearStartupStatus,
	leaveStartupStatusLine,
	replaceStartupStatus,
	restoreStartupStatus,
	showStartupStatus,
} from "../src/cli/startup-status.ts";
import { runCommand } from "../src/core/package-manager-command.ts";
import { withEarlyInputHeldForStartupDialog } from "../src/main-early-input.ts";
import { refreshColorEnvironment } from "../src/modes/interactive/theme/color-utils.ts";

/**
 * The line as a finished row of its own below the cursor's row: room for two rows below it (index twice, reverse index
 * twice), the cursor saved, down to the start of the next row; the cursor then waits at the start of the row below it.
 */
const line = (text: string) => `\x1bD\x1bD\x1bM\x1bM\x1b7\x1b[1B\r${text}\r\n`;
/** From the row below the line: up to the line's row, erase it, and the cursor back where it was. */
const ERASE = "\r\x1b[1A\x1b[2K\x1b8";
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

/** A terminal emulator behind a terminal stream whose size the test changes, as a resize does. */
function emulated(columns: number, rows: number) {
	const screen = new VirtualTerminal(columns, rows);
	const size = { columns, rows };
	const writes: string[] = [];
	/** What reaches the terminal, as one write. */
	const direct = (data: string) => {
		writes.push(data);
		screen.write(data);
		return true;
	};
	const output = Object.assign(new EventEmitter(), {
		isTTY: true,
		columns,
		rows,
		write: (data: string | Uint8Array) => direct(typeof data === "string" ? data : Buffer.from(data).toString()),
		// The stream asks the terminal for its size, as Node's and Bun's terminal streams do.
		_refreshSize() {
			output.columns = size.columns;
			output.rows = size.rows;
		},
	});
	return {
		screen,
		writes,
		direct,
		output,
		neighbors: { streams: [], console: {} },
		/** The terminal changes size; the process hears of it later. */
		resize(columns: number) {
			size.columns = columns;
			screen.resize(columns, rows);
		},
	};
}

test("what a launcher printed without ending its row stays, and the next output follows it as if the line had never been there (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	// Rows above the launcher's: room below it, the launcher's row at the bottom (the terminal scrolls to make room), and
	// a terminal too short for the line.
	for (const [rows, above] of [
		[8, 0],
		[8, 6],
		[2, 0],
	] as const) {
		for (const end of ["cancel", "first screen"] as const) {
			const { screen, output, neighbors } = emulated(30, rows);
			output.write(`${"earlier\r\n".repeat(above)}$ atomic\r\n界面: é`);
			showStartupStatus(output, neighbors);
			const shown = await screen.flushAndGetViewport();

			if (end === "cancel") clearStartupStatus();
			else
				replaceStartupStatus(
					() => {},
					() => output.write(""),
				);
			output.write("!");
			const after = await screen.flushAndGetViewport();
			const context = `${rows} rows, ${above} above, after the ${end}:\n${after.join("\n")}`;
			const launcherRow = after.indexOf("界面: é!");
			assert.ok(launcherRow >= 0, context);
			if (launcherRow > 0) assert.equal(after[launcherRow - 1], "$ atomic", context);
			assert.ok(!screen.getScrollBuffer().some((row) => row.includes("Starting")), context);
			// While it showed, the line was a row of its own, below the launcher's.
			assert.ok(shown.includes("界面: é"), shown.join("\n"));
			if (rows >= 3) assert.ok(shown.includes("Starting Atomic…"), shown.join("\n"));
		}
	}
});

test("a terminal that changes size while the first screen is drawn keeps the whole line, not a piece of it (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { screen, writes, output, neighbors, resize } = emulated(30, 8);
	output.write("$ atomic\r\n");
	showStartupStatus(output, neighbors);
	writes.length = 0;

	replaceStartupStatus(
		() => {},
		() => {
			// Drawing the first frame takes a while; the terminal narrows meanwhile and rewraps the line.
			resize(4);
			output.write("frame");
		},
	);
	assert.equal(writes.length, 1);
	// Erasing a row of a rewrapped line would leave the rest of it behind: the write only draws the frame.
	assert.ok(!writes[0]!.includes("\x1b[2K"), JSON.stringify(writes[0]));
	resize(30);
	const rows = (await screen.flushAndGetViewport()).map((row) => row.trimEnd());
	assert.ok(
		rows.filter((row) => /Start|Atomic|…/.test(row)).every((row) => row.startsWith("Starting Atomic…")),
		rows.join("\n"),
	);
});

test("something else that writes while the first screen is drawn keeps its output, and the line stays whole (#5546)", async () => {
	refreshColorEnvironment({ NO_COLOR: "1" });
	const { screen, writes, direct, output } = emulated(30, 8);
	// Another stream on the same terminal.
	const stderr = { isTTY: true, write: direct };
	output.write("$ atomic\r\n");
	showStartupStatus(output, { streams: [stderr], console: {} });
	writes.length = 0;

	// What the interface writes while it takes the terminal goes out in one write; a warning on stderr reaches the
	// terminal at once, below the line, before it.
	replaceStartupStatus(
		() => {},
		() => {
			stderr.write("Warning: slow\r\n");
			output.write("frame");
		},
	);
	assert.deepEqual(writes, ["Warning: slow\r\n", "frame"]);
	const rows = (await screen.flushAndGetViewport()).map((row) => row.trimEnd());
	assert.ok(rows.includes("Warning: slow"), rows.join("\n"));
	assert.ok(rows.includes("Starting Atomic…"), rows.join("\n"));
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
		assert.deepEqual(writes.slice(5), [`bytes:\x1b[?2026h\r\x1b[2K\x1b[?2026l${STATUS}`]);
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
	// The line comes back below the row the dialog left the cursor on.
	assert.deepEqual(writes.slice(1), [`\x1b[?2026h${ERASE}Pick one`, STATUS]);

	await withEarlyInputHeldForStartupDialog(async () => {
		output.write("\x1b[?2026hPick another");
		stderr.write("Warning: slow");
	});
	assert.deepEqual(writes.slice(3), [`\x1b[?2026h${ERASE}Pick another`, "stderr:Warning: slow", STATUS]);
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

test("once something may write to the terminal past Atomic's streams, the line is left as it is (#5546)", async () => {
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
