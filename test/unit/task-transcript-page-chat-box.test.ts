import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getKeybindings, setKeybindings, Text, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type {
	AttemptId,
	Generation,
	OperationId,
	OwnerId,
	TaskId,
	TaskRecord,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { ChatBoxSession, TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	launchedTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { ChatTranscriptComponent } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import { formatCwdForFooter } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import {
	TaskAgentTranscriptPage,
	TaskCommandOutputPage,
	type TaskTranscriptEnvironment,
} from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";
import { WORKED_LINE, WORKING_LINE, WORKING_MESSAGE } from "../helpers/working-line.ts";
import { makeTestTui } from "../support/fake-tui.js";

const ESCAPE = "\x1b";
const LEFT = "\x1b[D";
const ENTER = "\r";
const SPACE = " ";
const OWNER = "owner-1" as OwnerId;

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const plain = (rows: readonly string[]) => rows.map((row) => stripVTControlCharacters(row));
const text = (rows: readonly string[]) => plain(rows).join("\n");
/**
 * A chat's own active tasks below its footer: subagents as agent-panel rows (#5224), and its running shells counted on
 * one line, as the main chat's hint counts them.
 */
const TASK_ROW = /^ {2}(?:∀ |\d+ shells?\b)/;
const taskRows = (rows: readonly string[]) => plain(rows).filter((row) => TASK_ROW.test(row));

/** The attached composer's top rule: the main composer's rule, ending in its label and one rule glyph (#5224). */
const labelRows = (rows: readonly string[]) => plain(rows).filter((row) => /^─+ .+ ─$/.test(row));

function record(id: string, kind: TaskRecord["kind"], parent?: string, extra: Partial<TaskRecord> = {}): TaskRecord {
	const taskId = id as TaskId;
	return {
		ref: { ownerId: OWNER, taskId, attemptId: "1" as AttemptId, generation: "1" as Generation },
		launchOperationId: `op-${id}` as OperationId,
		...(parent === undefined ? {} : { parentTaskId: parent as TaskId }),
		launchOrdinal: 0,
		kind,
		title: `title-${id}`,
		...(kind === "agent" ? { agentName: `agent-${id}` } : {}),
		execution: { kind: "running" },
		observation: { kind: "background", reason: "explicit" },
		wasBackground: true,
		attention: { kind: "none" },
		cleanup: { kind: "active" },
		output: { ownerId: OWNER, taskId, artifactId: `output-${id}`, byteCount: "0", omittedRanges: [] },
		...extra,
	};
}

/**
 * The parent's own shell `parent-shell`; its subagent `child` with the shell `child-shell` and the subagent
 * `grandchild` it launched; and that subagent's shell `grandchild-shell`.
 */
const tree = (): TaskRecord[] => [
	record("parent-shell", "command"),
	record("child", "agent"),
	record("child-shell", "command", "child"),
	record("grandchild", "agent", "child"),
	record("grandchild-shell", "command", "grandchild"),
];

type Listener = (event: AgentSessionEvent) => void;

function session(id: string, intercomTarget?: string): TaskTranscriptSource & { listeners: Set<Listener> } {
	const listeners = new Set<Listener>();
	return {
		listeners,
		getSessionId: () => `session-${id}`,
		getEntries: () => [],
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		...(intercomTarget === undefined ? {} : { completionSource: { runId: "aabcf28b", intercomTarget } }),
	};
}

function treeSource(
	tasks: TaskRecord[] = tree(),
	sessions: ReadonlyMap<string, TaskTranscriptSource> = new Map(),
	overrides: Partial<TaskViewSource> = {},
): TaskViewSource {
	const listeners = new Set<() => void>();
	return {
		tasks,
		backgroundTasks: tasks,
		settlementOrder: new Map(),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		cancelTask: async () => ({ ok: true, value: undefined }),
		stdinAvailable: () => false,
		writeTaskInput: async () => ({ ok: true, value: { acceptedBytes: 0 } }),
		readTaskOutput: async (id) => ({ ok: true, value: { text: `output of ${id}`, omitted: false } }),
		taskDetailText: () => ({}),
		readTaskTranscript: (id) => ({
			ok: true,
			value: { messages: [{ role: "user", content: `transcript of ${id}`, timestamp: 1 }] },
		}),
		followTaskTranscript: (id) => {
			const followed = sessions.get(id);
			return followed === undefined ? undefined : { historyOnly: false, session: followed };
		},
		extensionStatuses: () => new Map(),
		watchExtensionStatuses: () => () => {},
		sendTaskMessage: async () => {},
		...overrides,
	};
}

function environment(overrides: Partial<TaskTranscriptEnvironment> = {}): TaskTranscriptEnvironment {
	return taskTranscriptEnvironment({ tui: makeTestTui(40), keybindings: getKeybindings(), ...overrides });
}

function subagentPage(
	source: TaskViewSource,
	taskId = "child",
	env: TaskTranscriptEnvironment = environment(),
	requestRender: () => void = () => {},
): TaskAgentTranscriptPage {
	return new TaskAgentTranscriptPage(source, taskId as TaskId, env, requestRender);
}

function select(component: { handleInput(data: string): boolean }, render: () => string[], pattern: RegExp): void {
	for (let attempt = 0; attempt < 10; attempt++) {
		const selected = plain(render()).find((row) => row.includes(" ❯ "));
		if (selected !== undefined && pattern.test(selected)) return;
		component.handleInput("\x1b[B");
	}
	assert.fail(`no task matches ${pattern}`);
}

async function type(page: { handleInput(data: string): boolean }, value: string): Promise<void> {
	for (const char of value) page.handleInput(char);
	await flush();
}

/** A chat host whose working status takes two rows, of which a short viewport keeps the last. */
class TwoRowWorkingChat extends ChatSessionHost {
	override renderPendingMessages(): string[] {
		return ["PENDING"];
	}
	override renderWorkingStatus(): string[] {
		return ["WORKING-1", "WORKING-2"];
	}
	override renderFooter(): string[] {
		return ["FOOTER"];
	}
}

/** A chat host whose status rows are named, so their order and budget are visible. */
class NamedRowsChat extends ChatSessionHost {
	override renderPendingMessages(): string[] {
		return ["PENDING"];
	}
	override renderWorkingStatus(): string[] {
		return ["WORKING"];
	}
	override renderUsage(): string[] {
		return ["USAGE"];
	}
	override renderFooter(): string[] {
		return ["FOOTER"];
	}
}

let previousKeybindings: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeybindings = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeybindings);
});

describe("a subagent's chat label (#4640, #5224)", () => {
	test("names the subagent, its task and its state on the composer's heavy top rule, above the prompt (#5224)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		const rows = plain(page.render(80, 12));
		const [label] = labelRows(rows);
		assert.match(label ?? "", /^─+ agent-child · title-child · running ─$/);
		assert.equal(visibleWidth(label ?? ""), 80);
		const top = rows.indexOf(label ?? "");
		assert.ok(rows[top + 1]?.startsWith("❯"), "the prompt stays on the editor's content line");
		assert.equal(rows[top + 2], "─".repeat(80), "the bottom rule is the main composer's rule too");
		page.dispose();
	});

	test("falls back to the session's name, then to `subagent`, when the task has no agent name (#5224)", async () => {
		const sessions = new Map([["child", session("child", "subagent-worker-aabcf28b-1")]]);
		const named = subagentPage(treeSource([record("child", "agent", undefined, { agentName: undefined })], sessions));
		await named.load();
		assert.match(labelRows(named.render(80, 12))[0] ?? "", / subagent-worker-aabcf28b-1 · title-child · /);
		named.dispose();
		const unnamed = subagentPage(treeSource([record("child", "agent", undefined, { agentName: undefined })]));
		await unnamed.load();
		assert.match(labelRows(unnamed.render(80, 12))[0] ?? "", / subagent · title-child · /);
		unnamed.dispose();
	});

	test("is left off below 40 columns and truncated with an ellipsis when it does not fit (#5224)", async () => {
		const page = subagentPage(
			treeSource([record("child", "agent", undefined, { title: "review ".repeat(20).trim() })]),
		);
		await page.load();
		assert.deepEqual(labelRows(page.render(39, 12)), []);
		const narrowRows = plain(page.render(39, 12));
		const prompt = narrowRows.findIndex((row) => row.startsWith("❯"));
		assert.equal(narrowRows[prompt - 1], "─".repeat(39), "narrow terminals keep the rule above the prompt");
		const [narrow] = labelRows(page.render(40, 12));
		assert.match(narrow ?? "", /^─+ agent-child · review.*… ─$/);
		assert.equal(visibleWidth(narrow ?? ""), 40);
		page.dispose();
	});

	test("keeps a scrolled draft's `↑ N more` note on its top rule (#5224)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		page.chat.setInputText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
		const rows = plain(page.render(80, 30));
		const top = rows.find((row) => row.includes("more") && row.startsWith("─"));
		assert.match(top ?? "", /↑ \d+ more/);
		assert.match(top ?? "", /agent-child · title-child · running/);
		assert.equal(visibleWidth(top ?? ""), 80);
		page.dispose();
	});

	test("says where typing goes, and that a stopped subagent resumes only with a message (#5224)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		assert.ok(
			plain(page.render(80, 12)).some(
				(row) => row.replace(/\x1b_[^\x07]*\x07/g, "").replace(/ +/g, " ") === "❯ Message agent-child…",
			),
		);
		page.dispose();
	});
});

describe("a subagent's chat box rows (#4640)", () => {
	function namedRowsPage(): TaskAgentTranscriptPage {
		return subagentPage(treeSource(), "child", environment({ createChat: (opts) => new NamedRowsChat(opts) }));
	}

	test("renders the transcript, pending messages, working line, usage, editor and footer in that order (#4640)", async () => {
		const page = namedRowsPage();
		await page.load();
		const rows = plain(page.render(80, 20));
		assert.equal(rows.length, 20);
		const at = (name: string) => rows.indexOf(name);
		const transcript = rows.findIndex((row) => row.includes("transcript of child"));
		const label = rows.indexOf(labelRows(rows)[0] ?? "");
		assert.ok(transcript >= 0 && transcript < at("PENDING"));
		assert.deepEqual(
			[at("PENDING"), at("WORKING"), at("USAGE"), label, at("FOOTER")],
			[13, 14, 15, 16, 19],
			"pending, working and usage sit right above the editor, and the footer is the last row",
		);
		assert.ok(rows[17]?.startsWith("❯"));
		page.dispose();
	});

	test("keeps the editor, then the footer, then the status rows when the viewport shrinks (#4640)", async () => {
		const page = namedRowsPage();
		await page.load();
		const kept = (rows: number) =>
			plain(page.render(80, rows)).map((row) =>
				labelRows([row]).length > 0 ? "LABEL" : row.startsWith("❯") ? "PROMPT" : row,
			);
		assert.deepEqual(kept(1), ["LABEL"]);
		assert.deepEqual(kept(0), ["LABEL"]);
		assert.deepEqual(kept(3), ["LABEL", "PROMPT", "─".repeat(80)]);
		assert.deepEqual(kept(4), ["LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		assert.deepEqual(kept(5), ["PENDING", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		assert.deepEqual(kept(6), ["PENDING", "WORKING", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		assert.deepEqual(kept(7), ["PENDING", "WORKING", "USAGE", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		const roomy = kept(8);
		assert.equal(roomy.length, 8, "the transcript takes the one row left");
		assert.deepEqual(roomy.slice(1), ["PENDING", "WORKING", "USAGE", "LABEL", "PROMPT", "─".repeat(80), "FOOTER"]);
		page.dispose();
	});

	test("keeps the last row of a working status that does not fit (#4640)", async () => {
		const page = subagentPage(
			treeSource(),
			"child",
			environment({ createChat: (opts) => new TwoRowWorkingChat(opts) }),
		);
		await page.load();
		assert.deepEqual(plain(page.render(80, 6)).slice(0, 2), ["PENDING", "WORKING-2"]);
		assert.deepEqual(plain(page.render(80, 7)).slice(0, 3), ["PENDING", "WORKING-1", "WORKING-2"]);
		page.dispose();
	});

	test("counts only the subagent's own running tasks in its footer (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		const rows = plain(page.render(80, 12));
		assert.equal(taskRows(rows).length, 2);
		assert.match(rows.at(-1) ?? "", TASK_ROW, "the rows close the chat box");
		page.dispose();
		const grandchild = subagentPage(treeSource(), "grandchild");
		await grandchild.load();
		assert.deepEqual(
			taskRows(grandchild.render(80, 12)).map((row) => row.replace(/ {2,}/g, "  ").trimEnd()),
			["  1 shell · /tasks to manage"],
		);
		grandchild.dispose();
	});
});

test("repaints its footer as its parent's tasks change without rebuilding its transcript (#4640)", async () => {
	const tasks = tree();
	const listeners = new Set<() => void>();
	const root = treeSource(tasks, new Map(), {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const page = subagentPage(root);
	await page.load();
	page.render(80, 12);
	const rebuilds = vi.spyOn(ChatTranscriptComponent.prototype, "invalidate");
	try {
		const changes = 5;
		for (let change = 0; change < changes; change++) {
			tasks.push(record(`child-late-${change}`, "command", "child"));
			for (const listener of listeners) listener();
			page.render(80, 12);
		}
		assert.equal(rebuilds.mock.calls.length, 0, "a task change rebuilds none of the transcript's rows");
		assert.equal(
			plain(page.render(80, 12)).at(-1),
			"  6 shells",
			"one subagent row, and the six running shells counted under it",
		);
	} finally {
		rebuilds.mockRestore();
		page.dispose();
	}
});

const LIVE_MODEL = {
	provider: "faux",
	id: "worker-model",
	reasoning: true,
	contextWindow: 200_000,
} as unknown as ChatBoxSession["model"];

const LIVE_CWD = resolve("/work/subagent");
const LIVE_FOOTER_CWD = formatCwdForFooter(LIVE_CWD, process.env.HOME || process.env.USERPROFILE);

/** The live session of a subagent: a model, an entry that used 1,200 input tokens, and a working directory. */
async function liveChatSession(cwd = LIVE_CWD): Promise<ChatBoxSession> {
	const sessionManager = SessionManager.inMemory(cwd);
	await sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "working" }],
		api: "openai-responses",
		provider: "faux",
		model: "worker-model",
		usage: {
			input: 1200,
			output: 340,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1540,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
		},
		stopReason: "stop",
		timestamp: 1,
	});
	return {
		state: { model: LIVE_MODEL, thinkingLevel: "low" },
		model: LIVE_MODEL,
		sessionManager,
		getContextUsage: () => ({ tokens: 1540, contextWindow: 200_000, percent: 0.77 }),
		modelRuntime: { isUsingOAuth: () => false },
		isStreaming: false,
	} as unknown as ChatBoxSession;
}

const footerData: ReadonlyFooterDataProvider = {
	getGitBranch: () => "feature",
	getExtensionStatuses: () => new Map([["parent-ext", "PARENT-STATUS"]]),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

describe("a live subagent's chat box (#4640)", () => {
	async function livePage(extra: Partial<TaskTranscriptSource> = {}, env: Partial<TaskTranscriptEnvironment> = {}) {
		const live = {
			...session("child", "subagent-worker-aabcf28b-1"),
			chatSession: await liveChatSession(),
			...extra,
		};
		const opened: Array<Parameters<TaskTranscriptEnvironment["createChat"]>[0]> = [];
		const page = subagentPage(
			treeSource(tree(), new Map([["child", live]])),
			"child",
			environment({
				footerData,
				...env,
				createChat: (opts) => {
					opened.push(opts);
					return new ChatSessionHost(opts);
				},
			}),
		);
		await page.load();
		return { page, live, opened };
	}

	test("shows the usage meter above the label and the model and folder footer, then the task count, below it (#4640)", async () => {
		const { page } = await livePage();
		const rows = plain(page.render(100, 20));
		const label = rows.indexOf(labelRows(rows)[0] ?? "");
		const usage = rows.findIndex((row) => row.includes("↑1.2k"));
		assert.ok(usage >= 0 && usage === label - 1, "the usage meter sits right above the prompt's top rule");
		assert.match(rows[usage] ?? "", /↓340 • \$0\.012 • 0\.8%\/200k \(auto\)$/);
		assert.equal(rows[label + 3], `worker-model  low • ${LIVE_FOOTER_CWD} (feature)`);
		assert.equal(taskRows(rows.slice(label + 4)).length, 2);
		page.dispose();
	});

	test("never makes the subagent's session the chat's own, so /tasks still lists only its tasks (#4640)", async () => {
		const { page, opened } = await livePage();
		assert.equal(opened[0]?.getAgentSession, undefined);
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		const list = text(page.render(100, 24));
		assert.match(list, /title-child-shell/);
		assert.doesNotMatch(list, /title-parent-shell|title-grandchild-shell/);
		page.dispose();
	});

	test("resolves tool and message renderers from the child session before the main chat (#5224)", async () => {
		const childTool = { renderCall: () => new Text("child tool", 0, 0) };
		const parentTool = { renderCall: () => new Text("parent tool", 0, 0) };
		const childMessage = vi.fn(() => new Text("child message", 0, 0));
		const parentMessage = vi.fn(() => new Text("parent message", 0, 0));
		const parentToolLookup = vi.fn(() => parentTool);
		const { page, opened } = await livePage(
			{
				chatSession: {
					...(await liveChatSession()),
					getToolDefinition: (name: string) => (name === "contact_supervisor" ? childTool : undefined),
					extensionRunner: {
						getMessageRenderer: (name: string) => (name === "intercom_message" ? childMessage : undefined),
					},
				},
			},
			{
				getChatRenderSettings: () => ({
					getToolDefinition: parentToolLookup,
					getCustomMessageRenderer: () => parentMessage,
				}),
			},
		);
		try {
			const settings = opened[0]?.getChatRenderSettings?.();
			assert.equal(settings?.getToolDefinition?.("contact_supervisor"), childTool);
			const intercomRenderer = settings?.getCustomMessageRenderer?.("intercom_message");
			assert.notEqual(intercomRenderer, parentMessage);
			assert.deepEqual(
				intercomRenderer?.(
					{ role: "custom", customType: "intercom_message", content: "hi", display: true, timestamp: 1 },
					{ expanded: false, outputPad: 0, keyText: () => "", keyHint: () => "" },
					{} as never,
				)
					?.render(80)
					.map((row) => row.trimEnd()),
				["child message"],
			);
			assert.equal(childMessage.mock.calls.length, 1);
			assert.equal(parentMessage.mock.calls.length, 0);
			for (const toolName of ["other", "bash"]) {
				const unavailable = settings?.getToolDefinition?.(toolName);
				assert.notEqual(unavailable, parentTool);
				const unavailableTool = new ToolExecutionComponent(
					toolName,
					"private-child-tool",
					{ command: "PRIVATE_CHILD_ARGUMENTS" },
					{ outputPad: 0 },
					unavailable,
					makeTestTui(24),
					process.cwd(),
				);
				try {
					for (const settled of [false, true]) {
						if (settled) {
							unavailableTool.updateResult({
								content: [{ type: "text", text: "PRIVATE_CHILD_RESULT" }],
								isError: false,
							});
						}
						for (const expanded of [false, true]) {
							unavailableTool.setExpanded(expanded);
							const rendered = text(unavailableTool.render(80));
							assert.match(rendered, /Tool renderer unavailable/);
							assert.doesNotMatch(rendered, /PRIVATE_CHILD_ARGUMENTS|PRIVATE_CHILD_RESULT|parent tool/);
						}
					}
				} finally {
					unavailableTool.dispose();
				}
			}
			assert.equal(parentToolLookup.mock.calls.length, 0);
			assert.equal(settings?.getCustomMessageRenderer?.("other"), parentMessage);
		} finally {
			page.dispose();
		}
	});

	test("reads the subagent's git branch and watches it through the chat's footer data, until the page closes (#4640)", async () => {
		const watched: string[] = [];
		let released = 0;
		const data: ReadonlyFooterDataProvider = {
			...footerData,
			getGitBranch: (cwd) => `branch-of-${cwd}`,
			onBranchChange: (_callback, cwd) => {
				watched.push(String(cwd));
				return () => {
					released++;
				};
			},
		};
		const { page } = await livePage({}, { footerData: data });
		assert.ok(text(page.render(100, 20)).includes(`(branch-of-${LIVE_CWD})`));
		assert.deepEqual(watched, [LIVE_CWD]);
		page.dispose();
		assert.equal(released, 1);
	});

	test("keeps the parent chat's extension statuses out of the subagent's footer (#4640)", async () => {
		const { page } = await livePage();
		assert.doesNotMatch(text(page.render(100, 20)), /PARENT-STATUS/);
		page.dispose();
	});

	test("without footer data the subagent's footer counts its tasks and its usage meter still shows (#4640)", async () => {
		const { page } = await livePage({}, { footerData: undefined });
		const rows = plain(page.render(100, 20));
		assert.equal(taskRows(rows).length, 2);
		assert.ok(rows.some((row) => row.includes("↑1.2k")));
		page.dispose();
	});

	test("shows the working line from a turn already under way when the page opens, until the turn ends (#4640)", async () => {
		const { page, live } = await livePage({ isRunning: () => true });
		assert.ok(plain(page.render(100, 20)).some((row) => WORKING_LINE.test(row)));
		for (const listener of live.listeners) listener({ type: "agent_end", messages: [] } as AgentSessionEvent);
		assert.ok(!plain(page.render(100, 20)).some((row) => WORKING_MESSAGE.test(row)));
		assert.ok(plain(page.render(100, 20)).some((row) => WORKED_LINE.test(row)));
		page.dispose();
		const idle = await livePage({ isRunning: () => false });
		assert.ok(!plain(idle.page.render(100, 20)).some((row) => WORKING_MESSAGE.test(row)));
		idle.page.dispose();
	});

	test("a subagent chat opened while the session switches models shows the switch until the next request (#5572)", async () => {
		const phase = {
			type: "model_fallback_start",
			from: "primary",
			to: "fallback",
			reason: "not found",
			attempt: 1,
		} as const;
		const { page, live } = await livePage({
			chatSession: { ...(await liveChatSession()), retryStatus: phase },
			isRunning: () => true,
		});
		try {
			assert.match(text(page.render(100, 20)), /∀ switching model…/);
			for (const listener of live.listeners) listener({ type: "agent_start" });
			assert.doesNotMatch(text(page.render(100, 20)), /switching model…/);
		} finally {
			page.dispose();
		}
	});

	test("a chat opened while its subagent waits to retry shows `retrying…` on the usage row until the next attempt (#5483)", async () => {
		// Between attempts the session is not streaming, but its retry has started and not ended.
		const waiting = { ...(await liveChatSession()), retryAttempt: 1 } as ChatBoxSession;
		const { page, live } = await livePage({ chatSession: waiting, isRunning: () => false });
		for (const width of [80, 160]) {
			const rows = plain(page.render(width, 20)).map((row) => row.trimEnd());
			const label = rows.indexOf(labelRows(rows)[0] ?? "");
			assert.match(rows[label - 2] ?? "", /^ ∀ retrying…$/u, `${width} columns: the retry is the working line`);
			assert.match(rows[label - 1] ?? "", /\(auto\)$/u, `${width} columns: right on the usage row`);
		}
		for (const listener of live.listeners) listener({ type: "agent_start" } as AgentSessionEvent);
		const next = plain(page.render(100, 20));
		assert.ok(!next.some((row) => row.includes("retrying…")), "the next attempt clears the retry");
		assert.ok(
			next.some((row) => WORKING_LINE.test(row)),
			"the next attempt is the working line",
		);
		page.dispose();
	});

	test("a chat opened while its subagent waits to retry stops showing it when the retry ends (#5483)", async () => {
		const waiting = { ...(await liveChatSession()), retryAttempt: 1 } as ChatBoxSession;
		const { page, live } = await livePage({ chatSession: waiting, isRunning: () => false });
		assert.ok(plain(page.render(100, 20)).some((row) => row.includes("retrying…")));
		for (const listener of live.listeners) {
			listener({
				type: "auto_retry_end",
				success: false,
				attempt: 1,
				finalError: "Retry cancelled",
			} as AgentSessionEvent);
		}
		assert.ok(!plain(page.render(100, 20)).some((row) => row.includes("retrying…")));
		page.dispose();
	});

	test("a running subagent's working line counts the same tokens as its task row (#5224)", async () => {
		let tokenCount = 87_400;
		const live = { ...session("child", "subagent-worker-aabcf28b-1"), isRunning: () => true };
		const baseSource = treeSource(tree(), new Map([["child", live]]));
		const source = {
			...baseSource,
			get tasks() {
				return tree().map((task) => (task.ref.taskId === "child" ? { ...task, metrics: { tokenCount } } : task));
			},
		};
		const page = subagentPage(
			source,
			"child",
			environment({ footerData, createChat: (opts) => new ChatSessionHost(opts) }),
		);
		await page.load();
		const working = () => plain(page.render(100, 20)).find((row) => WORKING_LINE.test(row)) ?? "";
		assert.match(working().trimEnd(), / · [↑↓] 87\.4k tokens\)$/);

		for (const listener of live.listeners) {
			listener({ type: "turn_start" } as AgentSessionEvent);
			listener({
				type: "message_start",
				message: { role: "assistant", content: [] },
			} as unknown as AgentSessionEvent);
			listener({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(800) },
			} as unknown as AgentSessionEvent);
		}
		assert.match(working().trimEnd(), / · ↓ 87\.6k tokens\)$/);

		tokenCount = 12_000;
		for (const listener of live.listeners) {
			listener({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(800) }],
					usage: { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
				},
			} as unknown as AgentSessionEvent);
		}
		assert.match(working().trimEnd(), / · ↓ 12k tokens\)$/);
		page.dispose();
	});

	test("shows the messages already queued for the subagent when the page opens (#4640)", async () => {
		const { page } = await livePage({
			getQueuedMessages: () => ({ steering: ["use the fixture"], followUp: ["then run the suite"] }),
		});
		const rows = plain(page.render(100, 24));
		assert.ok(rows.some((row) => row.includes("Steering: use the fixture")));
		assert.ok(rows.some((row) => row.includes("Follow-up: then run the suite")));
		const empty = await livePage({ getQueuedMessages: () => ({ steering: [], followUp: [] }) });
		assert.ok(!plain(empty.page.render(100, 24)).some((row) => row.includes("Steering:")));
		page.dispose();
		empty.page.dispose();
	});

	test("shows no usage meter once the subagent's session is no longer live (#4640)", async () => {
		const { page } = await livePage();
		assert.ok(plain(page.render(100, 20)).some((row) => row.includes("↑1.2k")));
		const settled = subagentPage(treeSource(), "child", environment({ footerData }));
		await settled.load();
		const rows = plain(settled.render(100, 20));
		assert.ok(!rows.some((row) => row.includes("↑1.2k")));
		assert.equal(taskRows(rows).length, 2);
		page.dispose();
		settled.dispose();
	});

	test("keeps one blank row between the transcript and the composer when there is no usage meter", async () => {
		const answer = Array.from({ length: 20 }, (_, index) => `answer line ${index}`).join("\n\n");
		const settled = subagentPage(
			treeSource(tree(), new Map(), {
				readTaskTranscript: () => ({
					ok: true,
					value: {
						messages: [
							{ role: "user", content: "transcript of child", timestamp: 1 },
							{
								role: "assistant",
								content: [{ type: "text", text: answer }],
								api: "openai-responses",
								provider: "faux",
								model: "worker-model",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "stop",
								timestamp: 2,
							},
						],
					},
				}),
			}),
			"child",
			environment({ footerData }),
		);
		await settled.load();
		const rows = plain(settled.render(80, 16));
		// Either rule glyph, so the test checks the row above the rule, not which glyph the rule draws.
		const label = rows.findIndex((row) => /^[─━]+ agent-child · .+ [─━]$/u.test(row));
		assert.ok(label > 2, "the composer's labelled top rule is painted");
		assert.equal(rows[label - 1]?.trim(), "", "one blank row sits on the composer's top rule");
		assert.equal(rows[label - 2]?.trim(), "answer line 19", "the transcript ends right above that row");
		settled.dispose();
	});
});

describe("/tasks in a subagent's chat (#4640)", () => {
	test("lists the subagent's own shells and the subagents it launched, not its parent's (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		assert.equal(page.handlesBack(), false);
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		assert.equal(page.handlesBack(), true);
		assert.equal(
			page.chat.statusText(),
			"",
			"the subagent's view does not report that task inspection is unavailable",
		);
		const list = text(page.render(80, 24));
		assert.match(list, /title-child-shell/);
		assert.match(list, /title-grandchild(?!-)/);
		assert.doesNotMatch(list, /title-parent-shell|title-grandchild-shell/);
		assert.equal(page.chat.inputText(), "", "/tasks is not left in the composer or sent to the subagent");
		page.dispose();
	});

	test("the subagent's open list takes the chat box's rows, with its footer under it (#4640)", async () => {
		let renders = 0;
		const page = subagentPage(treeSource(), "child", environment(), () => {
			renders++;
		});
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		const rows = plain(page.render(80, 24));
		assert.equal(rows.length, 24);
		assert.deepEqual(labelRows(rows), [], "the composer is hidden while the list is open");
		assert.equal(taskRows(rows).length, 2);
		assert.ok(
			rows.some((row) => /esc\/← close/.test(row)),
			"the list's hint sits above the footer rows",
		);
		const [only, ...rest] = plain(page.render(80, 1));
		assert.deepEqual(rest, []);
		assert.doesNotMatch(only ?? "", /^ {2}∀ /, "one row goes to the list, not the footer");
		const before = renders;
		page.handleInput("\x1b[B");
		assert.ok(renders > before, "a key on the list repaints");
		page.dispose();
	});

	test("/tasks with a task id selects that task of the subagent, whose own page has no chat footer (#4640)", async () => {
		for (const [command, selected] of [
			["/tasks", "title-grandchild"],
			["/tasks child-shell", "title-child-shell"],
			["/tasks  child-shell", "title-child-shell"],
		] as const) {
			const page = subagentPage(treeSource());
			await page.load();
			await type(page, command);
			page.handleInput(ENTER);
			await flush();
			const list = plain(page.render(80, 24));
			assert.match(list.find((row) => row.includes(" ❯ ")) ?? "", new RegExp(` ❯ . \\S+ +${selected}\\b`));
			page.handleInput(SPACE);
			page.handleInput(ENTER);
			await flush();
			const detail = plain(page.render(80, 24));
			assert.match(detail.join("\n"), new RegExp(`› ${selected}\\b`));
			assert.doesNotMatch(detail.at(-1) ?? "", /^Tasks |Stryker/, "a task's own page has no chat footer");
			page.dispose();
		}
	});

	test("Escape on the subagent's list returns to its chat, and Left or Escape on a task returns to the list (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		page.handleInput(SPACE);
		page.handleInput(ENTER);
		await flush();
		assert.match(text(page.render(80, 24)), /title-child-shell|title-grandchild/);
		assert.doesNotMatch(text(page.render(80, 24)), /^ Tasks\b/m, "a task's detail page replaced the list");
		page.handleInput(LEFT);
		assert.match(text(page.render(80, 24)), /^ Tasks\b/m);
		page.handleInput(SPACE);
		page.handleInput(ENTER);
		page.handleInput(ESCAPE);
		assert.match(text(page.render(80, 24)), /^ Tasks\b/m);
		page.handleInput(ESCAPE);
		assert.equal(page.handlesBack(), false);
		const chat = text(page.render(80, 24));
		assert.doesNotMatch(chat, /^ Tasks\b/m);
		assert.match(chat, /agent-child · title-child/);
		page.dispose();
	});

	test("in a nested subagent lists that subagent's own tasks, and back returns to it (#4640)", async () => {
		const page = subagentPage(treeSource());
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		select(page, () => page.render(80, 24), /title-grandchild(?!-)/);
		page.handleInput(ENTER);
		await flush();
		page.handleInput(ENTER);
		await flush();
		assert.match(text(page.render(80, 24)), /Transcript · agent-grandchild[\s\S]*transcript of grandchild/);
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		const nested = text(page.render(80, 24));
		assert.match(nested, /title-grandchild-shell/);
		assert.doesNotMatch(nested, /title-child-shell|title-parent-shell/);
		page.handleInput(ESCAPE);
		const grandchildChat = text(page.render(80, 24));
		assert.match(grandchildChat, /agent-grandchild · title-grandchild/);
		assert.match(grandchildChat, /transcript of grandchild/);
		assert.equal(page.handlesBack(), true, "the child's own task pages are still open");
		page.dispose();
	});

	test("keeps the subagent's list open while its session publishes events (#4640)", async () => {
		const live = session("child", "subagent-worker-aabcf28b-1");
		const page = subagentPage(treeSource(tree(), new Map([["child", live]])));
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		assert.equal(live.listeners.size, 1);
		for (const listener of live.listeners) listener({ type: "agent_start" } as AgentSessionEvent);
		assert.equal(page.handlesBack(), true);
		assert.match(text(page.render(80, 24)), /title-child-shell/);
		page.dispose();
	});

	test("keeps Ctrl+O and the host's thinking key while the subagent's list is open (#4640)", async () => {
		let expanded = false;
		const page = subagentPage(
			treeSource(),
			"child",
			environment({
				getToolsExpanded: () => expanded,
				setToolsExpanded: (value) => {
					expanded = value;
				},
			}),
		);
		await page.load();
		await type(page, "/tasks");
		page.handleInput(ENTER);
		await flush();
		assert.equal(page.handleInput("\x0f"), true);
		assert.equal(expanded, true);
		assert.equal(page.handleInput("\x14"), false);
		assert.equal(page.handlesBack(), true);
		page.dispose();
	});

	test("the task pages leave a subagent's chat only once its own list is closed (#4640)", async () => {
		const root = treeSource();
		let environmentForInspector: TaskTranscriptEnvironment | undefined;
		const inspector = new TaskInspector(
			root,
			() => {},
			() => {},
			undefined,
			() => environmentForInspector,
		);
		environmentForInspector = environment();
		const all = text(inspector.renderViewport(80, 24));
		for (const id of ["parent-shell", "child", "child-shell", "grandchild", "grandchild-shell"])
			assert.match(all, new RegExp(`title-${id}\\b`), "the main session's /tasks lists every task");
		select(inspector, () => inspector.renderViewport(80, 24), /title-child(?!-)/);
		inspector.handleInput(ENTER);
		await flush();
		inspector.handleInput(ENTER);
		await flush();
		assert.match(text(inspector.renderViewport(80, 24)), /Transcript · agent-child(?!-)/);
		for (const back of [LEFT, ESCAPE]) {
			await type(inspector, "/tasks");
			inspector.handleInput(ENTER);
			await flush();
			assert.match(text(inspector.renderViewport(80, 24)), /^ Tasks\b/m);
			inspector.handleInput(back);
			const chat = text(inspector.renderViewport(80, 24));
			assert.match(chat, /Transcript · agent-child(?!-)/, "the key closed the subagent's list, not its chat");
			assert.match(chat, /agent-child · title-child/);
			assert.doesNotMatch(chat, /^ Tasks\b/m);
		}
		inspector.handleInput(ESCAPE);
		assert.match(text(inspector.renderViewport(80, 24)), /Transcript ·/, "Esc never leaves the chat (#5224)");
		inspector.handleInput(LEFT);
		assert.doesNotMatch(text(inspector.renderViewport(80, 24)), /Transcript ·/);
		inspector.dispose();
	});

	test("shell output pages never take back keys (#4640)", () => {
		const page = new TaskCommandOutputPage(
			treeSource(),
			"child-shell" as TaskId,
			() => 0n,
			undefined,
			() => {},
		);
		assert.equal(page.handlesBack(), false);
		page.dispose();
	});
});

describe("a subagent's task view (#4640)", () => {
	test("shows the tasks the subagent launched, read from its parent's view (#4640)", async () => {
		const root = treeSource();
		const child = launchedTaskViewSource(root, "child" as TaskId);
		const ids = (tasks: readonly TaskRecord[]) => tasks.map((task) => task.ref.taskId);
		assert.deepEqual(ids(child.tasks), ["child-shell", "grandchild"]);
		assert.deepEqual(ids(child.backgroundTasks), ["child-shell", "grandchild"]);
		assert.equal(child.settlementOrder, root.settlementOrder);
		const page = await child.readTaskOutput("child-shell" as TaskId, { start: "0", maximumBytes: 10 });
		assert.deepEqual(page, { ok: true, value: { text: "output of child-shell", omitted: false } });
		assert.equal(launchedTaskViewSource(root, "child" as TaskId), child, "one view per task keeps an open list");
		const grandchild = launchedTaskViewSource(child, "grandchild" as TaskId);
		assert.equal(grandchild, launchedTaskViewSource(root, "grandchild" as TaskId));
		assert.deepEqual(ids(grandchild.tasks), ["grandchild-shell"]);
		assert.notEqual(launchedTaskViewSource(treeSource(), "child" as TaskId), child);
	});

	test("filters background tasks and the live task list separately, as they change (#4640)", () => {
		const tasks = tree();
		const background = tasks.filter((task) => task.ref.taskId !== "child-shell");
		const root = treeSource(tasks, new Map(), { backgroundTasks: background });
		const child = launchedTaskViewSource(root, "child" as TaskId);
		assert.deepEqual(
			child.backgroundTasks.map((task) => task.ref.taskId),
			["grandchild"],
		);
		tasks.push(record("child-late", "command", "child"));
		assert.deepEqual(
			child.tasks.map((task) => task.ref.taskId),
			["child-shell", "grandchild", "child-late"],
		);
	});

	test("forwards every task action to its parent's view (#4640)", async () => {
		const calls: string[] = [];
		const note =
			<T>(name: string, value: T) =>
			(...args: readonly unknown[]): T => {
				calls.push(`${name}:${args.map(String).join(",")}`);
				return value;
			};
		const root = treeSource(tree(), new Map(), {
			recentActivity: note("recentActivity", []),
			activityOmitted: note("activityOmitted", true),
			subscribe: note("subscribe", () => {}),
			cancelTask: note("cancelTask", Promise.resolve({ ok: true as const, value: undefined })),
			stdinAvailable: note("stdinAvailable", true),
			writeTaskInput: note("writeTaskInput", Promise.resolve({ ok: true as const, value: { acceptedBytes: 3 } })),
			taskDetailText: note("taskDetailText", { prompt: "p" }),
			readTaskTranscript: note("readTaskTranscript", { ok: false as const, error: { message: "gone" } }),
			followTaskTranscript: note("followTaskTranscript", { historyOnly: true }),
			extensionStatuses: note("extensionStatuses", new Map([["k", "v"]])),
			watchExtensionStatuses: note("watchExtensionStatuses", () => {}),
			sendTaskMessage: note("sendTaskMessage", Promise.resolve()),
		});
		const child = launchedTaskViewSource(root, "child" as TaskId);
		const id = "child-shell" as TaskId;
		assert.deepEqual(child.recentActivity(id), []);
		assert.equal(child.activityOmitted(id), true);
		const listener = () => {};
		assert.equal(typeof child.subscribe(listener), "function");
		assert.deepEqual(await child.cancelTask(id), { ok: true, value: undefined });
		assert.equal(child.stdinAvailable(id), true);
		assert.deepEqual(await child.writeTaskInput(id, "abc"), { ok: true, value: { acceptedBytes: 3 } });
		assert.deepEqual(child.taskDetailText(id), { prompt: "p" });
		assert.deepEqual(child.readTaskTranscript(id, "cursor"), { ok: false, error: { message: "gone" } });
		assert.deepEqual(child.followTaskTranscript(id), { historyOnly: true });
		assert.deepEqual([...child.extensionStatuses(id)], [["k", "v"]]);
		assert.equal(typeof child.watchExtensionStatuses(id, listener), "function");
		await child.sendTaskMessage?.(id, "hello");
		assert.deepEqual(calls, [
			"recentActivity:child-shell",
			"activityOmitted:child-shell",
			`subscribe:${String(listener)}`,
			"cancelTask:child-shell",
			"stdinAvailable:child-shell",
			"writeTaskInput:child-shell,abc",
			"taskDetailText:child-shell",
			"readTaskTranscript:child-shell,cursor",
			"followTaskTranscript:child-shell",
			"extensionStatuses:child-shell",
			`watchExtensionStatuses:child-shell,${String(listener)}`,
			"sendTaskMessage:child-shell,hello",
		]);
		const readOnly = launchedTaskViewSource(
			treeSource(tree(), new Map(), { sendTaskMessage: undefined }),
			"child" as TaskId,
		);
		assert.equal(
			readOnly.sendTaskMessage,
			undefined,
			"a parent that cannot message tasks keeps its subagents read-only",
		);
	});
});
