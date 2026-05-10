/**
 * Tests for `src/primitives/run.ts`.
 *
 * Uses `mock.module` to mock `../runtime/daemon.ts` so no real daemon
 * connection is needed.
 */

import { test, expect, describe, mock } from "bun:test";
import type { RegistrableWorkflow } from "../types.ts";

// ─── Mock daemon module ───────────────────────────────────────────────────────

const mockSendRequest = mock(async (method: string, _params: unknown) => {
  if (method === "workflow/start") {
    return { runId: "test-run-id-01", attachable: true as const };
  }
  throw new Error(`Unexpected method: ${method}`);
});

const mockOnNotification = mock(
  (_event: string, handler: (params: { runId: string }) => void) => {
    // Immediately simulate run/ended notification so foreground mode resolves.
    handler({ runId: "test-run-id-01" });
  },
);

const mockDispose = mock(() => {});

const mockConn = {
  sendRequest: mockSendRequest,
  onNotification: mockOnNotification,
  dispose: mockDispose,
};

const mockEnsureStarted = mock(async () => mockConn);

mock.module("../runtime/daemon.ts", () => ({
  ensureStarted: mockEnsureStarted,
  connectToDaemon: mock(async () => mockConn),
}));

// ─── Import after mock is registered ─────────────────────────────────────────

import { runWorkflow } from "./run.ts";

// ─── Fake workflow ─────────────────────────────────────────────────────────────

const fakeWorkflow = {
  kind: "builtin" as const,
  name: "hello-world",
  description: "test workflow",
  agent: "claude" as const,
  inputs: [] as const,
  source: "/fake/hello-world.ts",
  minSDKVersion: null,
  run: async () => {},
} as unknown as RegistrableWorkflow;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runWorkflow", () => {
  test("detach:true — sends workflow/start with correct params and returns runId and daemon", async () => {
    mockSendRequest.mockClear();
    mockEnsureStarted.mockClear();

    const result = await runWorkflow({
      workflow: fakeWorkflow,
      detach: true,
    });

    expect(result.runId).toBe("test-run-id-01");
    expect(result.daemon).toBeDefined();

    expect(mockSendRequest).toHaveBeenCalledTimes(1);
    const [method, params] = mockSendRequest.mock.calls[0]!;
    expect(method).toBe("workflow/start");
    expect(params).toMatchObject({
      source: "/fake/hello-world.ts",
      workflowName: "hello-world",
      agent: "claude",
      inputs: {},
    });
  });

  test("detach:false — subscribes to run/ended notification", async () => {
    mockOnNotification.mockClear();
    mockSendRequest.mockClear();

    const result = await runWorkflow({
      workflow: fakeWorkflow,
      detach: false,
    });

    expect(result.runId).toBe("test-run-id-01");
    expect(mockOnNotification).toHaveBeenCalledWith("run/ended", expect.any(Function));
  });

  test("passes inputs through validateInputs", async () => {
    mockSendRequest.mockClear();

    const workflowWithInputs = {
      ...fakeWorkflow,
      inputs: [
        { name: "greeting", type: "string" as const, required: false, default: "hello" },
      ],
    } as unknown as RegistrableWorkflow;

    const result = await runWorkflow({
      workflow: workflowWithInputs,
      inputs: { greeting: "world" },
      detach: true,
    });

    expect(result.runId).toBe("test-run-id-01");
    const [, params] = mockSendRequest.mock.calls[0]!;
    expect((params as { inputs: Record<string, string> }).inputs).toMatchObject({
      greeting: "world",
    });
  });

  test("forwards pathToAtomicExecutable as atomicBinary to ensureStarted", async () => {
    mockEnsureStarted.mockClear();

    await runWorkflow({
      workflow: fakeWorkflow,
      pathToAtomicExecutable: "/usr/local/bin/atomic",
      detach: true,
    });

    expect(mockEnsureStarted).toHaveBeenCalledWith(
      expect.objectContaining({ atomicBinary: "/usr/local/bin/atomic" }),
    );
  });

  test("forwards endpointFile and token to ensureStarted", async () => {
    mockEnsureStarted.mockClear();

    await runWorkflow({
      workflow: fakeWorkflow,
      endpointFile: "/custom/endpoint.json",
      token: "my-secret-token",
      detach: true,
    });

    expect(mockEnsureStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointFile: "/custom/endpoint.json",
        token: "my-secret-token",
      }),
    );
  });

  test("default detach behavior (omitted) subscribes to run/ended", async () => {
    mockOnNotification.mockClear();

    await runWorkflow({ workflow: fakeWorkflow });

    // Without detach:true, should have subscribed to run/ended
    expect(mockOnNotification).toHaveBeenCalledWith("run/ended", expect.any(Function));
  });
});
