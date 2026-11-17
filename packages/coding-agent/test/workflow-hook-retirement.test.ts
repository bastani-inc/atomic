import assert from "node:assert/strict";
import { test } from "vitest";
import { setCallbackActivityReporter } from "../src/core/callback-activity.js";
import { createEventBus } from "../src/core/event-bus.js";
import type { ExtensionAPI } from "../src/core/extensions/index.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { WorkflowActivityPublisher, WorkflowEvent } from "../src/core/extensions/workflow-events.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const hooks = [
	"workflow_lifecycle",
	"workflow_activity_changed",
	"workflow_stage_completed",
	"workflow_heartbeat",
] as const;

function onWorkflowEvent(pi: ExtensionAPI, handler: (event: WorkflowEvent) => void | Promise<void>): void {
	pi.on("workflow_lifecycle", handler);
	pi.on("workflow_activity_changed", handler);
	pi.on("workflow_stage_completed", handler);
	pi.on("workflow_heartbeat", handler);
}

function publish(publisher: WorkflowActivityPublisher, hook: WorkflowEvent["type"]): void {
	if (hook === "workflow_activity_changed") {
		publisher.publishChanged({
			rootRunId: "root",
			ownerSessionId: "owner",
			state: "idle",
			reason: "quiescent",
			activeExecutionCount: 0,
			actionableBlockCount: 0,
			needsAttention: false,
		});
	} else if (hook === "workflow_heartbeat") {
		publisher.publishHeartbeat({
			type: hook,
			runId: "run",
			rootRunId: "root",
			ownerSessionId: "owner",
			scheduledAt: 0,
			intervalMinutes: 0,
		});
	} else {
		publisher.publishLifecycle({
			type: "workflow_lifecycle",
			eventId: "completed",
			runId: "run",
			rootRunId: "root",
			ownerSessionId: "owner",
			occurredAt: 0,
			observedAt: 0,
			delivery: "live",
			target: { kind: "stage", runId: "run", stageId: "stage", stageName: "stage", status: "completed" },
		});
	}
}

// #2891: retirement during an awaited hook fences every callback that has not started.
for (const hook of hooks) {
	for (const retirement of ["runner invalidation", "publisher disposal", "publisher replacement"] as const) {
		for (const location of ["same extension", "next extension"] as const) {
			test(`${hook} fences the ${location} after ${retirement} during a handler`, async () => {
				const runtime = createExtensionRuntime();
				const bus = createEventBus();
				let api!: ExtensionAPI;
				let release!: () => void;
				const pending = new Promise<void>((resolve) => {
					release = resolve;
				});
				const calls: string[] = [];
				const later = (event: WorkflowEvent) => {
					if (event.type === hook) calls.push("later started");
				};
				const first = await loadExtensionFromFactory(
					(pi) => {
						api = pi;
						onWorkflowEvent(pi, async (event) => {
							if (event.type !== hook) return;
							calls.push("first started");
							await pending;
							calls.push("first finished");
						});
						if (location === "same extension") onWorkflowEvent(pi, later);
					},
					process.cwd(),
					bus,
					runtime,
					"<first>",
				);
				const second = await loadExtensionFromFactory(
					(pi) => {
						if (location === "next extension") onWorkflowEvent(pi, later);
					},
					process.cwd(),
					bus,
					runtime,
					"<second>",
				);
				const runner = new ExtensionRunner([first, second], runtime, process.cwd(), {} as never, {} as never);
				let publisher = api.registerWorkflowActivityPublisher();
				try {
					publish(publisher, hook);
					await flush();
					assert.deepEqual(calls, ["first started"]);
					if (retirement === "runner invalidation") runner.invalidate();
					else if (retirement === "publisher disposal") publisher.dispose();
					else publisher = api.registerWorkflowActivityPublisher();
					release();
					await flush();
					assert.deepEqual(calls, ["first started", "first finished"]);

					if (retirement !== "runner invalidation") {
						if (retirement === "publisher disposal") publisher = api.registerWorkflowActivityPublisher();
						calls.length = 0;
						publish(publisher, hook);
						await flush();
						assert.deepEqual(calls, ["first started", "first finished", "later started"]);
					}
				} finally {
					release();
					runner.invalidate();
				}
			});
		}
	}
}

// #2891: activity reporting yields before entering the callback, after dispatch starts.
test("publisher retirement during the callback reporting yield fences the hook", async () => {
	const runtime = createExtensionRuntime();
	let api!: ExtensionAPI;
	const calls: string[] = [];
	const extension = await loadExtensionFromFactory(
		(pi) => {
			api = pi;
			pi.on("workflow_heartbeat", () => {
				calls.push("hook started");
			});
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"<reporting-yield>",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);
	setCallbackActivityReporter({
		started: () => {
			calls.push("reporting started");
		},
		finished: () => calls.push("reporting finished"),
	});
	try {
		const publisher = api.registerWorkflowActivityPublisher();
		publish(publisher, "workflow_heartbeat");
		await Promise.resolve();
		assert.deepEqual(calls, []);
		publisher.dispose();
		await flush();
		assert.deepEqual(calls, ["reporting started", "reporting finished"]);
	} finally {
		setCallbackActivityReporter(undefined);
		runner.invalidate();
	}
});

// #2891: the publisher fence must not change unrelated shutdown-handler delivery.
test("non-workflow shutdown handlers keep their existing delivery after an awaited handler", async () => {
	const runtime = createExtensionRuntime();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const extension = await loadExtensionFromFactory(
		(pi) => {
			pi.on("session_shutdown", async () => {
				calls.push("first started");
				await pending;
				calls.push("first finished");
			});
			pi.on("session_shutdown", () => {
				calls.push("later started");
			});
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"<shutdown>",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);
	const delivery = runner.emit({ type: "session_shutdown", reason: "reload" });
	assert.deepEqual(calls, ["first started"]);
	runner.invalidate();
	release();
	await delivery;
	assert.deepEqual(calls, ["first started", "first finished", "later started"]);
});
