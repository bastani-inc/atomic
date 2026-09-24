import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
	FooterDataProvider,
	type ReadonlyFooterDataProvider,
} from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import {
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	makeHandle,
	makePendingPrompt,
	makeTestTui,
	StageChatView,
	setupRun,
	stripAnsi,
	submitStageChatText,
} from "./stage-chat-view-helpers.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("workflow compact picker retains exact owner context through empty, live and completed navigation", async () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const tasks = taskFixture();
	const session = fakeFooterAgentSession();
	session.state.model!.id = "gpt-6-astra";
	session.state.thinkingLevel = "medium";
	session.sessionManager.getCwd = () => join(process.env.HOME!, "Documents/projects/atomic");
	bindOwnerTaskStore(session, tasks.store);
	const statuses = new Map([["mcp", "MCP: 0/1 servers"]]);
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 2,
		onBranchChange: () => () => {},
	};
	const store = createStore();
	setupRun(store, "picker-run", "stage-a");
	const { handle, state } = makeHandle(undefined, [], "running", session);
	let rows = 30;
	let renders = 0;
	const stage = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "picker-run",
		stageId: "stage-a",
		workflowName: "hidden parent chrome",
		handle,
		footerData,
		piTui: makeTestTui(() => rows),
		requestRender: () => renders++,
		onDetach() {},
		onClose() {},
	});
	const render = () => stripAnsi(stage.render(120).join("\n"));
	// PR #2926: preserve the full context assertion with the platform's native separators.
	const context = `(openai-codex) gpt-6-astra medium • ${join("~", "Documents/projects/atomic")} (main)`;
	try {
		submitStageChatText(stage, "/tasks");
		await flush();
		const empty = render();
		assert.ok(empty.includes(context), empty);
		assert.ok(empty.includes("MCP: 0/1 servers"), empty);
		assert.match(empty, /Background tasks[\s\S]*0 active · 0 total/);
		assert.match(empty, /Background agents and shells will appear here\./);
		assert.doesNotMatch(empty, /hidden parent chrome|Main chat needs input — exit graph to answer\./);
		Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
		assert.ok(render().includes(context), "streaming owner must retain identity during task navigation");
		assert.doesNotMatch(render(), /esc to interrupt/i);
		Object.defineProperty(session, "isStreaming", { value: false, configurable: true });
		await tasks.start("First owner task");
		await tasks.start("Second owner task");
		taskValue(
			tasks.runners[1].context.reportActivity({
				reportId: "resolved-model",
				change: { kind: "model", model: "provider/resolved", thinking: "low" },
			}),
		);
		tasks.store.drain();
		assert.match(render(), /provider\/resolved.*thinking low/);
		stage.handleInput("\x1b[A");
		assert.match(render(), /Second owner task/);
		stage.handleInput("\r");
		await flush();
		assert.match(render(), /Second owner task/);
		assert.doesNotMatch(render(), /MCP:|gpt-6-astra|hidden parent chrome/);
		stage.handleInput("\x1b");
		assert.ok(render().includes(context));
		const before = renders;
		await tasks.settle(0);
		assert.ok(renders > before, "settlement invalidates the open picker");
		assert.match(render(), /1 active.*2 total/);
		stage.handleInput("\r");
		await flush();
		assert.match(render(), /Second owner task/, "back and settlement preserve selection");
		stage.handleInput("\x1b");
		for (const key of ["ordinary text", "\x1b[<65;8;8M", "\x14", "\x0f"]) stage.handleInput(key);
		assert.equal(stage._inputBuffer, "");
		assert.deepEqual(state.promptCalls, []);
		assert.deepEqual(state.steerCalls, []);
		const prompt = makePendingPrompt({ kind: "confirm", message: "Genuine stage approval" });
		assert.equal(store.recordStagePendingPrompt("picker-run", "stage-a", prompt), true);
		assert.match(render(), /Background tasks/, "prompt arrival must not reinterpret task navigation keys");
		for (const [width, height] of [
			[31, 9],
			[12, 3],
			[1, 1],
		]) {
			rows = height;
			const frame = stage.render(width);
			assert.equal(frame.length, rows);
			assert.ok(frame.every((line) => visibleWidth(line) <= width));
		}
		rows = 30;
		stage.handleInput("\x1b");
		assert.match(render(), /Genuine stage approval/, "leaving tasks exposes the original stage prompt");
		stage.handleInput("\r");
		assert.equal(store.runs()[0].stages[0].pendingPrompt, undefined);
		assert.deepEqual(state.promptCalls, []);
	} finally {
		stage.dispose();
		await tasks.dispose();
		setKeybindings(previous);
	}
});

test("shared task context resolves and watches the stage cwd branch without changing main context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "task-context-"));
	const mainCwd = join(directory, "main");
	const stageCwd = join(directory, "stage");
	const mainHead = join(mainCwd, ".git/HEAD");
	const stageHead = join(stageCwd, ".git/HEAD");
	await writeFileEnsuringDir(mainHead, "ref: refs/heads/main\n");
	await writeFileEnsuringDir(stageHead, "ref: refs/heads/stage-branch\n");
	const provider = new FooterDataProvider(mainCwd);
	provider.setExtensionStatus("mcp", "MCP: 0/1 servers");
	provider.startGitWatcher();
	const session = fakeFooterAgentSession();
	session.sessionManager.getCwd = () => stageCwd;
	const footer = new FooterComponent(session, provider);
	let changes = 0;
	provider.onBranchChange(() => changes++);
	try {
		assert.match(stripAnsi(footer.render(160).join("\n")), /stage \(stage-branch\)/);
		assert.equal(provider.getGitBranch(), "main");
		assert.match(stripAnsi(footer.render(160).join("\n")), /MCP: 0\/1 servers/);
		// Fresh directories may precede macOS watcher readiness. Keep publishing the
		// same branch until the subscribed provider observes it, without polling Git.
		const branchWatchSettlementMs = 5000;
		await vi.waitFor(
			async () => {
				await writeFileEnsuringDir(stageHead, "ref: refs/heads/stage-updated\n");
				assert.ok(changes > 0);
				assert.match(stripAnsi(footer.render(160).join("\n")), /stage \(stage-updated\)/);
			},
			{ timeout: branchWatchSettlementMs },
		);
		assert.equal(provider.getGitBranch(), "main");
	} finally {
		footer.dispose();
		provider.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
