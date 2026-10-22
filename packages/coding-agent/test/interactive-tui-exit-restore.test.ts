import { expect, test } from "vitest";
import { createFullscreenTui } from "../src/modes/interactive/interactive-tui.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";

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
		expect(added).toHaveLength(1);
		added[0]?.(0);

		expect(terminal.restores).toHaveLength(1);
		const { before, after } = terminal.restores[0]!;
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[?1003l", "\x1b[?1000l"]) {
			expect(before).toContain(sequence);
		}
		expect(after.endsWith("\x1b[?1049l\x1b[?25h")).toBe(true);
	} finally {
		tui.stop();
	}
	expect(process.listeners("exit")).not.toContain(added[0]);
});
