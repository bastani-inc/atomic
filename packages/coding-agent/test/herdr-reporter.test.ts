import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { WorkflowRootActivity } from "../src/core/extensions/workflow-events.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { arg, fakeHerdr } from "./helpers/herdr.js";

// #2891: activation must not retain a previous session's approval wait.
test("reactivating a reporter resets prompt state and retires the previous observation lease", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();
	const publisher = runtime.workflowActivityHub.registerWorkflowActivityPublisher();
	publisher.publishSnapshot({ availability: "ready", roots: [] });
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const runner = new ExtensionRunner([extension], runtime, fake.dir, SessionManager.inMemory(), {} as never);
	runner.setUIContext({ ...noOpUIContext }, "tui");
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(1);
		await runner.emit({
			type: "ui_prompt_start",
			reason: "ui_prompt",
			kind: "confirm",
			title: "secret approval title",
		});
		await fake.waitFor(2);
		await runner.emit({ type: "session_shutdown", reason: "reload" });
		await runner.emit({ type: "session_start", reason: "reload" });
		const calls = await fake.waitFor(3);
		assert.equal(arg(calls[2].args, "--state"), "idle");
		assert.equal(
			runtime.workflowActivityHub.diagnostics().filter((item) => item.kind === "ObserverDisposed").length,
			1,
		);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

// #2891: reports follow semantic events, never prompt content or agent_end.
test("real runner reports settled, prompt, workflow and recovery transitions with parent identity", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();
	const publisher = runtime.workflowActivityHub.registerWorkflowActivityPublisher();
	const session = SessionManager.create(fake.dir, fake.dir);
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const runner = new ExtensionRunner([extension], runtime, fake.dir, session, {} as never);
	let closeNavigation!: () => void;
	const navigationClosed = new Promise<void>((resolve) => {
		closeNavigation = resolve;
	});
	runner.setUIContext(
		{
			...noOpUIContext,
			custom: async (factory, options) => {
				await navigationClosed;
				return noOpUIContext.custom(factory, options);
			},
		},
		"tui",
	);
	const root: WorkflowRootActivity = {
		rootRunId: "root",
		ownerSessionId: session.getSessionId(),
		state: "working",
		reason: "executing",
		activeExecutionCount: 1,
		actionableBlockCount: 0,
		needsAttention: false,
	};
	let completed = 0;
	async function expectReport(state: string, message?: string) {
		const calls = await fake.waitFor(++completed);
		assert.equal(arg(calls[completed - 1].args, "--state"), state);
		assert.equal(arg(calls[completed - 1].args, "--message"), message);
	}
	try {
		await runner.emit({ type: "session_start" });
		// A retained workflow viewer must not change any of the semantic reports below.
		const navigation = runner
			.getUIContext()
			.custom(() => ({ render: () => [], invalidate: () => {} }), { purpose: "navigation", overlay: true });
		await runner.emit({ type: "agent_start" });
		await expectReport("working");
		await runner.emit({ type: "agent_end", messages: [] });
		await runner.emit({ type: "agent_settled" });
		publisher.publishSnapshot({ availability: "recovering" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal((await fake.calls()).filter((call) => call.phase === "start").length, completed);
		publisher.publishSnapshot({ availability: "ready", roots: [] });
		await expectReport("idle");
		await runner.emit({
			type: "ui_prompt_start",
			reason: "ui_prompt",
			kind: "confirm",
			title: "secret prompt title and provider error body",
		});
		await expectReport("blocked", "Waiting for approval");
		publisher.publishChanged({ ...root, needsAttention: true });
		await expectReport("working", "Workflow needs attention");
		await runner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		await expectReport("working", "Workflow needs attention");
		await runner.emit({ type: "agent_settled" });
		await expectReport("working", "Workflow needs attention");
		publisher.publishChanged({
			...root,
			state: "blocked",
			reason: "manual_intervention",
			activeExecutionCount: 0,
			needsAttention: true,
		});
		await expectReport("blocked", "Workflow needs attention");
		publisher.publishChanged({ ...root, state: "idle", reason: "paused", activeExecutionCount: 0 });
		await expectReport("idle");
		publisher.publishRemoved(root.rootRunId);
		await expectReport("idle");
		await runner.emit({ type: "agent_start" });
		await expectReport("working");
		await runner.emit({ type: "agent_settled" });
		await expectReport("idle");
		closeNavigation();
		await navigation;
		await runner.flushUIPromptNotifications();
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.equal(calls.length, completed + 1);
		assert.equal(calls.at(-1)?.args[1], "release-agent");
		assert.equal(arg(calls[0].args, "--agent-session-id"), session.getSessionId());
		assert.equal(arg(calls[0].args, "--agent-session-path"), session.getSessionFile());
		assert.equal(calls.filter((call) => call.args.includes("--agent-session-id")).length, 1);
		assert.equal(JSON.stringify(calls).includes("secret prompt title and provider error body"), false);
		assert.ok(calls.every((call) => call.socket === fake.environment.socketPath));
	} finally {
		closeNavigation();
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

// #2891: new factories and engines share the host pane owner and clock high-water mark.
test("extension reload and engine replacement fence late predecessor callbacks and preserve sequence", async () => {
	const fake = await fakeHerdr();
	const runners: ExtensionRunner[] = [];
	let clock = Date.now();
	try {
		for (let generation = 0; generation < 3; generation++) {
			clock -= 1000;
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				createHerdrExtension({ env: fake.env, enabled: () => true, clock: () => clock, diagnostic: () => {} }),
				fake.dir,
				createEventBus(),
				runtime,
				"herdr",
			);
			const runner = new ExtensionRunner([extension], runtime, fake.dir, SessionManager.inMemory(), {} as never);
			runner.setUIContext({ ...noOpUIContext }, "tui");
			runners.push(runner);
			await runner.emit({ type: "session_start", reason: generation ? "reload" : "startup" });
			await runner.emit({ type: "agent_start" });
			await fake.waitFor(generation + 1);
			const previous = runners[generation - 1];
			if (previous) {
				await previous.emit({ type: "agent_start" });
				await previous.emit({ type: "session_shutdown", reason: "reload" });
				previous.invalidate();
			}
		}
		await runners[2].emit({ type: "session_shutdown", reason: "quit" });
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.deepEqual(
			calls.map((call) => call.args[1]),
			["report-agent", "report-agent", "report-agent", "release-agent"],
		);
		const seq = calls.map((call) => Number(arg(call.args, "--seq")));
		// Every admitted command, release included, takes a strictly increasing sequence across reload and replacement.
		for (let index = 1; index < seq.length; index += 1) assert.ok(seq[index]! > seq[index - 1]!);
		assert.equal(calls.filter((call) => call.args.includes("--agent-session-id")).length, 3);
	} finally {
		await runners.at(-1)?.emit({ type: "session_shutdown", reason: "quit" });
		for (const runner of runners) runner.invalidate();
		await fake.dispose();
	}
});

test("graph-only workflow activity changes do not re-report the pane (#3476)", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();
	const publisher = runtime.workflowActivityHub.registerWorkflowActivityPublisher();
	const session = SessionManager.inMemory();
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const runner = new ExtensionRunner([extension], runtime, fake.dir, session, {} as never);
	runner.setUIContext({ ...noOpUIContext }, "tui");
	const root: WorkflowRootActivity = {
		rootRunId: "root",
		ownerSessionId: session.getSessionId(),
		state: "working",
		reason: "executing",
		activeExecutionCount: 1,
		actionableBlockCount: 0,
		needsAttention: false,
	};
	const node = {
		kind: "stage",
		id: "plan",
		runId: "root",
		nodeId: "plan",
		name: "plan",
		parentIds: [],
		depth: 0,
	} as const;
	try {
		await runner.emit({ type: "session_start" });
		publisher.publishSnapshot({ availability: "ready", roots: [] });
		await fake.waitFor(1);
		publisher.publishChanged({ ...root, graph: { nodes: [{ ...node, status: "running" }] } });
		const [, working] = await fake.waitFor(2);
		assert.equal(arg(working!.args, "--state"), "working");
		publisher.publishChanged({ ...root, graph: { nodes: [{ ...node, status: "completed" }] } });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal((await fake.calls()).filter((call) => call.phase === "start").length, 2);
		publisher.publishChanged({ ...root, state: "idle", reason: "quiescent", activeExecutionCount: 0 });
		const calls = await fake.waitFor(3);
		assert.equal(arg(calls[2]!.args, "--state"), "idle");
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});
