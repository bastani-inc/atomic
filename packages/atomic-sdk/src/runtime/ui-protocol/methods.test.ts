import { test, expect, describe, mock } from "bun:test";
import type { MessageConnection } from "vscode-jsonrpc";
import { MethodDispatcher } from "./methods.ts";
import type { IRunManager, ISupervisor, RunInfo } from "./methods.ts";
import { AtomicRpcError, AtomicErrorCode } from "./errors.ts";
import { RunState } from "../run-state.ts";
import type { WorkflowRegistry, BrokenEntry } from "../registry.ts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makeConnection(): MessageConnection {
  return {
    sendNotification: mock(() => Promise.resolve()),
    sendRequest: mock(() => Promise.resolve()),
    onNotification: mock(() => ({ dispose: () => {} })),
    onRequest: mock(() => ({ dispose: () => {} })),
    listen: mock(() => {}),
    dispose: mock(() => {}),
  } as unknown as MessageConnection;
}

function makeRunState(runId = "run-1"): RunState {
  return new RunState({
    runId,
    workflowName: "test-wf",
    agent: "claude",
    projectRoot: "/tmp/test",
    statusFilePath: `/tmp/test/${runId}/status.json`,
  });
}

function makeRunInfo(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    runId: "run-1",
    workflowName: "test-wf",
    agent: "claude",
    status: "active",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRunManager(overrides: Partial<IRunManager> = {}): IRunManager {
  return {
    start: mock(() => Promise.resolve({ runId: "run-1" })),
    stop: mock(() => Promise.resolve()),
    list: mock(() => []),
    get: mock(() => null),
    getState: mock(() => null),
    getTranscript: mock(() => Promise.resolve([])),
    subscribe: mock(() => "sub-1"),
    unsubscribe: mock(() => {}),
    ...overrides,
  };
}

function makeSupervisor(overrides: Partial<ISupervisor> = {}): ISupervisor {
  return {
    sendInput: mock(() => {}),
    getScrollback: mock(() => ({ data: "", headOffset: 0 })),
    spawn: mock(() => Promise.resolve({ pid: 1234 })),
    kill: mock(() => {}),
    ...overrides,
  };
}

function makeWorkflowRegistry(overrides: {
  list?: () => ReturnType<WorkflowRegistry["list"]>;
  refresh?: () => Promise<Awaited<ReturnType<WorkflowRegistry["refresh"]>>>;
} = {}) {
  return {
    list: mock(overrides.list ?? (() => [] as ReturnType<WorkflowRegistry["list"]>)),
    refresh: mock(
      overrides.refresh ??
        (() => Promise.resolve({ count: 0, broken: [] }) as Promise<Awaited<ReturnType<WorkflowRegistry["refresh"]>>>),
    ),
    get: mock(() => null),
    getDescriptor: mock(() => null),
    getBySource: mock(() => null),
    load: mock(() => Promise.resolve({ count: 0, broken: [] as BrokenEntry[] })),
  };
}

function makeDispatcher(
  overrides: {
    runs?: Partial<IRunManager>;
    supervisor?: Partial<ISupervisor>;
    workflows?: ReturnType<typeof makeWorkflowRegistry>;
    token?: string;
    atomicVersion?: string;
    sdkVersion?: string;
  } = {},
): { dispatcher: MethodDispatcher; conn: MessageConnection } {
  const conn = makeConnection();
  const dispatcher = new MethodDispatcher({
    workflows: (overrides.workflows ?? makeWorkflowRegistry()) as ReturnType<
      typeof makeWorkflowRegistry
    > as never,
    runs: makeRunManager(overrides.runs ?? {}),
    supervisor: makeSupervisor(overrides.supervisor ?? {}),
    atomicVersion: overrides.atomicVersion ?? "2.0.0",
    sdkVersion: overrides.sdkVersion ?? "0.7.13",
    token: overrides.token,
  });
  return { dispatcher, conn };
}

/** Authenticate a connection to the dispatcher. */
async function authenticate(
  dispatcher: MethodDispatcher,
  conn: MessageConnection,
  token?: string,
): Promise<void> {
  await dispatcher.dispatch("connect", { clientName: "test-client", token }, conn);
}

// ---------------------------------------------------------------------------
// Unknown method
// ---------------------------------------------------------------------------

describe("unknown method", () => {
  test("throws -32601 for unknown method", async () => {
    const { dispatcher, conn } = makeDispatcher();
    await authenticate(dispatcher, conn);
    try {
      await dispatcher.dispatch("nonexistent/method", {}, conn);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(AtomicRpcError);
      expect((err as AtomicRpcError).code).toBe(-32601);
    }
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("authentication", () => {
  test("protocol/getVersion succeeds without connect", async () => {
    const { dispatcher, conn } = makeDispatcher();
    const result = await dispatcher.dispatch("protocol/getVersion", {}, conn);
    expect(result).toMatchObject({ protocolVersion: expect.any(String) });
  });

  test("connect succeeds without token when no server token configured", async () => {
    const { dispatcher, conn } = makeDispatcher(); // no token
    const result = await dispatcher.dispatch("connect", { clientName: "test" }, conn);
    expect(result).toEqual({ ok: true });
  });

  test("connect succeeds with correct token", async () => {
    const { dispatcher, conn } = makeDispatcher({ token: "secret123" });
    const result = await dispatcher.dispatch(
      "connect",
      { clientName: "test", token: "secret123" },
      conn,
    );
    expect(result).toEqual({ ok: true });
  });

  test("connect fails with wrong token", async () => {
    const { dispatcher, conn } = makeDispatcher({ token: "correct" });
    try {
      await dispatcher.dispatch("connect", { clientName: "test", token: "wrong" }, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.AUTHENTICATION_REQUIRED);
    }
  });

  test("connect fails when token required but not supplied", async () => {
    const { dispatcher, conn } = makeDispatcher({ token: "secret" });
    try {
      await dispatcher.dispatch("connect", { clientName: "test" }, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.AUTHENTICATION_REQUIRED);
    }
  });

  test("other methods fail before connect", async () => {
    const { dispatcher, conn } = makeDispatcher();
    try {
      await dispatcher.dispatch("workflow/list", {}, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.AUTHENTICATION_REQUIRED);
    }
  });

  test("other methods succeed after connect", async () => {
    const { dispatcher, conn } = makeDispatcher();
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("workflow/list", {}, conn);
    expect(Array.isArray(result)).toBe(true);
  });

  test("each connection has independent auth state", async () => {
    const { dispatcher, conn: conn1 } = makeDispatcher();
    const conn2 = makeConnection();
    await authenticate(dispatcher, conn1);
    // conn2 is not authenticated
    try {
      await dispatcher.dispatch("workflow/list", {}, conn2);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.AUTHENTICATION_REQUIRED);
    }
  });
});

// ---------------------------------------------------------------------------
// Param validation (invalid params → -32602)
// ---------------------------------------------------------------------------

describe("param validation", () => {
  test("missing required field → -32602", async () => {
    const { dispatcher, conn } = makeDispatcher();
    await authenticate(dispatcher, conn);
    try {
      // run/get requires runId
      await dispatcher.dispatch("run/get", {}, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(-32602);
    }
  });

  test("wrong type → -32602", async () => {
    const { dispatcher, conn } = makeDispatcher();
    await authenticate(dispatcher, conn);
    try {
      // run/stop requires runId: string
      await dispatcher.dispatch("run/stop", { runId: 123 }, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(-32602);
    }
  });

  test("null params treated as empty object for parameterless methods", async () => {
    const { dispatcher, conn } = makeDispatcher();
    await authenticate(dispatcher, conn);
    // workflow/list takes {} — null rawParams should default to {}
    const result = await dispatcher.dispatch("workflow/list", null, conn);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// protocol/getVersion
// ---------------------------------------------------------------------------

describe("protocol/getVersion", () => {
  test("returns protocolVersion, sdkVersion, atomicVersion", async () => {
    const { dispatcher, conn } = makeDispatcher({
      atomicVersion: "2.1.0",
      sdkVersion: "0.8.0",
    });
    const result = await dispatcher.dispatch("protocol/getVersion", {}, conn);
    expect(result).toMatchObject({
      protocolVersion: expect.any(String),
      sdkVersion: "0.8.0",
      atomicVersion: "2.1.0",
    });
  });
});

// ---------------------------------------------------------------------------
// protocol/sendTelemetry
// ---------------------------------------------------------------------------

describe("protocol/sendTelemetry", () => {
  test("returns ok:true", async () => {
    const { dispatcher, conn } = makeDispatcher();
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "protocol/sendTelemetry",
      { event: "test.event" },
      conn,
    );
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// workflow/list
// ---------------------------------------------------------------------------

describe("workflow/list", () => {
  test("returns descriptors from registry", async () => {
    const { dispatcher, conn } = makeDispatcher({
      workflows: makeWorkflowRegistry({
        list: () => [{ name: "my-wf", source: "/path/my-wf.ts", agent: "claude" as const }],
      }),
    });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("workflow/list", {}, conn);
    expect(result).toHaveLength(1);
    expect((result as { name: string }[])[0]?.name).toBe("my-wf");
  });
});

// ---------------------------------------------------------------------------
// workflow/refresh
// ---------------------------------------------------------------------------

describe("workflow/refresh", () => {
  test("calls registry.refresh and returns count + broken", async () => {
    const { dispatcher, conn } = makeDispatcher({
      workflows: makeWorkflowRegistry({
        refresh: () =>
          Promise.resolve({ count: 3, broken: [{ source: "bad.ts", error: "syntax error" }] }),
      }),
    });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("workflow/refresh", {}, conn);
    expect(result).toMatchObject({ count: 3, broken: [{ source: "bad.ts", error: "syntax error" }] });
  });
});

// ---------------------------------------------------------------------------
// workflow/start
// ---------------------------------------------------------------------------

describe("workflow/start", () => {
  test("returns runId and attachable:true", async () => {
    const runs = makeRunManager({ start: mock(() => Promise.resolve({ runId: "run-abc" })) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "workflow/start",
      { source: "/wf.ts", workflowName: "my-wf", agent: "claude", inputs: {} },
      conn,
    );
    expect(result).toEqual({ runId: "run-abc", attachable: true });
  });

  test("propagates AtomicRpcError from run manager", async () => {
    const err = new AtomicRpcError(AtomicErrorCode.WORKFLOW_NOT_FOUND, "not found");
    const runs = makeRunManager({ start: mock(() => Promise.reject(err)) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    try {
      await dispatcher.dispatch(
        "workflow/start",
        { source: "/wf.ts", workflowName: "missing", agent: "claude", inputs: {} },
        conn,
      );
      expect(true).toBe(false);
    } catch (e) {
      expect((e as AtomicRpcError).code).toBe(AtomicErrorCode.WORKFLOW_NOT_FOUND);
    }
  });
});

// ---------------------------------------------------------------------------
// run/list
// ---------------------------------------------------------------------------

describe("run/list", () => {
  test("returns all runs with no scope", async () => {
    const info = makeRunInfo();
    const runs = makeRunManager({ list: mock(() => [info]) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("run/list", {}, conn);
    expect(result).toHaveLength(1);
  });

  test("passes scope to run manager", async () => {
    const listFn = mock(() => []);
    const runs = makeRunManager({ list: listFn });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    await dispatcher.dispatch("run/list", { scope: "active" }, conn);
    expect(listFn).toHaveBeenCalledWith("active");
  });
});

// ---------------------------------------------------------------------------
// run/get
// ---------------------------------------------------------------------------

describe("run/get", () => {
  test("returns run info when found", async () => {
    const info = makeRunInfo({ runId: "run-xyz" });
    const runs = makeRunManager({ get: mock(() => info) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("run/get", { runId: "run-xyz" }, conn);
    expect((result as RunInfo)?.runId).toBe("run-xyz");
  });

  test("returns null when not found", async () => {
    const runs = makeRunManager({ get: mock(() => null) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("run/get", { runId: "missing" }, conn);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run/status
// ---------------------------------------------------------------------------

describe("run/status", () => {
  test("returns snapshot when run found", async () => {
    const state = makeRunState("run-1");
    const runs = makeRunManager({ getState: mock(() => state) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("run/status", { runId: "run-1" }, conn);
    expect(result).toBeTypeOf("object");
    expect(result).not.toBeNull();
  });

  test("returns null when run not found", async () => {
    const runs = makeRunManager({ getState: mock(() => null) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("run/status", { runId: "missing" }, conn);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run/transcript
// ---------------------------------------------------------------------------

describe("run/transcript", () => {
  test("returns messages array", async () => {
    const msgs = [{ role: "user", content: "hello" }];
    const runs = makeRunManager({ getTranscript: mock(() => Promise.resolve(msgs)) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "run/transcript",
      { runId: "run-1", sessionName: "stage-1" },
      conn,
    );
    expect(result).toEqual(msgs);
  });
});

// ---------------------------------------------------------------------------
// run/stop
// ---------------------------------------------------------------------------

describe("run/stop", () => {
  test("stops run and returns ok:true", async () => {
    const stopFn = mock(() => Promise.resolve());
    const runs = makeRunManager({
      get: mock(() => makeRunInfo()),
      stop: stopFn,
    });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("run/stop", { runId: "run-1" }, conn);
    expect(result).toEqual({ ok: true });
    expect(stopFn).toHaveBeenCalledWith("run-1");
  });

  test("throws RUN_NOT_FOUND when run unknown", async () => {
    const runs = makeRunManager({ get: mock(() => null) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    try {
      await dispatcher.dispatch("run/stop", { runId: "ghost" }, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.RUN_NOT_FOUND);
    }
  });
});

// ---------------------------------------------------------------------------
// run/getAttachInfo
// ---------------------------------------------------------------------------

describe("run/getAttachInfo", () => {
  test("subscribes connection and returns subscriptionId + foregroundStage", async () => {
    const state = makeRunState("run-1");
    const runs = makeRunManager({ getState: mock(() => state) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = (await dispatcher.dispatch("run/getAttachInfo", { runId: "run-1" }, conn)) as {
      subscriptionId: string;
      foregroundStage: string | null;
    };
    expect(typeof result.subscriptionId).toBe("string");
    expect(result.subscriptionId).toBeTruthy();
    expect(result.foregroundStage).toBeNull();
  });

  test("returns updated foregroundStage after setForeground", async () => {
    const state = makeRunState("run-1");
    state.addStage({ name: "stage-a" });
    state.setForeground("stage-a");
    const runs = makeRunManager({ getState: mock(() => state) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = (await dispatcher.dispatch("run/getAttachInfo", { runId: "run-1" }, conn)) as {
      subscriptionId: string;
      foregroundStage: string | null;
    };
    expect(result.foregroundStage).toBe("stage-a");
  });

  test("throws RUN_NOT_FOUND when run unknown", async () => {
    const runs = makeRunManager({ getState: mock(() => null) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    try {
      await dispatcher.dispatch("run/getAttachInfo", { runId: "ghost" }, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.RUN_NOT_FOUND);
    }
  });
});

// ---------------------------------------------------------------------------
// run/setForeground
// ---------------------------------------------------------------------------

describe("run/setForeground", () => {
  test("sets foreground stage and returns ok:true", async () => {
    const state = makeRunState("run-1");
    state.addStage({ name: "stage-a" });
    const runs = makeRunManager({ getState: mock(() => state) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "run/setForeground",
      { runId: "run-1", stageName: "stage-a" },
      conn,
    );
    expect(result).toEqual({ ok: true });
    expect(state.getForeground()).toBe("stage-a");
  });

  test("sets foreground to null when stageName omitted", async () => {
    const state = makeRunState("run-1");
    state.addStage({ name: "stage-a" });
    state.setForeground("stage-a");
    const runs = makeRunManager({ getState: mock(() => state) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    await dispatcher.dispatch("run/setForeground", { runId: "run-1" }, conn);
    expect(state.getForeground()).toBeNull();
  });

  test("throws RUN_NOT_FOUND when run unknown", async () => {
    const runs = makeRunManager({ getState: mock(() => null) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    try {
      await dispatcher.dispatch("run/setForeground", { runId: "ghost", stageName: "s" }, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.RUN_NOT_FOUND);
    }
  });
});

// ---------------------------------------------------------------------------
// pane/sendInput
// ---------------------------------------------------------------------------

describe("pane/sendInput", () => {
  test("forwards input and returns ok:true", async () => {
    const sendInput = mock(() => {});
    const { dispatcher, conn } = makeDispatcher({ supervisor: { sendInput } });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "pane/sendInput",
      { runId: "run-1", stageName: "stage-a", data: "hello\n" },
      conn,
    );
    expect(result).toEqual({ ok: true });
    expect(sendInput).toHaveBeenCalledWith("run-1", "stage-a", "hello\n");
  });
});

// ---------------------------------------------------------------------------
// pane/getScrollback
// ---------------------------------------------------------------------------

describe("pane/getScrollback", () => {
  test("returns data and headOffset from supervisor", async () => {
    const getScrollback = mock(() => ({ data: "output data", headOffset: 42 }));
    const { dispatcher, conn } = makeDispatcher({ supervisor: { getScrollback } });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "pane/getScrollback",
      { runId: "run-1", stageName: "stage-a" },
      conn,
    );
    expect(result).toEqual({ data: "output data", headOffset: 42 });
  });

  test("passes fromOffset to supervisor", async () => {
    const getScrollback = mock(() => ({ data: "", headOffset: 100 }));
    const { dispatcher, conn } = makeDispatcher({ supervisor: { getScrollback } });
    await authenticate(dispatcher, conn);
    await dispatcher.dispatch(
      "pane/getScrollback",
      { runId: "run-1", stageName: "stage-a", fromOffset: 50 },
      conn,
    );
    expect(getScrollback).toHaveBeenCalledWith("run-1", "stage-a", 50);
  });
});

// ---------------------------------------------------------------------------
// panel/get
// ---------------------------------------------------------------------------

describe("panel/get", () => {
  test("returns snapshot for known run", async () => {
    const state = makeRunState("run-1");
    const runs = makeRunManager({ getState: mock(() => state) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("panel/get", { runId: "run-1" }, conn);
    expect(result).toBeTypeOf("object");
    expect(result).not.toBeNull();
  });

  test("throws RUN_NOT_FOUND when run unknown", async () => {
    const runs = makeRunManager({ getState: mock(() => null) });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    try {
      await dispatcher.dispatch("panel/get", { runId: "ghost" }, conn);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as AtomicRpcError).code).toBe(AtomicErrorCode.RUN_NOT_FOUND);
    }
  });
});

// ---------------------------------------------------------------------------
// panel/subscribe
// ---------------------------------------------------------------------------

describe("panel/subscribe", () => {
  test("returns subscriptionId from run manager", async () => {
    const subscribe = mock(() => "sub-xyz");
    const runs = makeRunManager({ subscribe });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("panel/subscribe", { runId: "run-1" }, conn);
    expect(result).toEqual({ subscriptionId: "sub-xyz" });
    expect(subscribe).toHaveBeenCalledWith(conn, "run-1");
  });

  test("subscribes without runId when omitted", async () => {
    const subscribe = mock(() => "sub-global");
    const runs = makeRunManager({ subscribe });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("panel/subscribe", {}, conn);
    expect(result).toEqual({ subscriptionId: "sub-global" });
    expect(subscribe).toHaveBeenCalledWith(conn, undefined);
  });
});

// ---------------------------------------------------------------------------
// panel/unsubscribe
// ---------------------------------------------------------------------------

describe("panel/unsubscribe", () => {
  test("calls unsubscribe and returns ok:true", async () => {
    const unsubscribe = mock(() => {});
    const runs = makeRunManager({ unsubscribe });
    const { dispatcher, conn } = makeDispatcher({ runs });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "panel/unsubscribe",
      { subscriptionId: "sub-1" },
      conn,
    );
    expect(result).toEqual({ ok: true });
    expect(unsubscribe).toHaveBeenCalledWith("sub-1");
  });
});

// ---------------------------------------------------------------------------
// agent/spawn
// ---------------------------------------------------------------------------

describe("agent/spawn", () => {
  test("returns pid and scrollbackBytes:0", async () => {
    const spawn = mock(() => Promise.resolve({ pid: 9999 }));
    const { dispatcher, conn } = makeDispatcher({ supervisor: { spawn } });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch(
      "agent/spawn",
      { runId: "run-1", stageName: "stage-a", agent: "claude", args: ["--print", "hello"] },
      conn,
    );
    expect(result).toEqual({ pid: 9999, scrollbackBytes: 0 });
  });

  test("passes env to supervisor", async () => {
    const spawn = mock(() => Promise.resolve({ pid: 1 }));
    const { dispatcher, conn } = makeDispatcher({ supervisor: { spawn } });
    await authenticate(dispatcher, conn);
    await dispatcher.dispatch(
      "agent/spawn",
      {
        runId: "run-1",
        stageName: "stage-a",
        agent: "claude",
        args: [],
        env: { MY_VAR: "value" },
      },
      conn,
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ env: { MY_VAR: "value" } }),
    );
  });
});

// ---------------------------------------------------------------------------
// agent/kill
// ---------------------------------------------------------------------------

describe("agent/kill", () => {
  test("sends SIGTERM by default and returns ok:true", async () => {
    const kill = mock(() => {});
    const { dispatcher, conn } = makeDispatcher({ supervisor: { kill } });
    await authenticate(dispatcher, conn);
    const result = await dispatcher.dispatch("agent/kill", { pid: 5000 }, conn);
    expect(result).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith(5000, undefined);
  });

  test("forwards SIGKILL signal", async () => {
    const kill = mock(() => {});
    const { dispatcher, conn } = makeDispatcher({ supervisor: { kill } });
    await authenticate(dispatcher, conn);
    await dispatcher.dispatch("agent/kill", { pid: 5000, signal: "SIGKILL" }, conn);
    expect(kill).toHaveBeenCalledWith(5000, "SIGKILL");
  });
});
