import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../packages/subagents/src/shared/types.js";
import { agentConfig, successEvent, withFakeCliEvent } from "./subagents-attempt-watchdog-helpers.js";

function eventBus(emitter: EventEmitter) {
  return {
    on(channel: string, handler: (data: unknown) => void) { emitter.on(channel, handler); return () => emitter.off(channel, handler); },
    emit(channel: string, data: unknown) { emitter.emit(channel, data); },
  };
}
async function handoff(bus: ReturnType<typeof eventBus>, route: { requestId: string; childIntercomTarget: string; runtimeGeneration?: number }): Promise<void> {
  const complete = { messageId: route.requestId, senderId: "child-id", runtimeGeneration: 1, ...route };
  bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...complete, phase: "probe" });
  await Bun.sleep(1);
  bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...complete, phase: "commit" });
}

const bridgedAgent = () => ({ ...agentConfig(), systemPrompt: "Intercom orchestration channel:\nCoordinate." });
describe("foreground intercom detach routing", () => {

  test("reports the eventual result exactly once and finalizes artifacts after detach", async () => {
    await withFakeCliEvent(successEvent("resumed result"), 100, async (dir) => {
      const emitter = new EventEmitter();
      const recovered: Array<{ exitCode: number; finalOutput?: string; artifactPaths?: { outputPath: string; metadataPath: string }; modelAttempts?: Array<{ exitCode: number }> }> = [];
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "recover", index: 0, intercomSessionName: "child-a", allowIntercomDetach: true,
        intercomEvents: eventBus(emitter), artifactsDir: dir,
        onDetachedExit: (result) => recovered.push(result as typeof recovered[number]),
      });
      await Bun.sleep(25);
      await handoff(eventBus(emitter), { requestId: "q", childIntercomTarget: "child-a" });
      const placeholder = await pending;
      assert.equal(placeholder.exitCode, -2);
      assert.ok(placeholder.artifactPaths);
      assert.equal(fs.existsSync(placeholder.artifactPaths.outputPath), false);
      for (let attempt = 0; attempt < 100 && recovered.length === 0; attempt++) await Bun.sleep(20);
      assert.equal(recovered.length, 1);
      const actual = recovered[0]!;
      assert.equal(actual.exitCode, 0);
      assert.match(actual.finalOutput ?? "", /resumed result/);
      assert.equal(actual.modelAttempts?.at(-1)?.exitCode, 0);
      assert.ok(actual.artifactPaths);
      assert.match(fs.readFileSync(actual.artifactPaths.outputPath, "utf8"), /resumed result/);
      const metadata = JSON.parse(fs.readFileSync(actual.artifactPaths.metadataPath, "utf8")) as { exitCode: number; modelAttempts: Array<{ exitCode: number }> };
      assert.equal(metadata.exitCode, 0);
      assert.equal(metadata.modelAttempts.at(-1)?.exitCode, 0);
    });
  });
  test("a broker-routed handoff detaches the exact child even before tool-start observation", async () => {
    await withFakeCliEvent(successEvent("eventual result"), 100, async (dir) => {
      const emitter = new EventEmitter();
      const bus = eventBus(emitter);
      const first = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "run", index: 0, intercomSessionName: "child-a", allowIntercomDetach: true, intercomEvents: bus,
      });
      const second = runSync(dir, [bridgedAgent()], "fake-worker", "B", {
        cwd: dir, runId: "run", index: 1, intercomSessionName: "child-b", allowIntercomDetach: true, intercomEvents: bus,
      });
		let acknowledged = 0;
		emitter.on(INTERCOM_DETACH_RESPONSE_EVENT, () => acknowledged++);
		const route = { requestId: "q1", messageId: "q1", childIntercomTarget: "child-a", senderId: "child-id", runtimeGeneration: 1 };
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "probe" });
		await Bun.sleep(10);
		assert.equal(acknowledged, 1);
		bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
		const a = await first;
      const b = await second;
      assert.equal(a.detached, true);
      assert.equal(a.exitCode, -2);
      assert.equal(b.detached, undefined);
      assert.equal(b.exitCode, 0);
    });
  });

  test("lifecycle cancellation still terminates a detached child and cleans listeners once", async () => {
    await withFakeCliEvent(successEvent("too late"), 10_000, async (dir) => {
      const emitter = new EventEmitter();
      const bus = eventBus(emitter);
      const controller = new AbortController();
      const recovered: Array<{ exitCode: number }> = [];
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "cancel-detached", index: 0, intercomSessionName: "child-a",
        allowIntercomDetach: true, intercomEvents: bus, signal: controller.signal,
        onDetachedExit: (result) => recovered.push(result),
      });
      await Bun.sleep(25);
      await handoff(bus, { requestId: "q", childIntercomTarget: "child-a" });
      assert.equal((await pending).detached, true);
      controller.abort();
      for (let i = 0; i < 30 && recovered.length === 0; i++) await Bun.sleep(20);
      assert.equal(recovered.length, 1);
      assert.notEqual(recovered[0]?.exitCode, 0);
      assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
    });
  });

  test("abort before detach terminates normally and leaves no detach listener", async () => {
    await withFakeCliEvent(successEvent("too late"), 10_000, async (dir) => {
      const emitter = new EventEmitter();
      const controller = new AbortController();
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "cancel-before", index: 0, intercomSessionName: "child-a",
        allowIntercomDetach: true, intercomEvents: eventBus(emitter), signal: controller.signal,
      });
      await Bun.sleep(25);
      controller.abort();
      const result = await pending;
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.detached, undefined);
      assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
    });
  });

  test("background-style execution ignores targeted detach requests", async () => {
    await withFakeCliEvent(successEvent("background result"), 80, async (dir) => {
      const emitter = new EventEmitter();
      const bus = eventBus(emitter);
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "background", index: 0, intercomSessionName: "child-a",
        allowIntercomDetach: false, intercomEvents: bus,
      });
      await Bun.sleep(20);
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { phase: "commit", requestId: "q", childIntercomTarget: "child-a" });
      const result = await pending;
      assert.equal(result.detached, undefined);
      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /background result/);
      assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
    });
  });

  test("duplicate targeted delivery detaches and recovers the child only once", async () => {
    await withFakeCliEvent(successEvent("once"), 90, async (dir) => {
      const emitter = new EventEmitter();
      const bus = eventBus(emitter);
      const recovered: Array<{ finalOutput?: string }> = [];
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "duplicate", index: 0, intercomSessionName: "child-a",
        allowIntercomDetach: true, intercomEvents: bus, onDetachedExit: result => recovered.push(result),
      });
      await Bun.sleep(20);
      const request = { requestId: "same", messageId: "same", senderId: "child-id", childIntercomTarget: "child-a", runtimeGeneration: 4 };
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "probe" });
      await Bun.sleep(1);
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "commit" });
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...request, phase: "commit" });
      assert.equal((await pending).detached, true);
      for (let i = 0; i < 20 && recovered.length === 0; i++) await Bun.sleep(10);
      assert.equal(recovered.length, 1);
      assert.match(recovered[0]?.finalOutput ?? "", /once/);
      assert.equal(emitter.listenerCount(INTERCOM_DETACH_REQUEST_EVENT), 0);
    });
  });

  test("rejects commit without a matching probe and rejects generation reuse", async () => {
    await withFakeCliEvent(successEvent("normal"), 100, async (dir) => {
      const emitter = new EventEmitter();
      const bus = eventBus(emitter);
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "reserved", index: 0, intercomSessionName: "child-a", allowIntercomDetach: true, intercomEvents: bus,
      });
      await Bun.sleep(20);
      const route = { requestId: "q", messageId: "q", senderId: "child-id", childIntercomTarget: "child-a" };
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, runtimeGeneration: 1, phase: "commit" });
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, runtimeGeneration: 1, phase: "probe" });
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, runtimeGeneration: 2, phase: "commit" });
      const result = await pending;
      assert.equal(result.detached, undefined);
      assert.equal(result.exitCode, 0);
    });
  });
  test("legacy unscoped delivery still requires observed intercom tool start", async () => {
    await withFakeCliEvent(successEvent("normal"), 100, async (dir) => {
      const emitter = new EventEmitter();
      const bus = eventBus(emitter);
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "run", intercomSessionName: "child-a", allowIntercomDetach: true, intercomEvents: bus,
      });
      await Bun.sleep(20);
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "legacy" });
      const result = await pending;
      assert.equal(result.detached, undefined);
      assert.equal(result.exitCode, 0);
    });
  });

  test("rejects missing and incorrect exact targets", async () => {
    await withFakeCliEvent(successEvent("normal"), 120, async (dir) => {
      const emitter = new EventEmitter();
      const bus = eventBus(emitter);
      const pending = runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir, runId: "exact-run", index: 3, intercomSessionName: "child-a", allowIntercomDetach: true, intercomEvents: bus,
      });
      await Bun.sleep(20);
      bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "missing", runId: "exact-run", agent: "fake-worker", childIndex: 3 });
      await handoff(bus, { requestId: "wrong", childIntercomTarget: "child-b" });
      const result = await pending;
      assert.equal(result.detached, undefined);
      assert.equal(result.exitCode, 0);
    });
  });

  test("treats hostile-looking event content as inert fixture data", async () => {
    const hostileText = `"); throw new Error("executed as code"); //`;
    await withFakeCliEvent(successEvent(hostileText), 0, async (dir) => {
      const result = await runSync(dir, [bridgedAgent()], "fake-worker", "A", {
        cwd: dir,
        runId: "hostile-data",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, hostileText);
    });
  });
});
