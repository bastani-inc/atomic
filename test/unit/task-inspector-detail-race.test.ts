import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type OwnerLease,
	type TaskLease,
	TaskSupervisor,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";

type OutputResult = Awaited<ReturnType<TaskSupervisor["readTaskOutput"]>>;
const output: OutputResult = {
	ok: true,
	value: {
		requested: { start: "0", end: "5" },
		chunks: [{ offsets: { start: "0", end: "5" }, bytes: Buffer.from("stale") }],
		omittedRanges: [],
	},
};

async function withInspector(
	check: (
		inspector: TaskInspector,
		finish: (result: OutputResult) => void,
		fail: () => void,
		render: ReturnType<typeof vi.fn>,
	) => Promise<void>,
) {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const supervisor = new TaskSupervisor();
	const store = new OwnerTaskStore(supervisor, {} as OwnerLease);
	const tasks = [taskRecord("second", "command"), taskRecord("first", "command")];
	for (const task of tasks)
		task.execution = { kind: "settled", result: { kind: "failed", code: "fixture", message: "done" } };
	vi.spyOn(store, "tasks", "get").mockReturnValue(tasks);
	vi.spyOn(store, "resolveTask").mockReturnValue({ ok: true, value: {} as TaskLease });
	let finish!: (value: OutputResult) => void;
	let fail!: () => void;
	vi.spyOn(supervisor, "readTaskOutput")
		.mockImplementationOnce(
			() =>
				new Promise((resolve, reject) => {
					finish = resolve;
					fail = () => reject(new Error("stale failure"));
				}),
		)
		.mockResolvedValue({ ok: false, error: { code: "UnknownTask", message: "unavailable" } });
	const render = vi.fn();
	const inspector = new TaskInspector(store, render, () => {});
	try {
		inspector.handleInput("\r");
		await check(inspector, finish, fail, render);
	} finally {
		inspector.dispose();
		vi.restoreAllMocks();
		setKeybindings(previous);
	}
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const text = (inspector: TaskInspector) => inspector.renderViewport(100, 100).map(stripVTControlCharacters).join("\n");

// #2908: delayed command reads must not replace another task's detail.
test("inspector discards command output after selection changes", async () => {
	await withInspector(async (inspector, finish) => {
		inspector.handleInput("\u001b");
		inspector.handleInput("\u001b[B");
		inspector.handleInput("\r");
		finish(output);
		await settle();
		assert.ok(text(inspector).includes("Task second"));
		assert.ok(!text(inspector).includes("stale"));
	});
});

// #2908: focus and lifecycle changes invalidate both success and failure callbacks.
for (const transition of ["back", "reinspect", "dispose", "transcript"] as const) {
	for (const outcome of ["success", "rejection", "error-result"] as const) {
		test(`inspector ignores ${outcome} after ${transition}`, async () => {
			await withInspector(async (inspector, finish, fail, render) => {
				if (transition === "dispose") inspector.dispose();
				else if (transition === "transcript") inspector.handleInput("\r");
				else {
					inspector.handleInput("\u001b");
					if (transition === "reinspect") inspector.handleInput("\r");
				}
				await settle();
				render.mockClear();
				if (outcome === "rejection") fail();
				else
					finish(
						outcome === "success"
							? output
							: { ok: false, error: { code: "OutputUnavailable", message: "stale failure" } },
					);
				await settle();
				assert.equal(render.mock.calls.length, 0);
				assert.ok(!text(inspector).includes("stale"));
			});
		});
	}
}

// #2908: current requests still show output and contain read failures.
test("inspector renders current output", async () => {
	await withInspector(async (inspector, finish) => {
		finish(output);
		await settle();
		assert.ok(text(inspector).includes("stale"));
	});
});
test("inspector reports current read rejection without an unhandled promise", async () => {
	await withInspector(async (inspector, _finish, fail) => {
		fail();
		await settle();
		assert.ok(text(inspector).includes("Command output unavailable"));
	});
});

test("store updates do not replace a pending shell transcript with a detail refresh", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const supervisor = new TaskSupervisor();
	const store = new OwnerTaskStore(supervisor, {} as OwnerLease);
	vi.spyOn(store, "tasks", "get").mockReturnValue([taskRecord("shell", "command")]);
	vi.spyOn(store, "resolveTask").mockReturnValue({ ok: true, value: {} as TaskLease });
	vi.spyOn(supervisor, "taskStdin").mockReturnValue({
		ok: false,
		error: { code: "StdinClosed", message: "No input" },
	});
	let notify = () => {};
	vi.spyOn(store, "subscribe").mockImplementation((listener) => {
		notify = listener;
		return () => {};
	});
	const pending = Promise.withResolvers<OutputResult>();
	const read = vi
		.spyOn(supervisor, "readTaskOutput")
		.mockResolvedValueOnce(output)
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValue(output);
	const inspector = new TaskInspector(
		store,
		() => {},
		() => {},
	);
	try {
		inspector.handleInput("\r");
		await settle();
		inspector.handleInput("\r");
		notify();
		assert.equal(read.mock.calls.length, 2, "no third detail read while transcript is pending");
		pending.resolve(output);
		await settle();
		assert.match(text(inspector), /Retained shell output/);
		assert.equal(read.mock.calls.length, 3, "pending state updates trigger one follow-up transcript read");
		assert.doesNotMatch(text(inspector), /› Inspect transcript/);
	} finally {
		inspector.dispose();
		vi.restoreAllMocks();
		setKeybindings(previous);
	}
});
