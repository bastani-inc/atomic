import assert from "node:assert/strict";
import { bindOwnerTaskStore, ChatSessionHost, InteractiveMode } from "@bastani/atomic";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type TaskCompletionEnvelope,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import { TaskList } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import {
	disposeInteractiveTasks,
	refreshInteractiveTasks,
} from "../../packages/coding-agent/src/modes/interactive/interactive-task-projection.js";
import { ProgramStatusReporter } from "../../packages/coding-agent/src/modes/interactive/program-status-reporter.js";
import { getMarkdownTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { makeTestTui } from "../support/fake-tui.js";
import { editorTheme, plainStyle } from "../unit/chat-session-host-working-lifecycle-fixture.js";
import {
	type AgentSessionEvent,
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	makeHandle,
	makePendingPrompt,
	StageChatView,
	setupRun,
	stripAnsi,
} from "../unit/stage-chat-view-helpers.js";

setKeybindings(new KeybindingsManager());

// RFC #2884: both real host components consume the same native task trace after turn end.
test("both chats retain the same task through tool end, agent end, background action and settlement", async () => {
	const fixture = taskFixture();
	const session = fakeFooterAgentSession();
	bindOwnerTaskStore(session, fixture.store);
	session.getToolDefinition = () => undefined;
	let expanded = false;
	const main = new ChatSessionHost({
		style: plainStyle,
		taskRowsInChat: false,
		editorTheme,
		getAgentSession: () => session,
		getChatRenderSettings: () => ({ toolOutputExpanded: expanded }),
	});
	const { handle, emit } = makeHandle(undefined, [], "running", session);
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const stage = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "S4",
		handle,
		initialComposerDraft: "Workflow draft",
		piTui: makeTestTui(100),
		getToolsExpanded: () => expanded,
		setToolsExpanded: (value) => {
			expanded = value;
		},
		onDetach() {},
		onClose() {},
	});
	const taskLines = (text: string) =>
		stripAnsi(text)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("Tasks "))
			.map((line) => line.slice(0, line.indexOf("/tasks") + 6));
	const assertParity = () => {
		assert.deepEqual(taskLines(main.renderFooter(80).join("\n")), taskLines(stage.render(80).join("\n")));
		assert.equal(main.entries().filter((entry) => entry.kind === "task").length, 0);
		assert.doesNotMatch(stripAnsi(stage.render(80).join("\n")), /worker:/);
	};
	try {
		await fixture.start();
		assertParity();
		const screen = stripAnsi(stage.render(80).join("\n"));
		assert.ok(
			screen.indexOf("Workflow draft") >= 0 && screen.indexOf("Workflow draft") < screen.indexOf("Tasks  "),
			"workflow background count stays below the composer",
		);
		for (const event of [
			{ type: "tool_execution_start", toolCallId: "launch", toolName: "subagent", args: {} },
			{
				type: "tool_execution_end",
				toolCallId: "launch",
				toolName: "subagent",
				result: { content: [{ type: "text", text: "admitted" }], details: {} },
				isError: false,
			},
			{ type: "agent_end", messages: [] },
		] as AgentSessionEvent[]) {
			main.applyAgentEvent(event);
			emit(event);
			assertParity();
		}
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "after-turn",
				change: { kind: "action", tool: "read", text: "live background output" },
			}),
		);
		fixture.store.drain();
		assertParity();
		assert.doesNotMatch(stripAnsi(stage.render(80).join("\n")), /live background output/);
		await fixture.settle();
		assertParity();
		const task = fixture.store.tasks[0];
		assert.equal(task.execution.kind, "settled");
		const envelope = {
			completionId: "fixture-completion",
			ownerId: task.ref.ownerId,
			taskId: task.ref.taskId,
			terminalSequence: fixture.store.cursor?.sequence,
			result: task.execution.kind === "settled" ? task.execution.result : undefined,
			display: false,
		};
		const entryCount = main.entries().length;
		const beforeMain = main.renderBody(80, 100);
		const beforeStage = stage.render(80);
		const hidden: AgentSessionEvent = {
			type: "message_start",
			message: {
				role: "custom",
				customType: "task-completion",
				display: false,
				content: JSON.stringify(envelope),
				details: envelope,
				timestamp: 0,
			},
		};
		main.applyAgentEvent(hidden);
		emit(hidden);
		main.applyAgentEvent({ type: "message_end", message: hidden.message });
		emit({ type: "message_end", message: hidden.message });
		assert.equal(main.entries().length, entryCount);
		assert.deepEqual(main.renderBody(80, 100), beforeMain);
		assert.deepEqual(stage.render(80), beforeStage);
		const genuine: AgentSessionEvent = {
			type: "message_start",
			message: {
				role: "custom",
				customType: "intercom",
				display: true,
				content: "Genuine peer message",
				timestamp: 0,
			},
		};
		main.applyAgentEvent(genuine);
		emit(genuine);
		assert.equal((stripAnsi(stage.render(80).join("\n")).match(/Genuine peer message/g) ?? []).length, 1);
		main.applyAgentEvent({ type: "message_end", message: genuine.message });
		emit({ type: "message_end", message: genuine.message });
		assert.equal((stripAnsi(main.renderBody(80, 100).join("\n")).match(/Genuine peer message/g) ?? []).length, 1);
		assertParity();
		expanded = true;
		assertParity();
		assert.doesNotMatch(main.renderFooter(80).join("\n"), /Tasks {2}/);
		const completedEnvelope: TaskCompletionEnvelope = {
			...envelope,
			terminalSequence: fixture.store.cursor!.sequence,
			result: task.execution.kind === "settled" ? task.execution.result : { kind: "cancelled", cause: "user" },
			display: false,
		};
		const visible: AgentSessionEvent = {
			type: "message_start",
			message: {
				role: "custom",
				customType: "task-completion",
				content: "Internal model context must not appear in the notification",
				details: {
					...completedEnvelope,
					notification: taskCompletionNotice(completedEnvelope, task, "Review finished successfully."),
				},
				display: true,
				timestamp: 1,
			},
		};
		for (const type of ["message_start", "message_end"] as const) {
			main.applyAgentEvent({ type, message: visible.message });
			emit({ type, message: visible.message });
		}
		for (const output of [main.renderBody(80, 100).join("\n"), stage.render(80).join("\n")]) {
			assert.equal((stripAnsi(output).match(/Subagent worker completed/g) ?? []).length, 1);
			assert.match(stripAnsi(output), /Review finished successfully/);
			assert.doesNotMatch(output, /Internal model context|"completionId"/);
		}
	} finally {
		main.dispose();
		stage.dispose();
		await fixture.dispose();
	}
});

// RFC #2884: execute the actual main CLI mounting path, including a lazy S3-style bind.
test("main CLI projection mounts once on a late binding and shares complete row content", async () => {
	const fixture = taskFixture();
	const mode = { session: {}, chatContainer: new Container(), toolOutputExpanded: false, ui: { requestRender() {} } };
	refreshInteractiveTasks(mode);
	try {
		await fixture.start("late binding");
		assert.equal(mode.chatContainer.children.length, 0);
		bindOwnerTaskStore(mode.session, fixture.store);
		const anchor = mode.chatContainer.children[0];
		for (let index = 0; index < 3; index++) {
			taskValue(
				fixture.runners[0].context.reportActivity({
					reportId: `cli-${index}`,
					change: { kind: "action", tool: "read", text: `action ${index}` },
				}),
			);
			fixture.store.drain();
			refreshInteractiveTasks(mode);
			assert.equal(mode.chatContainer.children.length, 1);
			assert.equal(mode.chatContainer.children[0], anchor);
			assert.deepEqual(mode.chatContainer.render(80), new TaskList(fixture.store.tasks).render(80));
		}
		await fixture.settle();
		assert.deepEqual(mode.chatContainer.render(80), new TaskList(fixture.store.tasks).render(80));
		mode.toolOutputExpanded = true;
		assert.match(mode.chatContainer.render(80).join("\n"), /action 0[\s\S]*action 1[\s\S]*action 2/);
	} finally {
		disposeInteractiveTasks(mode);
		await fixture.dispose();
	}
});

// RFC #2884: footer allocation survives both scrolling and a mounted stage question.
test("six task anchors stay complete behind a bounded viewport and mounted prompt footer", async () => {
	const fixture = taskFixture();
	const session = fakeFooterAgentSession();
	let renders = 0;
	const main = new ChatSessionHost({
		style: plainStyle,
		editorTheme,
		getAgentSession: () => session,
		requestRender: () => {
			renders++;
		},
	});
	const { handle, emit } = makeHandle(undefined, [], "running", session);
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const stage = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "S4",
		handle,
		piTui: makeTestTui(24),
		onDetach() {},
		onClose() {},
	});
	try {
		assert.doesNotMatch(stage.render(80).join("\n"), /Tasks /);
		bindOwnerTaskStore(session, fixture.store);
		for (let index = 0; index < 6; index++) await fixture.start(`task-${index}`);
		assert.ok(renders > 0);
		assert.equal(main.entries().filter((entry) => entry.kind === "task").length, 6);
		const all = main.renderBody(80, 100).join("\n");
		assert.equal((stripAnsi(all).match(/∀ worker:/g) ?? []).length, 6);
		assert.equal(main.renderBody(80, 5).length, 5);
		const entries = main.entries().filter((entry) => entry.kind === "task");
		main.handleScrollInput("\x1b[1;5H");
		const top = stripAnsi(main.renderBody(80, 5).join("\n"));
		assert.match(top, /task-0/);
		taskValue(
			fixture.runners[5].context.reportActivity({
				reportId: "offscreen",
				change: { kind: "action", tool: "read", text: "new output below viewport" },
			}),
		);
		fixture.store.drain();
		assert.match(stripAnsi(main.renderBody(40, 5).join("\n")), /task-0/);
		assert.deepEqual(
			main.entries().filter((entry) => entry.kind === "task"),
			entries,
		);
		const event: AgentSessionEvent = {
			type: "message_start",
			message: {
				role: "custom",
				customType: "intercom",
				display: true,
				content: "later message\n".repeat(30),
				timestamp: 0,
			},
		};
		main.applyAgentEvent(event);
		emit(event);
		main.scrollToBottom();
		assert.doesNotMatch(main.renderBody(80, 5).join("\n"), /worker:/);
		assert.match(main.renderFooter(80).join("\n"), /Tasks {2}6 local agents running/);
		const mounted = stage.render(80);
		assert.equal(mounted.length, 24);
		assert.doesNotMatch(mounted.join("\n"), /worker:/);
		assert.match(stripAnsi(mounted.join("\n")), /Tasks {2}6 local agents running/);
		assert.equal(
			store.recordStagePendingPrompt(
				"run-1",
				"stage-a",
				makePendingPrompt({ kind: "input", message: "Answer this stage question" }),
			),
			true,
		);
		const prompt = stage.render(80);
		assert.equal(prompt.length, 24);
		assert.match(stripAnsi(prompt.join("\n")), /Answer this stage question/);
		assert.match(stripAnsi(prompt.join("\n")), /Tasks {2}6 local agents running/);
	} finally {
		main.dispose();
		stage.dispose();
		await fixture.dispose();
	}
});

// RFC #2884: the real main-chat lifecycle handler must allocate nothing for S3 completion.
test("main lifecycle handler filters the full completion envelope before component allocation", async () => {
	const harness = await createHarness();
	const fixture = taskFixture();
	const mode = {
		session: harness.session,
		chatContainer: new Container(),
		toolOutputExpanded: false,
		ui: { requestRender() {} },
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: new ProgramStatusReporter(
			() => ({ setProgramStatus() {} }) as never,
			() => undefined,
		),
		settingsManager: harness.settingsManager,
		getMarkdownTransformers: () => [],
		getMarkdownThemeWithSettings: getMarkdownTheme,
		addMessageToChat(message: AgentMessage) {
			Reflect.apply(InteractiveMode.prototype.addMessageToChat, mode, [message]);
		},
	};
	const kinds = (container: Container): string[] =>
		container.children.flatMap((child) => [
			child.constructor.name,
			...(child instanceof Container ? kinds(child) : []),
		]);
	try {
		bindOwnerTaskStore(harness.session, fixture.store);
		refreshInteractiveTasks(mode);
		await fixture.start();
		await fixture.settle();
		const task = fixture.store.tasks[0];
		assert.equal(task.execution.kind, "settled");
		const envelope = {
			completionId: "s3-envelope",
			ownerId: task.ref.ownerId,
			taskId: task.ref.taskId,
			terminalSequence: fixture.store.cursor?.sequence,
			result: task.execution.kind === "settled" ? task.execution.result : undefined,
			display: false,
		};
		const hidden = {
			role: "custom" as const,
			customType: "task-completion",
			display: false,
			content: JSON.stringify(envelope),
			details: envelope,
			timestamp: 0,
		};
		const before = kinds(mode.chatContainer);
		const beforeLines = mode.chatContainer.render(80);
		for (const type of ["message_start", "message_end"] as const)
			await Reflect.apply(InteractiveMode.prototype.handleEvent, mode, [{ type, message: hidden }]);
		assert.deepEqual(kinds(mode.chatContainer), before, "no Component, Spacer or Box allocated");
		assert.deepEqual(mode.chatContainer.render(80), beforeLines);
		const genuine = {
			role: "custom" as const,
			customType: "intercom",
			display: true,
			content: "A genuine main-chat peer message",
			timestamp: 0,
		};
		for (const type of ["message_start", "message_end"] as const)
			await Reflect.apply(InteractiveMode.prototype.handleEvent, mode, [{ type, message: genuine }]);
		assert.equal(
			(stripAnsi(mode.chatContainer.render(80).join("\n")).match(/A genuine main-chat peer message/g) ?? []).length,
			1,
		);
	} finally {
		disposeInteractiveTasks(mode);
		await fixture.dispose();
		harness.cleanup();
	}
});

// #2907: replacement transcript clears must not lose an already-bound task.
test("main projection remounts after transcript clear", async () => {
	const fixture = taskFixture();
	const mode = {
		session: {},
		chatContainer: new Container(),
		toolOutputExpanded: false,
		ui: { requestRender() {} },
		attachStartupNoticesContainer() {},
		sessionManager: { getEntries: () => [], getLeafId: () => null },
		settingsManager: { isProjectTrusted: () => true },
		renderSessionEntries() {},
	};
	try {
		bindOwnerTaskStore(mode.session, fixture.store);
		await fixture.start("replacement task");
		refreshInteractiveTasks(mode);
		mode.chatContainer.clear();
		Reflect.apply(InteractiveMode.prototype.renderInitialMessages, mode, []);
		assert.equal(mode.chatContainer.children.length, 1);
		assert.match(mode.chatContainer.render(80).join("\n"), /replacement task/);
		mode.session = {};
		refreshInteractiveTasks(mode);
		assert.equal(mode.chatContainer.children.length, 0);
		await fixture.start("old owner update");
		assert.equal(mode.chatContainer.children.length, 0);
	} finally {
		disposeInteractiveTasks(mode);
		await fixture.dispose();
	}
});

// #2907: a late-bound replacement session must not inherit the old owner's projection.
test("shared host clears old tasks before a replacement store binds", async () => {
	const old = taskFixture();
	const replacement = taskFixture();
	let session = fakeFooterAgentSession();
	bindOwnerTaskStore(session, old.store);
	const host = new ChatSessionHost({ style: plainStyle, editorTheme, getAgentSession: () => session });
	try {
		await old.start("OLD SESSION TASK");
		assert.match(host.renderBody(80, 100).join("\n"), /OLD SESSION TASK/);
		session = fakeFooterAgentSession();
		host.refreshTaskStore();
		assert.equal(host.entries().filter((entry) => entry.kind === "task").length, 0);
		assert.doesNotMatch(host.renderTaskFooter(80).join("\n"), /Tasks/);
		await old.start("STALE UPDATE");
		assert.equal(host.entries().filter((entry) => entry.kind === "task").length, 0);
		await replacement.start("NEW SESSION TASK");
		bindOwnerTaskStore(session, replacement.store);
		assert.equal(host.entries().filter((entry) => entry.kind === "task").length, 1);
		assert.match(host.renderBody(80, 100).join("\n"), /NEW SESSION TASK/);
		assert.doesNotMatch(host.renderBody(80, 100).join("\n"), /OLD SESSION TASK|STALE UPDATE/);
	} finally {
		host.dispose();
		await old.dispose();
		await replacement.dispose();
	}
});
