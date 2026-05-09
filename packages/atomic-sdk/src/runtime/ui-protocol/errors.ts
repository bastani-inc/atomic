import { ResponseError } from "vscode-jsonrpc";

export const AtomicErrorCode = {
  AUTHENTICATION_REQUIRED: -32001,
  RUN_NOT_FOUND: -32002,
  WORKFLOW_NOT_FOUND: -32003,
  INVALID_WORKFLOW: -32004,
  WORKFLOW_NOT_COMPILED: -32005,
  INCOMPATIBLE_SDK: -32006,
  STAGE_NOT_FOUND: -32007,
  MISSING_DEPENDENCY: -32008,
  PTY_FAILED: -32009,
  RATE_LIMITED: -32010,
} as const;

export type AtomicErrorCodeValue =
  (typeof AtomicErrorCode)[keyof typeof AtomicErrorCode];

export class AtomicRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AtomicRpcError";
    this.code = code;
    this.data = data;
  }

  toResponseError(): ResponseError<unknown> {
    return new ResponseError<unknown>(this.code, this.message, this.data);
  }
}

export function authenticationRequired(): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.AUTHENTICATION_REQUIRED,
    "authentication required",
  );
}

export function runNotFound(runId: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.RUN_NOT_FOUND,
    `run not found: ${runId}`,
    { runId },
  );
}

export function workflowNotFound(name: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.WORKFLOW_NOT_FOUND,
    `workflow not found: ${name}`,
    { workflowName: name },
  );
}

export function invalidWorkflow(source: string, reason: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.INVALID_WORKFLOW,
    `invalid workflow '${source}': ${reason}`,
    { source, reason },
  );
}

export function workflowNotCompiled(name: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.WORKFLOW_NOT_COMPILED,
    `workflow not compiled: ${name}`,
    { workflowName: name },
  );
}

export function incompatibleSdk(required: string, actual: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.INCOMPATIBLE_SDK,
    `incompatible SDK: required ${required}, actual ${actual}`,
    { required, actual },
  );
}

export function stageNotFound(runId: string, stageName: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.STAGE_NOT_FOUND,
    `stage not found: ${stageName} in run ${runId}`,
    { runId, stageName },
  );
}

export function missingDependency(dependency: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.MISSING_DEPENDENCY,
    `missing dependency: ${dependency}`,
    { dependency },
  );
}

export function ptyFailed(reason: string): AtomicRpcError {
  return new AtomicRpcError(
    AtomicErrorCode.PTY_FAILED,
    `PTY failed: ${reason}`,
    { reason },
  );
}

export function rateLimited(): AtomicRpcError {
  return new AtomicRpcError(AtomicErrorCode.RATE_LIMITED, "rate limited");
}
