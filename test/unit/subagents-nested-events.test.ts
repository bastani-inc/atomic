import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { APP_NAME } from "@bastani/atomic";
import {
  cleanupOldNestedRuntimeDirs,
  createNestedRoute,
  MAX_NESTED_CHILDREN,
  MAX_NESTED_DEPTH,
  MAX_NESTED_STEPS,
  MAX_PROCESSED_NESTED_EVENTS,
  NESTED_RUNS_DIR,
  nestedArtifactEnv,
  parseNestedControlRequest,
  projectNestedEvents,
  readNestedControlRequests,
  readNestedControlResults,
  readNestedRegistry,
  resolveNestedRouteFromEnv,
  sanitizeSummary,
  validateNestedRouteShape,
  writeNestedControlRequest,
  writeNestedControlResult,
  writeNestedEvent,
  type NestedRoute,
} from "../../packages/subagents/src/runs/shared/nested-events.js";

const cleanupPaths = new Set<string>();

function safeId(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function trackRoute(route: NestedRoute): NestedRoute {
  cleanupPaths.add(path.dirname(route.eventSink));
  return route;
}

function touchTreeOld(filePath: string): void {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(filePath)) {
    const child = path.join(filePath, entry);
    if (fs.statSync(child).isDirectory()) touchTreeOld(child);
    fs.utimesSync(child, old, old);
  }
  fs.utimesSync(filePath, old, old);
}

afterEach(() => {
  for (const filePath of cleanupPaths) fs.rmSync(filePath, { recursive: true, force: true });
  cleanupPaths.clear();
});

describe("nested subagent event routes", () => {
  test("validates route containment and shared route roots", () => {
    const route = trackRoute(createNestedRoute(safeId("root")));
    assert.doesNotThrow(() => validateNestedRouteShape(route));

    const outside = path.join(fs.mkdtempSync(path.join(tmpdir(), "nested-events-outside-")), "events");
    cleanupPaths.add(path.dirname(outside));
    assert.throws(
      () => validateNestedRouteShape({ ...route, eventSink: outside }),
      /outside the subagent nested event root/,
    );
  });

  test("resolves canonical and legacy pi-prefixed route env", () => {
    const route = trackRoute(createNestedRoute(safeId("legacy")));
    const legacyEnv = {
      PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink,
      PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox,
      PI_SUBAGENT_PARENT_ROOT_RUN_ID: route.rootRunId,
      PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken,
    };

    assert.deepEqual(resolveNestedRouteFromEnv(legacyEnv), route);
  });

  test("round-trips control requests and results through route files", () => {
    const route = trackRoute(createNestedRoute(safeId("control")));
    const requestPath = writeNestedControlRequest(route, {
      ts: 1,
      requestId: "request1",
      targetRunId: "target1",
      action: "resume",
      message: "hello",
    });

    assert.equal(readNestedControlRequests(route)[0]?.filePath, requestPath);
    assert.equal(readNestedControlRequests(route)[0]?.message, "hello");

    writeNestedControlResult(route, {
      ts: 2,
      requestId: "request1",
      targetRunId: "target1",
      ok: false,
      message: "nope",
    });

    assert.equal(readNestedControlResults(route)[0]?.message, "nope");
    assert.equal(
      parseNestedControlRequest(JSON.stringify({ type: "subagent.nested.control-request", ts: 1, rootRunId: route.rootRunId, capabilityToken: "wrong", requestId: "request1", targetRunId: "target1", action: "interrupt" }), route),
      undefined,
    );
  });

  test("sanitizes nested summaries by clamping depth, steps, and children", () => {
    const summary = sanitizeSummary({
      id: "child1",
      parentRunId: "parent1",
      depth: 99,
      path: [],
      state: "running",
      steps: Array.from({ length: MAX_NESTED_STEPS + 3 }, (_, index) => ({ agent: `agent${index}`, status: "running" })),
      children: Array.from({ length: MAX_NESTED_CHILDREN + 3 }, (_, index) => ({ id: `grand${index}`, parentRunId: "child1", depth: 1, path: [], state: "complete" })),
    });

    assert.equal(summary?.depth, MAX_NESTED_DEPTH);
    assert.equal(summary?.steps?.length, MAX_NESTED_STEPS);
    assert.equal(summary?.children?.length, MAX_NESTED_CHILDREN);
  });

  test("normalizes legacy completed step status to complete", () => {
    const summary = sanitizeSummary({
      id: "child1",
      parentRunId: "parent1",
      depth: 0,
      path: [],
      state: "running",
      steps: [{ agent: "worker", status: "completed" }],
    });

    assert.equal(summary?.steps?.[0]?.status, "complete");
  });

  test("cleans stale nested route and nested async runtime directories", () => {
    const route = trackRoute(createNestedRoute(safeId("stale")));
    const nestedRunDir = path.join(NESTED_RUNS_DIR, route.rootRunId, "child1");
    fs.mkdirSync(nestedRunDir, { recursive: true });
    cleanupPaths.add(path.join(NESTED_RUNS_DIR, route.rootRunId));
    fs.writeFileSync(path.join(nestedRunDir, "status.json"), "{}\n");
    touchTreeOld(path.dirname(route.eventSink));
    touchTreeOld(path.join(NESTED_RUNS_DIR, route.rootRunId));

    cleanupOldNestedRuntimeDirs(1);

    assert.equal(fs.existsSync(path.dirname(route.eventSink)), false);
    assert.equal(fs.existsSync(path.join(NESTED_RUNS_DIR, route.rootRunId)), false);
  });

  test("serializes registry projection through a stale-safe lock", () => {
    const route = trackRoute(createNestedRoute(safeId("lock")));
    const lockPath = path.join(path.dirname(route.eventSink), ".registry.lock");
    fs.mkdirSync(lockPath, { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    writeNestedEvent(route, {
      type: "subagent.nested.started",
      ts: Date.now(),
      parentRunId: route.rootRunId,
      child: {
        id: "child1",
        parentRunId: route.rootRunId,
        depth: 1,
        path: [{ runId: route.rootRunId }],
        state: "running",
      },
    });

    const registry = projectNestedEvents(route);

    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(registry.children[0]?.id, "child1");
  });

  test("keeps a large bounded processed event replay guard", () => {
    const route = trackRoute(createNestedRoute(safeId("cap")));
    const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      rootRunId: route.rootRunId,
      updatedAt: 0,
      children: [],
      processedEvents: Array.from({ length: MAX_PROCESSED_NESTED_EVENTS + 5 }, (_, index) => `old-${index}.json`),
    }));

    assert.equal(readNestedRegistry(route).processedEvents.length, MAX_PROCESSED_NESTED_EVENTS);

    writeNestedEvent(route, {
      type: "subagent.nested.started",
      ts: Date.now(),
      parentRunId: route.rootRunId,
      child: {
        id: "child1",
        parentRunId: route.rootRunId,
        depth: 1,
        path: [{ runId: route.rootRunId }],
        state: "running",
      },
    });

    const registry = projectNestedEvents(route);

    assert.equal(registry.processedEvents.length, MAX_PROCESSED_NESTED_EVENTS);
    assert.equal(registry.children[0]?.id, "child1");
  });

  test("uses the host app prefix for nested artifact env keys", () => {
    const env = nestedArtifactEnv("root1", "parent1");
    const prefix = APP_NAME.toUpperCase();
    assert.equal(env[`${prefix}_SUBAGENT_NESTED_ROOT_RUN_ID`], "root1");
    assert.equal(env[`${prefix}_SUBAGENT_NESTED_PARENT_RUN_ID`], "parent1");
    assert.equal(Object.hasOwn(env, "PI_SUBAGENT_NESTED_ROOT_RUN_ID"), false);
  });
});
