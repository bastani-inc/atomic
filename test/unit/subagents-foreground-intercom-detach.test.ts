import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import type { SingleResult, TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
import {
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
} from "../../packages/subagents/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

function agentConfig(): AgentConfig {
	return {
		name: "fake-worker",
		description: "Fake worker",
		source: "project",
		filePath: "fake-worker.md",
		systemPrompt: "Work.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		model: "provider-a/stalled",
		fallbackModels: ["provider-b/working"],
	};
}

function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(join(tmpdir(), "atomic-subagent-detach-"));
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function eventBus(emitter: EventEmitter) {
	return {
		on(channel: string, handler: (data: unknown) => void) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, data: unknown) {
			emitter.emit(channel, data);
		},
	};
}

async function handoff(
	bus: ReturnType<typeof eventBus>,
	route: { requestId: string; childIntercomTarget: string; runtimeGeneration?: number },
): Promise<void> {
	const complete = { messageId: route.requestId, senderId: "child-id", runtimeGeneration: 1, ...route };
	bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...complete, phase: "probe" });
	await sleep(1);
	bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...complete, phase: "commit" });
}

const bridgedAgent = () => ({ ...agentConfig(), systemPrompt: "Intercom orchestration channel:\nCoordinate." });

describe("foreground intercom detach routing", () => {
	test("reports the eventual result exactly once and finalizes artifacts after detach", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const recovered: SingleResult[] = [];
			let resolveRecovery: () => void = () => undefined;
			const recovery = new Promise<void>((resolve) => {
				resolveRecovery = resolve;
			});
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "recover",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: eventBus(emitter),
				artifactsDir: dir,
				testSession: { output: "detached result", promptGate: gate.promise },
				onDetachedExit: (result) => {
					recovered.push(result);
					resolveRecovery();
				},
			});
			await sleep(25);
			await handoff(eventBus(emitter), { requestId: "q", childIntercomTarget: "child-a" });
			const continued = await pending;
			assert.equal(continued.status, "continued");
			assert.equal(continued.detached, true);
			gate.release();
			await recovery;
			assert.equal(recovered.length, 1);
			const actual = recovered[0]!;
			assert.equal(actual.status, "ok");
			assert.match(actual.finalOutput ?? "", /detached result/);
			const actualArtifacts = actual.artifactPaths;
			assert.ok(actualArtifacts);
			assert.match(fs.readFileSync(actualArtifacts.outputPath, "utf8"), /detached result/);
			const metadata = JSON.parse(fs.readFileSync(actualArtifacts.metadataPath, "utf8")) as { status: string };
			assert.equal(metadata.status, "ok");
		});
	});

	test("a detached child that later succeeds still writes its requested output file (#3294)", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const outputPath = join(dir, "findings.md");
			let recoveredResult: (result: SingleResult) => void = () => undefined;
			const recovery = new Promise<SingleResult>((resolve) => {
				recoveredResult = resolve;
			});
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "recover-output",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: eventBus(emitter),
				outputPath,
				outputMode: "file-only",
				testSession: { output: "detached findings", promptGate: gate.promise },
				onDetachedExit: (result) => recoveredResult(result),
			});
			await sleep(25);
			await handoff(eventBus(emitter), { requestId: "q", childIntercomTarget: "child-a" });
			assert.equal((await pending).detached, true);
			gate.release();
			const recovered = await recovery;
			assert.equal(recovered.status, "ok");
			assert.equal(fs.readFileSync(outputPath, "utf8"), "detached findings");
			assert.equal(recovered.savedOutputPath, outputPath);
			assert.match(recovered.finalOutput ?? "", /Output saved to: .*findings\.md/);
		});
	});

	test("a broker-routed handoff detaches the exact child even before tool-start observation", async () => {
		await withTempDir(async (dir) => {
			const firstGate = deferred();
			const secondGate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const first = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "run",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: bus,
				testSession: { output: "eventual result", promptGate: firstGate.promise },
			});
			const second = runSync(dir, [bridgedAgent()], "fake-worker", "B", {
				cwd: dir,
				runId: "run",
				index: 1,
				intercomSessionName: "child-b",
				allowIntercomDetach: true,
				intercomEvents: bus,
				testSession: { output: "other result", promptGate: secondGate.promise },
			});
			let acknowledged = 0;
			emitter.on(INTERCOM_DETACH_RESPONSE_EVENT, () => acknowledged++);
			await sleep(25);
			const route = {
				requestId: "q1",
				messageId: "q1",
				childIntercomTarget: "child-a",
				senderId: "child-id",
				runtimeGeneration: 1,
			};
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "probe" });
			await sleep(10);
			assert.equal(acknowledged, 1);
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
			const a = await first;
			assert.equal(a.status, "continued");
			assert.equal(a.detached, true);
			firstGate.release();
			secondGate.release();
			const b = await second;
			assert.equal(b.status, "ok");
			assert.equal(b.detached, undefined);
		});
	});

	test("lifecycle cancellation still terminates a detached child and cleans listeners once", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const controller = new AbortController();
			const recovered: SingleResult[] = [];
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "cancel-detached",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: bus,
				signal: controller.signal,
				testSession: { output: "too late", promptGate: gate.promise },
				onDetachedExit: (result) => recovered.push(result),
			});
			await sleep(25);
			await handoff(bus, { requestId: "q", childIntercomTarget: "child-a" });
			assert.equal((await pending).status, "continued");
			controller.abort();
			gate.release();
			for (let i = 0; i < 30 && recovered.length === 0; i++) await sleep(20);
			assert.equal(recovered.length, 1);
			assert.equal(recovered[0]?.status, "interrupted");
			assert.equal(recovered[0]?.cause, "abort");
			assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
		});
	});

	test("abort before detach terminates normally and leaves no detach listener", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const controller = new AbortController();
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "cancel-before",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: eventBus(emitter),
				signal: controller.signal,
				testSession: { output: "too late", promptGate: gate.promise },
			});
			await sleep(25);
			controller.abort();
			gate.release();
			const result = await pending;
			assert.equal(result.status, "interrupted");
			assert.equal(result.cause, "abort");
			assert.equal(result.detached, undefined);
			assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
		});
	});

	test("a parallel detach commit releases active sibling supervision while retaining both children", async () => {
		await withTempDir(async (dir) => {
			const firstGate = deferred();
			const secondGate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const groupDetach = new AbortController();
			const recovered: SingleResult[] = [];
			const recoveredBoth = Promise.withResolvers<void>();
			const launch = (index: number, target: string, gate: ReturnType<typeof deferred>) =>
				runSync(dir, [bridgedAgent()], "fake-worker", target, {
					cwd: dir,
					runId: "parallel-detach",
					index,
					intercomSessionName: target,
					allowIntercomDetach: true,
					intercomEvents: bus,
					intercomDetachSignal: groupDetach.signal,
					onIntercomDetachCommit: () => groupDetach.abort(),
					testSession: { output: "parallel child recovered", promptGate: gate.promise },
					onDetachedExit: (result) => {
						recovered.push(result);
						if (recovered.length === 2) recoveredBoth.resolve();
					},
				});
			const first = launch(0, "child-a", firstGate);
			const sibling = launch(1, "child-b", secondGate);
			await sleep(25);
			await handoff(bus, { requestId: "parallel-question", childIntercomTarget: "child-a" });
			const placeholders = await Promise.all([first, sibling]);
			assert.ok(placeholders.every((result) => result.status === "continued"));
			assert.ok(placeholders.every((result) => result.detached === true));
			firstGate.release();
			secondGate.release();
			await recoveredBoth.promise;
			assert.equal(recovered.length, 2);
			assert.ok(recovered.every((result) => result.status === "ok"));
		});
	});

	test("background-style execution ignores targeted detach requests", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "background",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: false,
				intercomEvents: bus,
				testSession: { output: "background result", promptGate: gate.promise },
			});
			await sleep(20);
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, {
				phase: "commit",
				requestId: "q",
				childIntercomTarget: "child-a",
			});
			gate.release();
			const result = await pending;
			assert.equal(result.status, "ok");
			assert.equal(result.detached, undefined);
			assert.match(result.finalOutput ?? "", /background result/);
			assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
		});
	});

	test("duplicate targeted delivery detaches and recovers the child only once", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const recovered: SingleResult[] = [];
			const recoveredExit = Promise.withResolvers<void>();
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "duplicate",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: bus,
				testSession: { output: "once", promptGate: gate.promise },
				onDetachedExit: (result) => {
					recovered.push(result);
					recoveredExit.resolve();
				},
			});
			await sleep(20);
			const request = {
				requestId: "same",
				messageId: "same",
				senderId: "child-id",
				childIntercomTarget: "child-a",
				runtimeGeneration: 4,
			};
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "probe" });
			await sleep(1);
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "commit" });
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "commit" });
			assert.equal((await pending).status, "continued");
			gate.release();
			await recoveredExit.promise;
			await sleep(0);
			assert.equal(recovered.length, 1);
			assert.equal(recovered[0]?.status, "ok");
			assert.match(recovered[0]?.finalOutput ?? "", /once/);
			assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
		});
	});

	test("rejects commit without a matching probe and rejects generation reuse", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "reserved",
				index: 0,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: bus,
				testSession: { output: "normal", promptGate: gate.promise },
			});
			await sleep(20);
			const route = { requestId: "q", messageId: "q", senderId: "child-id", childIntercomTarget: "child-a" };
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, runtimeGeneration: 1, phase: "commit" });
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, runtimeGeneration: 1, phase: "probe" });
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, runtimeGeneration: 2, phase: "commit" });
			gate.release();
			const result = await pending;
			assert.equal(result.status, "ok");
			assert.equal(result.detached, undefined);
		});
	});

	test("legacy unscoped delivery still requires observed intercom tool start", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "run",
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: bus,
				testSession: { output: "normal", promptGate: gate.promise },
			});
			await sleep(20);
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "legacy" });
			gate.release();
			const result = await pending;
			assert.equal(result.status, "ok");
			assert.equal(result.detached, undefined);
		});
	});

	test("rejects missing and incorrect exact targets", async () => {
		await withTempDir(async (dir) => {
			const gate = deferred();
			const emitter = new EventEmitter();
			const bus = eventBus(emitter);
			const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
				cwd: dir,
				runId: "exact-run",
				index: 3,
				intercomSessionName: "child-a",
				allowIntercomDetach: true,
				intercomEvents: bus,
				testSession: { output: "normal", promptGate: gate.promise },
			});
			await sleep(20);
			bus.emit(INTERCOM_DETACH_REQUEST_EVENT, {
				requestId: "missing",
				runId: "exact-run",
				agent: "fake-worker",
				childIndex: 3,
			});
			await handoff(bus, { requestId: "wrong", childIntercomTarget: "child-b" });
			gate.release();
			const result = await pending;
			assert.equal(result.status, "ok");
			assert.equal(result.detached, undefined);
		});
	});

	test("treats hostile-looking event content as inert fixture data", async () => {
		const hostileText = `"); throw new Error("executed as code"); //`;
		const result = await runSync(process.cwd(), [bridgedAgent()], "fake-worker", "A", {
			cwd: process.cwd(),
			runId: "hostile-data",
			testSession: { output: hostileText },
		});
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, hostileText);
	});
});

// RFC #2884: task observation yields without replacing the live execution or its cleanup.
test("task hooks retain the live result through tool activity and exact Intercom commit", async () => {
	await withTempDir(async (dir) => {
		const gate = deferred();
		const disposal = deferred();
		const bus = eventBus(new EventEmitter());
		let execution: Parameters<TaskExecutionHooks["onExecution"]>[0] | undefined;
		const tools: string[] = [];
		const reports: Parameters<TaskExecutionHooks["reportActivity"]>[0][] = [];
		let yields = 0;
		let launches = 0;
		const pending = runSync(dir, [bridgedAgent()], "fake-worker", "task", {
			runId: "task-hooks",
			intercomSessionName: "child-a",
			allowIntercomDetach: true,
			intercomEvents: bus,
			taskExecution: {
				signal: new AbortController().signal,
				onExecution: (value) => {
					execution = value;
					launches++;
				},
				reportActivity: (report) => {
					reports.push(report);
					if (report.change.kind === "action") tools.push(report.change.tool);
				},
				isParentObserving: () => true,
				yieldTaskWait: (reason) => {
					assert.equal(reason, "intercom-coordination");
					yields++;
				},
			},
			testSession: {
				promptGate: gate.promise,
				output: "original result",
				dispose: () => disposal.promise,
				events: ["read", "intercom", "bash"].map((toolName) => ({
					type: "tool_execution_start" as const,
					toolName,
					toolCallId: toolName,
					args: {},
				})),
			},
		});
		assert.ok(execution);
		const original = execution.result;
		let settled = false;
		void original.then(() => {
			settled = true;
		});
		const route = {
			requestId: "exact",
			messageId: "exact",
			senderId: "child",
			childIntercomTarget: "child-a",
			runtimeGeneration: 1,
		};
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "probe" });
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, runtimeGeneration: 2, phase: "commit" });
		assert.equal(yields, 0);
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "probe" });
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
		assert.equal(yields, 1);
		assert.equal(settled, false);
		assert.equal(execution.result, original);
		gate.release();
		assert.equal((await original).status, "ok");
		assert.equal((await pending).status, "ok");
		assert.deepEqual(tools, ["read", "intercom", "bash"]);
		assert.equal(new Set(reports.map((report) => report.reportId)).size, reports.length);
		const metrics = reports.map((report) => report.change).filter((change) => change.kind === "metrics");
		assert.ok(metrics.length > 0);
		assert.equal(metrics.at(-1)?.toolCount, tools.length);
		assert.equal(metrics.at(-1)?.tokenCount, 0);
		assert.ok(metrics.every((change) => typeof change.elapsedMs === "number" && change.elapsedMs >= 0));
		assert.equal(launches, 1);
		let cleaned = false;
		void execution.cleanup.then(() => {
			cleaned = true;
		});
		await Promise.resolve();
		assert.equal(cleaned, false);
		disposal.release();
		assert.deepEqual(await execution.cleanup, { kind: "reaped" });
	});
});

// RFC #2884: disposal failure is cleanup evidence, never a replacement execution failure.
test("task cleanup failure preserves successful execution and is not reaped", async () => {
	await withTempDir(async (dir) => {
		let execution: Parameters<TaskExecutionHooks["onExecution"]>[0] | undefined;
		const pending = runSync(dir, [bridgedAgent()], "fake-worker", "task", {
			runId: "cleanup-failed",
			taskExecution: {
				signal: new AbortController().signal,
				reportActivity: () => {},
				isParentObserving: () => true,
				yieldTaskWait: () => {},
				onExecution: (value) => {
					execution = value;
				},
			},
			testSession: {
				output: "success",
				dispose: () => {
					throw new Error("dispose failed");
				},
			},
		});
		assert.ok(execution);
		assert.equal((await execution.result).status, "ok");
		assert.equal((await pending).status, "ok");
		assert.deepEqual(await execution.cleanup, {
			kind: "failed",
			resources: [{ resource: "agent-session", code: "CleanupFailed", message: "dispose failed" }],
		});
	});
});

// RFC #2884: the admitted task owns cancellation, including after its observation yields.
test("task signal cancels the original execution after Intercom yields", async () => {
	await withTempDir(async (dir) => {
		const gate = deferred();
		const controller = new AbortController();
		const bus = eventBus(new EventEmitter());
		let execution: Parameters<TaskExecutionHooks["onExecution"]>[0] | undefined;
		const pending = runSync(dir, [bridgedAgent()], "fake-worker", "task", {
			runId: "task-cancel",
			allowIntercomDetach: true,
			intercomSessionName: "child-a",
			intercomEvents: bus,
			taskExecution: {
				signal: controller.signal,
				reportActivity: () => {},
				isParentObserving: () => true,
				yieldTaskWait: () => {},
				onExecution: (value) => {
					execution = value;
				},
			},
			testSession: { promptGate: gate.promise },
		});
		assert.ok(execution);
		await handoff(bus, { requestId: "cancel", childIntercomTarget: "child-a" });
		controller.abort();
		gate.release();
		const outcome = await execution.result;
		assert.equal(outcome.status, "interrupted");
		assert.equal("cause" in outcome && outcome.cause, "abort");
		assert.equal((await pending).status, "interrupted");
		assert.deepEqual(await execution.cleanup, { kind: "reaped" });
	});
});

// RFC #2884: a foreground group commit yields sibling observations, not executions.
test("task group detach yields every active sibling once without ending their promises", async () => {
	await withTempDir(async (dir) => {
		const bus = eventBus(new EventEmitter());
		const group = new AbortController();
		const gate = deferred();
		const yields = [0, 0];
		let commits = 0;
		const executions: Array<Parameters<TaskExecutionHooks["onExecution"]>[0]> = [];
		const pending = [0, 1].map((index) =>
			runSync(dir, [bridgedAgent()], "fake-worker", " x ", {
				runId: `task-group-${index}`,
				intercomSessionName: `child-${index}`,
				allowIntercomDetach: true,
				intercomEvents: bus,
				intercomDetachSignal: group.signal,
				onIntercomDetachCommit: () => {
					commits++;
					group.abort();
				},
				taskExecution: {
					signal: new AbortController().signal,
					reportActivity: () => {},
					onExecution: (execution) => {
						executions.push(execution);
					},
					isParentObserving: () => true,
					yieldTaskWait: () => {
						yields[index]++;
					},
				},
				testSession: { promptGate: gate.promise, output: `result-${index}` },
			}),
		);
		assert.equal(executions.length, 2);
		let settled = 0;
		for (const execution of executions)
			void execution.result.then(() => {
				settled++;
			});
		await handoff(bus, { requestId: "group", childIntercomTarget: "child-0" });
		assert.deepEqual(yields, [1, 1]);
		assert.equal(commits, 1);
		assert.equal(settled, 0);
		gate.release();
		assert.deepEqual(
			(await Promise.all(pending)).map((result) => result.status),
			["ok", "ok"],
		);
		assert.equal(settled, 2);
		await Promise.all(executions.map((execution) => execution.cleanup));
	});
});
