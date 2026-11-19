import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { moduleDir, readText } from "../helpers/runtime.js";
import { taskFixture } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const docs = resolve(moduleDir(import.meta.url), "../../packages/coding-agent/docs");

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

test("the background tasks guide quotes the hint line /tasks draws for a selected row (#5224)", async () => {
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		await fixture.start("Spawn lock fix");
		const hint = stripVTControlCharacters(inspector.renderViewport(160, 24).at(-1) ?? "").trim();
		assert.match(hint, /space peek/, "the list's hint line");
		const guide = await readText(resolve(docs, "background-tasks.md"));
		assert.ok(guide.includes(`\`${hint}\``), `background-tasks.md does not quote the hint line \`${hint}\``);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});
