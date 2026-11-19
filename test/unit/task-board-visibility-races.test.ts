import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function item(id: string, state: AgentPanelItem["state"]): AgentPanelItem {
	return { id: `run:${id}`, kind: "workflow", state, name: id, task: "Build release" };
}

function harness(initial: AgentPanelItem[]) {
	const fixture = taskFixture();
	let items = initial;
	let changed = () => {};
	const stopped: string[] = [];
	const opened: string[] = [];
	const dismissed: string[] = [];
	const answers: string[] = [];
	let closed = 0;
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {
			closed++;
		},
	);
	inspector.setBoardSource({
		items: () => items,
		subscribe(listener) {
			changed = listener;
			return () => {};
		},
		open: (id) => {
			opened.push(id);
			return true;
		},
		stop: async (id) => {
			stopped.push(id);
			return { ok: true };
		},
		dismiss: (id) => dismissed.push(id),
		answer: async (_id, text) => {
			answers.push(text);
			return { ok: true };
		},
	});
	return {
		inspector,
		stopped,
		opened,
		dismissed,
		answers,
		closed: () => closed,
		paint: (height = 24) => stripVTControlCharacters(inspector.renderViewport(100, height).join("\n")),
		replace(next: AgentPanelItem[]) {
			items = next;
			changed();
		},
		async dispose() {
			inspector.dispose();
			await fixture.dispose();
		},
	};
}

test("a stop key for a vanished selection cannot dismiss or stop the replacement row (#5224)", async () => {
	for (const state of ["done", "running"] as const) {
		const h = harness([item("selected", "running"), item("other", state)]);
		try {
			assert.match(h.paint(), /❯ ∀ selected/);
			h.replace([item("other", state)]);
			h.inspector.handleInput("x");
			if (state === "running") h.inspector.handleInput("x");
			assert.deepEqual(h.stopped, []);
			assert.deepEqual(h.dismissed, []);
		} finally {
			await h.dispose();
		}
	}
});

test("an open or peek key for a vanished row never acts on its replacement (#5224)", async () => {
	for (const key of ["\r", " "]) {
		const h = harness([item("selected", "running"), item("other", "running")]);
		try {
			h.paint();
			h.replace([item("other", "running")]);
			h.inspector.handleInput(key);
			assert.deepEqual(h.opened, []);
			assert.doesNotMatch(h.paint(), /╭─ other ─/);
		} finally {
			await h.dispose();
		}
	}
});

test("a dismissed stopped run returns when the same id resumes (#5224)", async () => {
	const h = harness([item("release", "stopped")]);
	try {
		h.paint();
		h.inspector.handleInput("x");
		assert.deepEqual(h.dismissed, ["run:release"]);
		assert.doesNotMatch(h.paint(), /Build release/);
		h.replace([item("release", "running")]);
		assert.match(h.paint(), /❯ ∀ release.*Build release/);
	} finally {
		await h.dispose();
	}
});

test("the 80- and 160-column list and peek hints retain every live command in order (#5224)", async () => {
	const h = harness([item("release", "running")]);
	const hint = "↑↓ select · space peek · enter/→ open · x stop · / filter · esc/← close · ? keys";
	const peekHint = "↑↓ select · enter/→ open · x stop · / filter · space/esc/← close · ? keys";
	try {
		for (const width of [80, 160]) {
			assert.equal(stripVTControlCharacters(h.inspector.renderViewport(width, 24).at(-1)!).trim(), hint);
			h.inspector.handleInput(" ");
			assert.equal(stripVTControlCharacters(h.inspector.renderViewport(width, 24).at(-1)!).trim(), peekHint);
			h.inspector.handleInput("\x1b");
		}
	} finally {
		await h.dispose();
	}
});

test("a finished row keeps its dismissal and help keys at 80 columns (#5224)", async () => {
	const h = harness([item("release", "done")]);
	try {
		const line = stripVTControlCharacters(h.inspector.renderViewport(80, 24).at(-1)!).trim();
		assert.equal(line, "↑↓ select · space peek · enter/→ open · x dismiss · esc/← close · ? keys");
	} finally {
		await h.dispose();
	}
});

test("Left on a non-editable peek closes only the card before closing the task sheet (#5224)", async () => {
	const h = harness([item("release", "running")]);
	try {
		h.paint();
		h.inspector.handleInput(" ");
		assert.match(h.paint(), /╭─ release ─/);
		h.inspector.handleInput("\x1b[D");
		assert.equal(h.closed(), 0);
		assert.doesNotMatch(h.paint(), /╭─ release ─/);
		h.inspector.handleInput("\x1b[D");
		assert.equal(h.closed(), 1);
	} finally {
		await h.dispose();
	}
});

test("typeahead cannot answer a question clipped out of a narrow row before its peek paints (#5224)", async () => {
	const h = harness([{ ...item("release", "input"), question: "Delete the old releases?", promptId: "delete" }]);
	try {
		const narrow = stripVTControlCharacters(h.inspector.renderViewport(10, 12).join("\n"));
		assert.doesNotMatch(narrow, /Delete/);
		h.inspector.handleInput(" ");
		for (const key of "yes") h.inspector.handleInput(key);
		h.inspector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(h.answers, []);
		h.inspector.renderViewport(5, 12);
		for (const key of "yes") h.inspector.handleInput(key);
		h.inspector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(h.answers, [], "a fully clipped peek question is not painted either");
	} finally {
		await h.dispose();
	}
});

test("an empty task sheet advertises its live filter key (#5224)", async () => {
	const h = harness([]);
	try {
		assert.match(h.paint().split("\n").at(-1)!, /\/ filter · esc\/← close · \? keys/);
		h.inspector.handleInput("/");
		assert.match(h.paint(), /⌕/);
	} finally {
		await h.dispose();
	}
});

test("a paused workflow remains unfinished and needs confirmation to stop (#5224)", async () => {
	const h = harness([item("release", "paused")]);
	try {
		const frame = h.paint();
		assert.match(frame, /Tasks {2}1 working/);
		assert.doesNotMatch(frame, /1 done| {3}Done/);
		h.inspector.handleInput("x");
		assert.deepEqual(h.dismissed, []);
		assert.deepEqual(h.stopped, []);
		h.inspector.handleInput("x");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(h.stopped, ["run:release"]);
		assert.deepEqual(h.dismissed, []);
	} finally {
		await h.dispose();
	}
});

test("a digit for a clipped choice remains editable reply text (#5224)", async () => {
	const h = harness([
		{
			...item("choices", "input"),
			question: "Which release?",
			promptId: "choices",
			choices: ["Use v1", "Use v2", "Use v3"],
		},
	]);
	try {
		h.paint(9);
		h.inspector.handleInput(" ");
		assert.doesNotMatch(h.paint(9), /2 Use v2/);
		h.inspector.handleInput("2");
		assert.match(h.paint(9), /❯ 2/);
		h.inspector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(h.answers, ["2"]);
	} finally {
		await h.dispose();
	}
});

test("a tiny peek shows a changed question before offering its reply input (#5224)", async () => {
	const first: AgentPanelItem = {
		...item("question", "input"),
		question: "Release name?",
		promptId: "first",
	};
	const h = harness([first]);
	try {
		h.paint();
		h.inspector.handleInput(" ");
		assert.match(h.paint(), /Release name\?/);
		h.replace([{ ...first, question: "Delete the release?", promptId: "second" }]);
		const tiny = h.paint(3);
		assert.match(tiny, /Delete the release\?/);
		assert.ok(tiny.indexOf("Delete the release?") < tiny.indexOf("│ ❯"));
		for (const key of "yes") h.inspector.handleInput(key);
		assert.match(h.paint(3), /❯ yes/);
		h.inspector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(h.answers, ["yes"]);
	} finally {
		await h.dispose();
	}
});
