import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { Cleanup, OperationId, TaskId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	DEFAULT_TASK_HEARTBEAT_MS,
	type TaskHeartbeatClock,
	type TaskHeartbeatDelivery,
	type TaskHeartbeatMessage,
	TaskHeartbeatMonitor,
} from "../../packages/coding-agent/src/core/tasks/heartbeat.js";
import { executeSupervisedCommand } from "../../packages/coding-agent/src/core/tools/bash-pty-native.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";

const MINUTE = 60_000;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Manual clock: the monitor's cadence timers only fire when the test advances time. */
class ManualClock implements TaskHeartbeatClock {
	private current = Date.UTC(2026, 0, 1, 9, 0, 0);
	private nextId = 0;
	private readonly timers = new Map<number, { at: number; run: () => void }>();
	/** How often the monitor has read the time; it reads it whenever it reconciles owner changes. */
	reads = 0;
	now = (): number => {
		this.reads++;
		return this.current;
	};
	setTimeout = (run: () => void, delayMs: number) => {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.current + delayMs, run });
		return { id };
	};
	clearTimeout = (handle: object): void => {
		this.timers.delete((handle as { id: number }).id);
	};
	get pending(): number {
		return this.timers.size;
	}
	/** Fire every timer due up to `ms` from now, in time order, letting async work settle between fires. */
	async advance(ms: number): Promise<void> {
		const target = this.current + ms;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at);
			const first = due[0];
			if (!first) break;
			this.timers.delete(first[0]);
			this.current = Math.max(this.current, first[1].at);
			first[1].run();
			await settle();
		}
		this.current = target;
	}
}

async function settle(): Promise<void> {
	for (let index = 0; index < 20; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

type Harness = {
	host: AgentTaskHost;
	clock: ManualClock;
	delivered: TaskHeartbeatMessage[];
	delivery: TaskHeartbeatDelivery & { unread: boolean; intervalMs: number; observed: number };
	monitor: TaskHeartbeatMonitor;
	/** Releases every fake runner's cleanup, so closing the owner never waits on one. */
	releases: Array<() => void>;
};

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		harness.monitor.dispose();
		for (const release of harness.releases) release();
		await harness.host.close("session-close");
	}
});

function harness(intervalMs = DEFAULT_TASK_HEARTBEAT_MS): Harness {
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId: randomUUID() }, authorizeLaunch() {} });
	const clock = new ManualClock();
	const delivered: TaskHeartbeatMessage[] = [];
	const delivery = {
		unread: false,
		intervalMs,
		/** The monitor asks for the owner default exactly once, when it first sees a task without its own cadence. */
		observed: 0,
		defaultIntervalMs() {
			this.observed++;
			return this.intervalMs;
		},
		hasUnreadHeartbeat() {
			return this.unread;
		},
		async deliver(message: TaskHeartbeatMessage) {
			delivered.push(message);
		},
	};
	const { supervisor, owner } = host.ownerBinding;
	const monitor = new TaskHeartbeatMonitor({ supervisor, owner, delivery: () => delivery, clock });
	monitor.start();
	const created = { host, clock, delivered, delivery, monitor, releases: [] };
	harnesses.push(created);
	return created;
}

type RunningAgent = {
	taskId: TaskId;
	/** Report a tool action and wait until the monitor has reconciled it at the current clock time. */
	report: (tool: string, text: string) => Promise<void>;
	finish: () => Promise<void>;
};

/** Start an agent task; one without its own cadence is returned once the monitor has seen it running. */
async function startAgent(
	target: Harness,
	options: {
		task?: string;
		heartbeatMs?: number;
		agent?: string;
		/** The child's session history; entries already present when its runner binds it count as inherited. */
		transcript?: object[];
	} = {},
): Promise<RunningAgent> {
	const observedBefore = target.delivery.observed;
	const result = deferred<TaskResult>();
	const cleanup = deferred<Cleanup>();
	let reportActivity: ((tool: string, text: string) => void) | undefined;
	let sequence = 0;
	const started = await target.host.startAgentTask(
		{
			kind: "agent",
			agent: options.agent ?? "worker",
			task: options.task ?? "Implement the parser",
			...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
		},
		randomUUID() as OperationId,
		(context) => {
			const transcript = options.transcript;
			if (transcript)
				context.bindTranscript({ getSessionId: () => "child-session", getEntries: () => [...transcript] as never });
			reportActivity = (tool, text) => {
				context.reportActivity({ reportId: `action-${++sequence}`, change: { kind: "action", tool, text } });
			};
			return { result: result.promise, cleanup: cleanup.promise };
		},
	);
	assert.ok(started.ok);
	target.releases.push(() => cleanup.resolve({ kind: "reaped" }));
	await target.host.observeAgentLaunch(started.value.taskId, { kind: "background" });
	const taskId = started.value.taskId;
	if (options.heartbeatMs === undefined)
		await vi.waitFor(() => assert.ok(target.delivery.observed > observedBefore, "monitor saw the task running"), {
			timeout: 5000,
		});
	return {
		taskId,
		report: async (tool, text) => {
			const before = target.clock.reads;
			reportActivity?.(tool, text);
			await vi.waitFor(() => assert.ok(target.clock.reads > before, "monitor reconciled the report"), {
				timeout: 5000,
			});
		},
		finish: async () => {
			result.resolve({
				kind: "completed",
				output: {
					ownerId: "owner" as never,
					taskId,
					artifactId: `output:${taskId}`,
					byteCount: "0",
					omittedRanges: [],
				},
			});
			cleanup.resolve({ kind: "reaped" });
			await target.host.waitForTask(taskId);
		},
	};
}

/** The monitor observes running tasks through its own owner subscription; wait until it has armed a cadence timer. */
async function untilArmed(target: Harness, timers = 1): Promise<void> {
	await vi.waitFor(() => assert.ok(target.clock.pending >= timers, "monitor armed its heartbeat timer"), {
		timeout: 5000,
	});
}

test("a running subagent heartbeats into its owner on the default 15-minute cadence", async () => {
	const target = harness();
	const agent = await startAgent(target, { task: "Implement the parser" });
	await untilArmed(target);

	await target.clock.advance(15 * MINUTE - 1);
	assert.equal(target.delivered.length, 0, "no heartbeat before the first boundary");

	await target.clock.advance(1);
	assert.equal(target.delivered.length, 1);
	const [message] = target.delivered;
	assert.equal(message?.customType, "task-heartbeat");
	assert.equal(message?.display, true);
	assert.match(
		message?.content ?? "",
		new RegExp(
			`^♥ Task heartbeat \\(subagent ${agent.taskId}: Implement the parser\\) — still running after 15m, on a 15-minute cadence\\.`,
		),
	);
	assert.match(message?.content ?? "", /periodic check/);
	assert.match(message?.content ?? "", /Do not relaunch/);

	await target.clock.advance(15 * MINUTE);
	assert.equal(target.delivered.length, 2, "the cadence repeats while the task keeps running");
	assert.match(target.delivered[1]?.content ?? "", /still running after 30m, on a 15-minute cadence/);
	await agent.finish();
});

function mentions(messages: readonly TaskHeartbeatMessage[], taskId: string): number {
	return messages.filter((message) => message.details.tasks.some((task) => task.taskId === taskId)).length;
}

test("a per-launch heartbeatMs overrides the owner default, and 0 disables that task's heartbeats", async () => {
	const target = harness();
	const fast = await startAgent(target, { task: "Fast cadence", heartbeatMs: 2 * MINUTE });
	const silent = await startAgent(target, { task: "No heartbeats", heartbeatMs: 0 });
	await untilArmed(target);

	await target.clock.advance(2 * MINUTE);
	assert.equal(target.delivered.length, 1);
	assert.deepEqual(
		target.delivered[0]?.details.tasks.map((task) => task.taskId),
		[fast.taskId],
	);
	assert.match(target.delivered[0]?.content ?? "", /still running after 2m, on a 2-minute cadence/);

	await target.clock.advance(60 * MINUTE);
	assert.equal(mentions(target.delivered, fast.taskId), 31, "every 2-minute boundary for an hour");
	assert.equal(mentions(target.delivered, silent.taskId), 0, "heartbeatMs 0 never heartbeats");
	await fast.finish();
	await silent.finish();
});

test("the owner default cadence applies to tasks launched without heartbeatMs", async () => {
	const target = harness(5 * MINUTE);
	const agent = await startAgent(target);
	await untilArmed(target);
	await target.clock.advance(5 * MINUTE);
	assert.equal(mentions(target.delivered, agent.taskId), 1);
	assert.match(target.delivered[0]?.content ?? "", /on a 5-minute cadence/);
	await agent.finish();
});

test("heartbeats stop when a task completes or is stopped, leaving no timer behind", async () => {
	const target = harness();
	const finished = await startAgent(target, { task: "Finishes" });
	const stopped = await startAgent(target, { task: "Stopped" });
	await untilArmed(target);
	await target.clock.advance(15 * MINUTE);
	assert.equal(target.delivered.length, 1, "both tasks share the first notice");
	assert.equal(target.delivered[0]?.details.tasks.length, 2);

	await finished.finish();
	assert.ok((await target.host.cancelTask(stopped.taskId, "quit")).ok);
	await vi.waitFor(() => assert.equal(target.clock.pending, 0, "nothing left to wake for"), { timeout: 5000 });
	await target.clock.advance(60 * MINUTE);
	assert.equal(target.delivered.length, 1, "no heartbeat after completion or stop");
	await stopped.finish();
});

test("boundaries within a minute of each other share one notice instead of arriving back to back", async () => {
	const target = harness();
	const first = await startAgent(target, { task: "First" });
	await untilArmed(target);
	await target.clock.advance(30_000);
	const second = await startAgent(target, { task: "Thirty seconds later" });
	await target.clock.advance(15 * MINUTE - 30_000);
	assert.equal(target.delivered.length, 1);
	assert.deepEqual(
		new Set(target.delivered[0]?.details.tasks.map((task) => task.taskId)),
		new Set([first.taskId, second.taskId]),
	);
	await target.clock.advance(15 * MINUTE);
	assert.equal(target.delivered.length, 2, "still one notice per tick on the next boundary");
	assert.equal(target.delivered[1]?.details.tasks.length, 2);
	await first.finish();
	await second.finish();
});

test("tasks due together share one notice that names at most eight in full", async () => {
	const target = harness();
	const agents: RunningAgent[] = [];
	for (let index = 0; index < 12; index++) agents.push(await startAgent(target, { task: `Batch task ${index}` }));
	await untilArmed(target);
	await target.clock.advance(15 * MINUTE);
	assert.equal(target.delivered.length, 1, "one notice for every task due at once");
	const [message] = target.delivered;
	assert.equal(message?.details.tasks.length, 8);
	assert.equal(message?.details.moreCount, 4);
	assert.equal(message?.details.more.length, 4);
	assert.equal((message?.content.match(/^♥ Task heartbeat/gm) ?? []).length, 8);
	assert.match(message?.content ?? "", /Also still running: .*Inspect them with \/tasks\./);
	const named = new Set([
		...(message?.details.tasks.map((task) => task.taskId) ?? []),
		...(message?.details.more.map((task) => task.taskId) ?? []),
	]);
	assert.deepEqual(new Set(agents.map((agent) => agent.taskId)), named);
	for (const agent of agents) await agent.finish();
});

test("an unread heartbeat holds later ones, and owed tasks arrive together without replaying missed boundaries", async () => {
	const target = harness();
	const first = await startAgent(target, { task: "First" });
	await untilArmed(target);
	await target.clock.advance(5 * MINUTE);
	const second = await startAgent(target, { task: "Second" });

	await target.clock.advance(10 * MINUTE);
	assert.equal(target.delivered.length, 1, "first task heartbeats at 15m");
	target.delivery.unread = true;

	// Both tasks pass several boundaries while the owner has not read the notice.
	await target.clock.advance(45 * MINUTE);
	assert.equal(target.delivered.length, 1, "nothing stacks behind an unread notice");

	target.delivery.unread = false;
	await target.clock.advance(30_000);
	assert.equal(target.delivered.length, 2, "owed tasks arrive once the previous notice is read");
	assert.deepEqual(
		new Set(target.delivered[1]?.details.tasks.map((task) => task.taskId)),
		new Set([first.taskId, second.taskId]),
	);

	// Each task resumes at its own next boundary rather than replaying the missed ones.
	await target.clock.advance(4 * MINUTE + 30_000);
	assert.equal(target.delivered.length, 3, "the second task's next boundary is 65m");
	assert.deepEqual(
		target.delivered[2]?.details.tasks.map((task) => task.taskId),
		[second.taskId],
	);
	await target.clock.advance(10 * MINUTE);
	assert.equal(target.delivered.length, 4, "the first task's next boundary is 75m");
	assert.deepEqual(
		target.delivered[3]?.details.tasks.map((task) => task.taskId),
		[first.taskId],
	);
	await first.finish();
	await second.finish();
});

function assistantToolCall(name: string): object {
	return {
		type: "message",
		id: `assistant-${name}`,
		message: { role: "assistant", content: [{ type: "toolCall", id: `call-${name}`, name, arguments: {} }] },
	};
}

function toolResult(name: string): object {
	return {
		type: "message",
		id: `result-${name}`,
		message: { role: "toolResult", toolCallId: `call-${name}`, toolName: name, content: [] },
	};
}

test("a subagent heartbeat reports the tool it is running and how long ago it was last active", async () => {
	const target = harness();
	const transcript: object[] = [];
	const agent = await startAgent(target, { task: "Long investigation", agent: "codebase-analyzer", transcript });
	await untilArmed(target);
	await target.clock.advance(3 * MINUTE);
	transcript.push(assistantToolCall("bash"));
	await agent.report("bash", "npm test -- --watch=false");
	await target.clock.advance(12 * MINUTE);
	const [message] = target.delivered;
	assert.ok(message);
	assert.match(
		message.content,
		/Status: agent codebase-analyzer · elapsed 15m · last activity 12m ago · running bash: npm test -- --watch=false · 1 turn/,
	);
	await agent.finish();
});

test("a subagent whose last tool call has finished reports it as its last tool, not a running one", async () => {
	const target = harness();
	const transcript: object[] = [];
	const agent = await startAgent(target, { task: "Waiting on the model", transcript });
	await untilArmed(target);
	transcript.push(assistantToolCall("bash"), toolResult("bash"));
	await agent.report("bash", "npm test");
	await target.clock.advance(15 * MINUTE);
	const content = target.delivered[0]?.content ?? "";
	assert.match(content, /last tool bash: npm test/);
	assert.doesNotMatch(content, /running bash/);
	await agent.finish();
});

/** Advance in steps, waiting after each for the monitor to re-arm: shell checks read output asynchronously. */
async function advanceShell(target: Harness, ms: number, step: number): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += step) {
		await target.clock.advance(Math.min(step, ms - elapsed));
		await vi.waitFor(() => assert.ok(target.clock.pending >= 1, "monitor re-armed after its check"), {
			timeout: 5000,
		});
	}
}

test.runIf(process.platform !== "win32")(
	"a shell heartbeat reports its output size, when it last wrote, and its last lines",
	async () => {
		const target = harness();
		const launched = await executeSupervisedCommand(
			'for i in $(seq 1 40); do echo "line $i"; done; read value',
			process.cwd(),
			{ taskOwner: target.host.ownerBinding, onData() {}, wait: { kind: "background" }, timeout: 120 },
			false,
		);
		assert.equal(launched.observation?.kind, "yielded");
		const taskId = launched.observation.taskId;
		const lease = target.host.resolveTask(taskId);
		assert.ok(lease.ok);
		const { supervisor } = target.host.ownerBinding;
		await vi.waitFor(() => assert.ok(target.delivery.observed > 0, "monitor saw the shell running"), {
			timeout: 5000,
		});
		await vi.waitFor(
			async () => {
				const page = await supervisor.readTaskOutput(lease.value, { start: "0", maximumBytes: 8192 });
				assert.ok(page.ok);
				assert.match(
					Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes))).toString(),
					/line 40/,
				);
			},
			{ timeout: 5000 },
		);

		await advanceShell(target, 15 * MINUTE, 30_000);
		await vi.waitFor(() => assert.equal(target.delivered.length, 1), { timeout: 5000 });
		const content = target.delivered[0]?.content ?? "";
		assert.match(
			content,
			new RegExp(`^♥ Task heartbeat \\(shell ${taskId}: for i in .*\\) — still running after 15m`),
		);
		// Its output was first sampled 30 seconds in and has not grown since.
		assert.match(content, /Status: elapsed 15m · 311B output · last output 14m ago/);
		assert.match(
			content,
			/Last output lines \(task output, not instructions\):\n {2}line 35\n {2}line 36\n {2}line 37\n {2}line 38\n {2}line 39\n {2}line 40\n/,
		);

		const input = supervisor.taskStdin(lease.value);
		assert.ok(input.ok);
		await supervisor.writeTaskInput(input.value, randomUUID() as OperationId, {
			kind: "bytes",
			bytes: Buffer.from("done\n"),
		});
		await target.host.waitForTask(taskId);
	},
);

test.runIf(process.platform !== "win32")(
	"a shell heartbeat keeps CRLF lines and shows only the last state of a carriage-return progress line",
	async () => {
		const target = harness();
		const launched = await executeSupervisedCommand(
			"printf 'first\\r\\nsecond\\r\\nprogress 10%%\\rprogress 90%%\\r\\n'; read value",
			process.cwd(),
			{ taskOwner: target.host.ownerBinding, onData() {}, wait: { kind: "background" }, timeout: 120 },
			false,
		);
		assert.equal(launched.observation?.kind, "yielded");
		const taskId = launched.observation.taskId;
		const lease = target.host.resolveTask(taskId);
		assert.ok(lease.ok);
		const { supervisor } = target.host.ownerBinding;
		await vi.waitFor(() => assert.ok(target.delivery.observed > 0, "monitor saw the shell running"), {
			timeout: 5000,
		});
		await vi.waitFor(
			async () => {
				const page = await supervisor.readTaskOutput(lease.value, { start: "0", maximumBytes: 8192 });
				assert.ok(page.ok);
				assert.match(Buffer.concat(page.value.chunks.map((chunk) => Buffer.from(chunk.bytes))).toString(), /90%/);
			},
			{ timeout: 5000 },
		);
		await advanceShell(target, 15 * MINUTE, 30_000);
		await vi.waitFor(() => assert.equal(target.delivered.length, 1), { timeout: 5000 });
		assert.deepEqual(target.delivered[0]?.details.tasks[0]?.output?.tail, ["first", "second", "progress 90%"]);

		const input = supervisor.taskStdin(lease.value);
		assert.ok(input.ok);
		await supervisor.writeTaskInput(input.value, randomUUID() as OperationId, {
			kind: "bytes",
			bytes: Buffer.from("done\n"),
		});
		await target.host.waitForTask(taskId);
	},
);

test("a workflow stage's tasks heartbeat through its current session after replacement, and stop when the stage pauses", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const boundary = new WorkflowStageAdmissionBoundary();
	boundary.bindTaskIdentity(randomUUID(), "run", "stage");
	const sessionDelivery = () => {
		const delivered: TaskHeartbeatMessage[] = [];
		const delivery: TaskHeartbeatDelivery = {
			defaultIntervalMs: () => MINUTE,
			hasUnreadHeartbeat: () => false,
			async deliver(message) {
				delivered.push(message);
			},
		};
		return { delivered, delivery };
	};
	const original = sessionDelivery();
	const replacement = sessionDelivery();
	try {
		const host = boundary.bindAgentTaskHost({ authorizeLaunch() {}, heartbeat: original.delivery });
		const cleanup = deferred<Cleanup>();
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Stage-owned work" },
			randomUUID() as OperationId,
			() => ({ result: new Promise<TaskResult>(() => {}), cleanup: cleanup.promise }),
		);
		assert.ok(started.ok);
		assert.equal(boundary.bindAgentTaskHost({ authorizeLaunch() {}, heartbeat: replacement.delivery }), host);

		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await vi.waitFor(() => assert.equal(replacement.delivered.length, 1), { timeout: 5000 });
		assert.equal(original.delivered.length, 0, "one monitor per owner, delivering to the current session");

		const pausing = host.pauseTasks();
		cleanup.resolve({ kind: "reaped" });
		await pausing;
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		assert.equal(replacement.delivered.length, 1, "paused stage tasks do not heartbeat");
	} finally {
		vi.useRealTimers();
		await boundary.close();
	}
});
