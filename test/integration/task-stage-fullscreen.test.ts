import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { makeTestTui } from "../support/fake-tui.js";
import {
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	makeHandle,
	StageChatView,
	setupRun,
	stripAnsi,
} from "../unit/stage-chat-view-helpers.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("workflow /tasks owns the full viewport and input until returning to stage chat", async () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture({
		kind: "workflow-stage",
		sessionId: randomUUID(),
		runId: "fullscreen-run",
		stageId: "stage-a",
		stageAttemptId: "attempt-1",
	});
	const session = fakeFooterAgentSession();
	bindOwnerTaskStore(session, fixture.store);
	const { handle } = makeHandle(undefined, [], "running", session);
	const store = createStore();
	setupRun(store, "fullscreen-run", "stage-a");
	let rows = 24;
	let closes = 0;
	const stage = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "fullscreen-run",
		stageId: "stage-a",
		workflowName: "PARENT_CHROME",
		handle,
		piTui: makeTestTui(() => rows),
		onDetach() {
			closes++;
		},
		onClose() {
			closes++;
		},
	});
	try {
		await fixture.start("Fullscreen review");
		const child = SessionManager.inMemory();
		for (let i = 0; i < 40; i++)
			await child.appendMessage({ role: "user", content: `CHILD_MESSAGE_${i}`, timestamp: i });
		fixture.runners[0].context.bindTranscript(child);
		for (const key of "/tasks") stage.handleInput(key);
		stage.handleInput("\r");
		await flush();
		assert.match(stripAnsi(stage.render(80).join("\n")), /Background tasks/);
		assert.doesNotMatch(stripAnsi(stage.render(80).join("\n")), /PARENT_CHROME/);
		stage.handleInput("\r");
		await flush();
		stage.handleInput("\r");
		await flush();
		for (const width of [24, 48, 100]) {
			rows = width === 24 ? 12 : 30;
			const frame = stage.render(width);
			assert.equal(frame.length, rows);
			assert.ok(frame.every((line) => visibleWidth(line) <= width));
			assert.match(stripAnsi(frame[0]), /^Transcript/);
			assert.doesNotMatch(stripAnsi(frame.join("\n")), /PARENT_CHROME|Workflow draft|ctrl\+x.*graph/i);
		}
		const parentScroll = stage._bodyScrollFromBottom;
		for (const key of ["z", "\x1b[<65;8;8M", "\x1b[6~", "\x1b[F"]) assert.equal(stage.handleInput(key), true);
		assert.equal(stage._inputBuffer, "");
		assert.equal(stage._bodyScrollFromBottom, parentScroll);
		assert.match(stripAnsi(stage.render(100).join("\n")), /CHILD_MESSAGE_39/);
		stage.handleInput("\x1b"); // transcript -> detail
		assert.match(stripAnsi(stage.render(100).join("\n")), /Inspect transcript/);
		stage.handleInput("\x1b"); // detail -> list
		assert.match(stripAnsi(stage.render(100).join("\n")), /Background tasks/);
		stage.handleInput("\x1b"); // list -> stage chat
		assert.match(stripAnsi(stage.render(100).join("\n")), /PARENT_CHROME/);
		assert.equal(closes, 0);
		assert.equal(fixture.store.tasks[0].execution.kind, "running");
	} finally {
		stage.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test.runIf(process.platform !== "win32")(
	"each workflow chat inspects only its own background agents and shells fullscreen",
	async () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const views = ["stage-a", "stage-b"].map((stageId) => {
			const fixture = taskFixture({
				kind: "workflow-stage",
				sessionId: randomUUID(),
				runId: "multi-chat",
				stageId,
				stageAttemptId: "attempt-1",
			});
			const session = fakeFooterAgentSession();
			bindOwnerTaskStore(session, fixture.store);
			const { handle } = makeHandle(undefined, [], "running", session);
			const store = createStore();
			setupRun(store, "multi-chat", stageId);
			const stage = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "multi-chat",
				stageId,
				workflowName: `PARENT_${stageId}`,
				handle,
				piTui: makeTestTui(24),
				initialComposerDraft: `DRAFT_${stageId}`,
				onDetach() {},
				onClose() {},
			});
			return { fixture, stage, stageId };
		});
		try {
			for (const { fixture, stageId } of views) {
				await fixture.start(`AGENT_${stageId}`);
				const shell = taskValue(
					await fixture.supervisor.startCommandTask(
						fixture.owner,
						{
							kind: "command",
							command: `printf 'OUTPUT_${stageId}\\n'; read value`,
							description: `SHELL_${stageId}`,
							terminal: { kind: "pipe" },
							executionTimeoutMs: 30000,
						},
						randomUUID() as OperationId,
					),
				);
				taskValue(await fixture.supervisor.initialObservation(shell, { kind: "background" }));
				await vi.waitFor(async () => {
					const page = taskValue(
						await fixture.supervisor.readTaskOutput(shell, { start: "0", maximumBytes: 8192 }),
					);
					assert.ok(page.chunks.some((chunk) => chunk.bytes.length > 0));
				});
				fixture.store.drain();
			}
			for (const { fixture, stage, stageId } of views) {
				const other = views.find((view) => view.stageId !== stageId)!;
				const otherFrame = other.stage.render(80);
				// Replace only this chat's draft with the explicit inspection command.
				for (let i = 0; i < `DRAFT_${stageId}`.length; i++) stage.handleInput("\x7f");
				for (const key of "/tasks") stage.handleInput(key);
				stage.handleInput("\r");
				await flush();
				const list = stripAnsi(stage.render(80).join("\n"));
				assert.match(list, new RegExp(`AGENT_${stageId}`));
				assert.match(list, new RegExp(`SHELL_${stageId}`));
				assert.doesNotMatch(list, new RegExp(`(?:AGENT|SHELL)_${other.stageId}`));
				stage.handleInput("\x1b[B"); // select the shell
				stage.handleInput("\r");
				await flush();
				stage.handleInput("\r");
				await flush();
				await vi.waitFor(() =>
					assert.match(stripAnsi(stage.render(80).join("\n")), new RegExp(`OUTPUT_${stageId}`)),
				);
				const frame = stage.render(80);
				assert.equal(frame.length, 24);
				assert.match(stripAnsi(frame[0]), /^Transcript/);
				assert.doesNotMatch(stripAnsi(frame.join("\n")), /PARENT_|DRAFT_/);
				assert.deepEqual(other.stage.render(80), otherFrame);
				stage.handleInput("\x03"); // close inspection, not execution
				assert.match(stripAnsi(stage.render(80).join("\n")), new RegExp(`PARENT_${stageId}`));
				assert.equal(fixture.store.tasks[1].execution.kind, "running");
			}
		} finally {
			for (const { stage, fixture } of views) {
				stage.dispose();
				await fixture.dispose();
			}
			setKeybindings(previous);
		}
	},
);
