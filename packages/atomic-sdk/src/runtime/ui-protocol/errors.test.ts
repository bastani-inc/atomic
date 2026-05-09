import { test, expect, describe } from "bun:test";
import {
  AtomicErrorCode,
  AtomicRpcError,
  authenticationRequired,
  runNotFound,
  workflowNotFound,
  invalidWorkflow,
  workflowNotCompiled,
  incompatibleSdk,
  stageNotFound,
  missingDependency,
  ptyFailed,
  rateLimited,
} from "./errors";

describe("AtomicErrorCode", () => {
  test("has correct numeric codes", () => {
    expect(AtomicErrorCode.AUTHENTICATION_REQUIRED).toBe(-32001);
    expect(AtomicErrorCode.RUN_NOT_FOUND).toBe(-32002);
    expect(AtomicErrorCode.WORKFLOW_NOT_FOUND).toBe(-32003);
    expect(AtomicErrorCode.INVALID_WORKFLOW).toBe(-32004);
    expect(AtomicErrorCode.WORKFLOW_NOT_COMPILED).toBe(-32005);
    expect(AtomicErrorCode.INCOMPATIBLE_SDK).toBe(-32006);
    expect(AtomicErrorCode.STAGE_NOT_FOUND).toBe(-32007);
    expect(AtomicErrorCode.MISSING_DEPENDENCY).toBe(-32008);
    expect(AtomicErrorCode.PTY_FAILED).toBe(-32009);
    expect(AtomicErrorCode.RATE_LIMITED).toBe(-32010);
  });
});

describe("AtomicRpcError", () => {
  test("extends Error", () => {
    const err = new AtomicRpcError(-32001, "test error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AtomicRpcError);
  });

  test("stores code, message, data", () => {
    const err = new AtomicRpcError(-32002, "some error", { foo: "bar" });
    expect(err.code).toBe(-32002);
    expect(err.message).toBe("some error");
    expect(err.data).toEqual({ foo: "bar" });
  });

  test("data is undefined when not provided", () => {
    const err = new AtomicRpcError(-32001, "no data");
    expect(err.data).toBeUndefined();
  });

  test("toResponseError returns ResponseError with matching fields", () => {
    const err = new AtomicRpcError(-32003, "workflow not found", { workflowName: "foo" });
    const resp = err.toResponseError();
    expect(resp.code).toBe(-32003);
    expect(resp.message).toBe("workflow not found");
    expect(resp.data).toEqual({ workflowName: "foo" });
  });
});

describe("helper constructors", () => {
  test("authenticationRequired", () => {
    const err = authenticationRequired();
    expect(err.code).toBe(AtomicErrorCode.AUTHENTICATION_REQUIRED);
    expect(err.message).toBe("authentication required");
    expect(err.data).toBeUndefined();
  });

  test("runNotFound includes runId in message and data", () => {
    const err = runNotFound("run-123");
    expect(err.code).toBe(AtomicErrorCode.RUN_NOT_FOUND);
    expect(err.message).toContain("run-123");
    expect(err.data).toEqual({ runId: "run-123" });
  });

  test("workflowNotFound includes name in message and data", () => {
    const err = workflowNotFound("my-wf");
    expect(err.code).toBe(AtomicErrorCode.WORKFLOW_NOT_FOUND);
    expect(err.message).toContain("my-wf");
    expect(err.data).toEqual({ workflowName: "my-wf" });
  });

  test("invalidWorkflow includes source and reason", () => {
    const err = invalidWorkflow("wf.ts", "syntax error");
    expect(err.code).toBe(AtomicErrorCode.INVALID_WORKFLOW);
    expect(err.data).toEqual({ source: "wf.ts", reason: "syntax error" });
  });

  test("workflowNotCompiled includes name", () => {
    const err = workflowNotCompiled("my-wf");
    expect(err.code).toBe(AtomicErrorCode.WORKFLOW_NOT_COMPILED);
    expect(err.data).toEqual({ workflowName: "my-wf" });
  });

  test("incompatibleSdk includes required and actual", () => {
    const err = incompatibleSdk("2.0.0", "1.5.0");
    expect(err.code).toBe(AtomicErrorCode.INCOMPATIBLE_SDK);
    expect(err.data).toEqual({ required: "2.0.0", actual: "1.5.0" });
  });

  test("stageNotFound includes runId and stageName", () => {
    const err = stageNotFound("run-abc", "stage-1");
    expect(err.code).toBe(AtomicErrorCode.STAGE_NOT_FOUND);
    expect(err.data).toEqual({ runId: "run-abc", stageName: "stage-1" });
  });

  test("missingDependency includes dependency", () => {
    const err = missingDependency("ffmpeg");
    expect(err.code).toBe(AtomicErrorCode.MISSING_DEPENDENCY);
    expect(err.data).toEqual({ dependency: "ffmpeg" });
  });

  test("ptyFailed includes reason", () => {
    const err = ptyFailed("exec failed");
    expect(err.code).toBe(AtomicErrorCode.PTY_FAILED);
    expect(err.data).toEqual({ reason: "exec failed" });
  });

  test("rateLimited", () => {
    const err = rateLimited();
    expect(err.code).toBe(AtomicErrorCode.RATE_LIMITED);
    expect(err.message).toBe("rate limited");
  });
});
