import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";
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
				testSession: { output: "resumed result", promptGate: gate.promise },
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
			assert.match(actual.finalOutput ?? "", /resumed result/);
			const actualArtifacts = actual.artifactPaths;
			assert.ok(actualArtifacts);
			assert.match(fs.readFileSync(actualArtifacts.outputPath, "utf8"), /resumed result/);
			const metadata = JSON.parse(fs.readFileSync(actualArtifacts.metadataPath, "utf8")) as { status: string };
			assert.equal(metadata.status, "ok");
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
			assert.equal(recovered[0]?.status, "error");
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
			assert.equal(result.status, "error");
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
