import assert from "node:assert/strict";
import { test } from "vitest";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.js";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.js";

class ExitRestoreTerminal extends RecordingTerminal {
	readonly restores: Array<{ before: string; after: string }> = [];

	restoreOnExit(before: string, after: string): void {
		this.restores.push({ before, after });
	}
}

test("restores the fullscreen terminal modes when the process exits without stop() (#11170)", () => {
	const terminal = new ExitRestoreTerminal();
	const tui = createFullscreenTui({ showHardwareCursor: false, logDirectory: "/tmp", terminal });
	const listenersBefore = new Set(process.listeners("exit"));
	tui.start();
	const added = process.listeners("exit").filter((listener) => !listenersBefore.has(listener));
	try {
		assert.equal(added.length, 1);
		added[0]?.(0);

		assert.equal(terminal.restores.length, 1);
		const { before, after } = terminal.restores[0]!;
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[?1003l", "\x1b[?1000l"]) {
			assert.ok(before.includes(sequence), `missing ${JSON.stringify(sequence)}`);
		}
		assert.ok(after.endsWith("\x1b[?1049l\x1b[?25h"));
	} finally {
		tui.stop();
	}
	assert.ok(!process.listeners("exit").includes(added[0]!));
});
