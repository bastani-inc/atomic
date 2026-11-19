import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type {
	AgentPanelAnswerOptions,
	AgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
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

async function replyBoard(initialQuestion: string | null = "Deploy to staging?") {
	const fixture = taskFixture();
	let item: AgentPanelItem = {
		id: "run:deploy",
		kind: "workflow",
		state: "input",
		name: "deploy",
		task: "stage ask",
		question: initialQuestion ?? undefined,
		promptId: initialQuestion ? "p1" : undefined,
	};
	let changed = () => {};
	const answers: { text: string; options: AgentPanelAnswerOptions | undefined }[] = [];
	let stops = 0;
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => [item],
		subscribe: (listener) => {
			changed = listener;
			return () => {};
		},
		answer: async (_id, text, options) => {
			answers.push({ text, options });
			return { ok: true };
		},
		stop: async () => {
			stops++;
			return { ok: true };
		},
	});
	return {
		inspector,
		answers,
		stops: () => stops,
		update: (patch: Partial<AgentPanelItem>) => {
			item = { ...item, ...patch };
			changed();
		},
		paint: () => stripVTControlCharacters(inspector.renderPicker(100, 30).join("\n")),
		type: (text: string) => {
			for (const char of text) inspector.handleInput(char);
		},
		dispose: async () => {
			inspector.dispose();
			await fixture.dispose();
		},
	};
}

test("reply punctuation stays in the reply rather than opening list help (#5224)", async () => {
	const board = await replyBoard();
	try {
		board.paint();
		board.type(" ");
		board.paint();
		board.type("can I ship?\r");
		assert.equal(board.answers[0]?.text, "can I ship?");
	} finally {
		await board.dispose();
	}
});

test.each([false, true])(
	"a hidden reply leaves stop keys on the list and never sends them after the question returns, paced=%s (#5224)",
	async (paced) => {
		const board = await replyBoard();
		try {
			board.paint();
			board.type(" ");
			board.paint();
			board.update({ question: undefined, promptId: undefined });
			assert.doesNotMatch(board.paint(), /│ ❯/);
			board.type("x");
			if (paced) board.paint();
			board.update({ question: "Deploy to staging?", promptId: "p1" });
			board.paint();
			board.type("\r");
			assert.equal(board.answers.length, 0);
		} finally {
			await board.dispose();
		}
	},
);

test("a hidden reply preserves its draft without appending list keys (#5224)", async () => {
	const board = await replyBoard();
	try {
		board.paint();
		board.type(" ");
		board.paint();
		board.type("no");
		board.update({ question: undefined, promptId: undefined });
		board.paint();
		board.type("x");
		assert.match(board.paint(), /Press x again/);
		board.update({ question: "Deploy to staging?", promptId: "p1" });
		board.paint();
		board.type("\r");
		assert.equal(board.answers[0]?.text, "no");
	} finally {
		await board.dispose();
	}
});

test("a hidden reply lets Space close its card and x x stop the run (#5224)", async () => {
	const board = await replyBoard();
	try {
		board.paint();
		board.type(" ");
		board.paint();
		board.update({ question: undefined, promptId: undefined });
		board.paint();
		board.type("x");
		assert.match(board.paint(), /Press x again/);
		board.type("x");
		assert.equal(board.stops(), 1);
		board.type(" ");
		assert.doesNotMatch(board.paint(), /╭─/);
	} finally {
		await board.dispose();
	}
});

test.each(["before first paint", "between paints"])(
	"typeahead cannot answer a question never painted %s (#5224)",
	async (timing) => {
		const board = await replyBoard(timing === "before first paint" ? "Delete the production database?" : null);
		try {
			if (timing === "between paints") {
				board.paint();
				board.update({ question: "Delete the production database?", promptId: "p2" });
			}
			board.type(" yes\r");
			assert.equal(board.answers.length, 0);
			assert.doesNotMatch(board.paint(), /❯ yes/);
			board.type("no\r");
			assert.equal(board.answers[0]?.text, "no");
		} finally {
			await board.dispose();
		}
	},
);

test("clearing a draft releases its target while closing, and a kept draft whose question changed is cleared rather than retargeted (#5224)", async () => {
	const board = await replyBoard();
	try {
		board.paint();
		board.type(" ");
		board.paint();
		board.type("no\x1b");
		board.update({ promptId: "p2", question: "Delete the production database?" });
		board.paint();
		board.type(" ");
		assert.doesNotMatch(board.paint(), /❯ no/);
		board.type("\r");
		assert.deepEqual(board.answers, []);
	} finally {
		await board.dispose();
	}
	const fresh = await replyBoard();
	try {
		fresh.paint();
		fresh.type(" ");
		fresh.paint();
		fresh.type("y\x7f");
		fresh.update({ promptId: "p2", question: "Delete the production database?" });
		fresh.paint();
		fresh.type("no\r");
		assert.equal(fresh.answers[0]?.options?.promptId, "p2");
	} finally {
		await fresh.dispose();
	}
});

test.each(["Delete the production database?", "Deploy to staging?"])(
	"an empty reply starts against the newly painted question %s (#5224)",
	async (question) => {
		const board = await replyBoard();
		try {
			board.paint();
			board.type(" ");
			board.paint();
			board.update({ question, promptId: "p2" });
			assert.ok(board.paint().includes(question));
			board.type("no\r");
			assert.equal(board.answers.length, 1);
			assert.equal(board.answers[0]?.options?.promptId, "p2");
			assert.equal(board.answers[0]?.text, "no");
		} finally {
			await board.dispose();
		}
	},
);
