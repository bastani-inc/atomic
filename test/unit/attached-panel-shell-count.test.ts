import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ReadonlyFooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type { ChatBoxSession } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { TaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.ts";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { initTheme, refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const identity = (text: string): string => text;
const plain = (rows: readonly string[]) => rows.map((row) => stripVTControlCharacters(row));
const COLOR_SGR = /\x1b\[(?:[\d;]*;)?(?:3\d|4\d|9[0-7]|10[0-7])(?:;[\d;]*)?m/;

const FOOTER_DATA: ReadonlyFooterDataProvider = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

function chat(): ChatBoxSession {
	const model = { provider: "faux", id: "idle-model", reasoning: false, contextWindow: 1000 };
	return {
		state: { model, thinkingLevel: "off" },
		model,
		sessionManager: SessionManager.inMemory(resolve("/work")),
		getContextUsage: () => undefined,
		modelRuntime: { isUsingOAuth: () => false },
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
	} as unknown as ChatBoxSession;
}

function hostOptions(overrides: Partial<ChatSessionHostOpts>): ChatSessionHostOpts {
	return {
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, value) => value,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		},
		footerData: FOOTER_DATA,
		...overrides,
	};
}

/** A subagent (agent row) plus two running background shells, as an attached chat's own tasks. */
function tasksWithShells(agents = 1): TaskRecord[] {
	return [
		...Array.from({ length: agents }, (_, index) => taskRecord(`agent-${index}`)),
		taskRecord("shell-1", "command"),
		taskRecord("shell-2", "command"),
	];
}

/** The main chat's shell segments for the same tasks: its hint line with `agentRows` subagent rows and 2 shells. */
function mainShellSegments(agentRows: number): string[] {
	const keybindings = new KeybindingsManager();
	return mainComposerHintSegments(keybindings, { agentRows, shells: 2 }).filter(
		(segment) => /shell/.test(segment) || segment === "/tasks to manage",
	);
}

const disposers: Array<() => void> = [];
beforeEach(() => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	disposers.push(() => setKeybindings(previous));
	initTheme("dark");
});
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	vi.unstubAllEnvs();
	refreshColorEnvironment();
	initTheme("dark");
});

/** A task store holding `tasks`: only the task list is read here; every other query answers nothing. */
function ownerStoreOf(tasks: readonly TaskRecord[]): object {
	const known: Record<string, unknown> = { tasks, backgroundTasks: tasks, subscribe: () => () => {} };
	return new Proxy(known, {
		get: (target, prop) =>
			typeof prop !== "string" || prop === "then" || prop in target ? Reflect.get(target, prop) : () => undefined,
	});
}

/** A workflow stage chat: the chat owns the stage's agent session and its task store. */
function stageChatRows(tasks: readonly TaskRecord[], width: number): string[] {
	const session = chat();
	bindOwnerTaskStore(session, ownerStoreOf(tasks) as never);
	const host = new ChatSessionHost(hostOptions({ getAgentSession: () => session as never }));
	disposers.push(() => host.dispose());
	return host.renderFooter(width);
}

/** An attached subagent chat: it shows the subagent's session and lists the subagent's own tasks. */
function subagentChatRows(tasks: readonly TaskRecord[], width: number): string[] {
	const source = { tasks, backgroundTasks: tasks, subscribe: () => () => {} } as unknown as TaskViewSource;
	const host = new ChatSessionHost(hostOptions({ getChatBoxSession: () => chat(), getTaskSource: () => source }));
	disposers.push(() => host.dispose());
	return host.renderFooter(width);
}

for (const [view, render] of [
	["an attached stage chat", stageChatRows],
	["an attached subagent chat", subagentChatRows],
] as const) {
	test(`${view} counts its running shells like the main chat's hint line instead of listing them as rows`, () => {
		const rows = plain(render(tasksWithShells(), 80));
		assert.equal(rows.filter((row) => row.includes("⧗")).length, 0, rows.join("\n"));
		assert.equal(rows.filter((row) => /◯ agent/.test(row)).length, 1, rows.join("\n"));
		const count = rows.find((row) => /\bshells\b/.test(row));
		assert.ok(count !== undefined, rows.join("\n"));
		assert.equal(count.trim(), mainShellSegments(1).join(" · "));
	});

	test(`${view} with only shells running says where to manage them, as the main chat does`, () => {
		const rows = plain(render(tasksWithShells(0), 80));
		assert.equal(rows.filter((row) => row.includes("⧗")).length, 0, rows.join("\n"));
		const count = rows.find((row) => /\bshells\b/.test(row));
		assert.equal(count?.trim(), mainShellSegments(0).join(" · "));
		assert.equal(count?.trim(), "2 shells · /tasks to manage");
	});
}

test("finished shells are not counted, and one running shell reads in the singular", () => {
	const [agent, running, finished] = tasksWithShells();
	finished!.execution = { kind: "settled", result: { kind: "completed", output: finished!.output, exitCode: 0 } };
	const rows = plain(renderTaskFooter([agent!, running!, finished!], 80));
	assert.deepEqual(
		rows.filter((row) => /shell/.test(row)).map((row) => row.trim()),
		["1 shell"],
	);
});

test("the shell count keeps its words at 40 columns and has no color under NO_COLOR", () => {
	vi.stubEnv("NO_COLOR", "1");
	refreshColorEnvironment();
	initTheme("dark");
	for (const render of [stageChatRows, subagentChatRows]) {
		const rows = render(tasksWithShells(0), 40);
		for (const row of rows) assert.doesNotMatch(row, COLOR_SGR);
		assert.ok(plain(rows).includes("  2 shells · /tasks to manage"), plain(rows).join("\n"));
	}
});
