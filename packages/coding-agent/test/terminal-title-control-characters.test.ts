import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { APP_TITLE } from "../src/config.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import "../src/modes/interactive/interactive-startup.js";

describe("terminal title (pi 89c921d8)", () => {
	it("replaces control characters in the session name so it cannot end the OSC title sequence", () => {
		const titles: string[] = [];
		const context = {
			sessionManager: {
				getCwd: () => "/work/repo",
				getSessionName: () => "work\x07\x1b]52;c;Zm9v\x07\u009b2J",
			},
			ui: { terminal: { setTitle: (title: string) => titles.push(title) } },
		};
		const updateTerminalTitle = Reflect.get(InteractiveModeBase.prototype, "updateTerminalTitle") as (
			this: typeof context,
		) => void;

		updateTerminalTitle.call(context);

		assert.deepEqual(titles, [`${APP_TITLE} - work ]52;c;Zm9v 2J - repo`]);
	});
});
