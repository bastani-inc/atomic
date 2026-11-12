import assert from "node:assert/strict";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, test } from "vitest";
import type { ReadonlyFooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { ChatBoxSession } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.ts";
import {
	FooterComponent,
	formatCwdForFooter,
} from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";

const identity = (text: string): string => text;
const text = (rows: readonly string[]) => stripVTControlCharacters(rows.join("\n"));

const FOOTER_DATA: ReadonlyFooterDataProvider = {
	getGitBranch: () => "demo-branch",
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

const CWD = resolve("/work");
const IDLE_LINE = `idle-model • ${formatCwdForFooter(CWD, process.env.HOME || process.env.USERPROFILE)} (demo-branch)`;

type Activity = Pick<ChatBoxSession, "isStreaming" | "isCompacting" | "isRetrying" | "isBashRunning">;
const IDLE: Activity = { isStreaming: false, isCompacting: false, isRetrying: false, isBashRunning: false };

/** Every way a chat's agent can be working, as the footer reads it from the session. */
const WORKING_STATES: ReadonlyArray<[string, Partial<Activity>]> = [
	// A turn: the model streaming, its tools executing, and queued follow-ups the turn delivers.
	["a turn or its tool calls", { isStreaming: true }],
	["a compaction", { isCompacting: true }],
	["an automatic retry's backoff", { isRetrying: true }],
	["a ! shell command", { isBashRunning: true }],
];

function session(activity: Partial<Activity> = {}): ChatBoxSession {
	const model = { provider: "faux", id: "idle-model", reasoning: false, contextWindow: 1000 };
	return {
		state: { model, thinkingLevel: "off" },
		model,
		sessionManager: SessionManager.inMemory(CWD),
		getContextUsage: () => undefined,
		modelRuntime: { isUsingOAuth: () => false },
		...IDLE,
		...activity,
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

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

/** The main chat's footer, built as interactive mode builds it. */
function mainFooterLine(chat: ChatBoxSession, navigationActive = false): string {
	initTheme("dark");
	const footer = new FooterComponent(chat, FOOTER_DATA, undefined, () => navigationActive);
	disposers.push(() => footer.dispose());
	return text(footer.render(120)).split("\n")[0] ?? "";
}

/** A workflow stage chat's footer: the chat owns the stage's live agent session. */
function stageFooterLine(chat: ChatBoxSession): string {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions({ getAgentSession: () => chat as never }));
	disposers.push(() => host.dispose());
	return text(host.renderFooter(120)).split("\n")[0] ?? "";
}

/** A subagent's chat: the chat shows the subagent's session without owning it. */
function subagentFooterLine(chat: ChatBoxSession): string {
	initTheme("dark");
	const host = new ChatSessionHost(hostOptions({ getChatBoxSession: () => chat }));
	disposers.push(() => host.dispose());
	return text(host.renderFooter(120)).split("\n")[0] ?? "";
}

test("the main, stage and subagent chats show the model line when their agent is idle (#4690)", () => {
	assert.equal(mainFooterLine(session()), IDLE_LINE);
	assert.equal(stageFooterLine(session()), IDLE_LINE);
	assert.equal(subagentFooterLine(session()), IDLE_LINE);
});

for (const [state, activity] of WORKING_STATES) {
	test(`the main chat hides the model line and offers to interrupt during ${state} (#4690)`, () => {
		assert.equal(mainFooterLine(session(activity)), "esc to interrupt");
	});

	test(`a stage chat hides the model line and offers to interrupt during ${state} (#4690)`, () => {
		assert.equal(stageFooterLine(session(activity)), "esc to interrupt");
	});

	test(`a subagent's chat hides the model line during ${state} without offering to interrupt it (#4690)`, () => {
		assert.equal(subagentFooterLine(session(activity)), "working");
	});
}

test("the main chat hides the model line while task navigation is open over a running turn (#4690)", () => {
	assert.equal(mainFooterLine(session({ isStreaming: true }), true), "working");
	assert.equal(mainFooterLine(session(), true), IDLE_LINE);
});

test("a stage chat hides the model line while /tasks is open over a running turn (#4690)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	disposers.push(() => fixture.dispose());
	let chat = session({ isStreaming: true });
	const host = new ChatSessionHost(
		hostOptions({ getAgentSession: () => chat as never, getTaskSource: () => ownerTaskViewSource(fixture.store) }),
	);
	disposers.push(() => host.dispose());
	host.openTasks();
	assert.equal(host.hasTaskInspector, true);
	const lines = () => text(host.renderFooter(120)).split("\n");
	assert.equal(lines()[0], "working");
	chat = session();
	assert.equal(lines()[0], IDLE_LINE);
});
