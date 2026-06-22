import type { WorkflowExitOptions, WorkflowExitStatus } from "../../shared/types.js";
import {
  WORKFLOW_SERIALIZABLE_DESCRIPTION,
  workflowSerializableTypeName,
} from "../../shared/serializable.js";

const WORKFLOW_EXIT_SIGNAL = Symbol("atomic-workflows.workflow-exit-signal");
const WORKFLOW_EXIT_STATUSES: ReadonlySet<WorkflowExitStatus> = new Set([
  "completed",
  "skipped",
  "cancelled",
  "blocked",
]);

export type WorkflowExitOutputSnapshot =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly error: Error;
    };

export interface WorkflowExitSignal {
  readonly [WORKFLOW_EXIT_SIGNAL]: true;
  readonly scope: symbol;
  readonly status: WorkflowExitStatus;
  readonly reason?: string;
  readonly outputSnapshot?: WorkflowExitOutputSnapshot;
  readonly validationError?: Error;
}

export function makeWorkflowExitSignal(input: {
  readonly scope: symbol;
  readonly status: WorkflowExitStatus;
  readonly reason?: string;
  readonly outputSnapshot?: WorkflowExitOutputSnapshot;
  readonly validationError?: Error;
}): WorkflowExitSignal {
  return {
    [WORKFLOW_EXIT_SIGNAL]: true,
    scope: input.scope,
    status: input.status,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.outputSnapshot !== undefined ? { outputSnapshot: input.outputSnapshot } : {}),
    ...(input.validationError !== undefined ? { validationError: input.validationError } : {}),
  };
}

const WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE = Symbol("atomic-workflows.workflow-exit-snapshot-invalid-value");

interface WorkflowExitSnapshotInvalidValue {
  readonly [WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE]: true;
  readonly typeName: string;
}

export type SafePropertyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

export function safeGetProperty(value: object, key: PropertyKey): SafePropertyRead {
  try {
    return { ok: true, value: (value as Record<PropertyKey, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

export function unknownErrorMessage(error: unknown): string {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    const message = safeGetProperty(error, "message");
    if (message.ok && typeof message.value === "string" && message.value.length > 0) {
      return message.value;
    }
  }
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}

function workflowExitSnapshotError(message: string, cause: unknown): Error {
  return new Error(`${message}: ${unknownErrorMessage(cause)}`, { cause });
}

function workflowExitOptionReadError(key: "status" | "reason" | "outputs", cause: unknown): Error {
  return workflowExitSnapshotError(`atomic-workflows: ctx.exit() ${key} option could not be read`, cause);
}

export function readWorkflowExitOption(
  options: Pick<WorkflowExitOptions, "status" | "reason" | "outputs"> | null | undefined,
  key: "status" | "reason" | "outputs",
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Error } {
  try {
    return { ok: true, value: options?.[key] };
  } catch (err) {
    return { ok: false, error: workflowExitOptionReadError(key, err) };
  }
}

export function describeWorkflowExitOptionValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Diagnostic-only fallback below.
  }
  return workflowSerializableTypeName(value);
}

function isPlainWorkflowExitSnapshotObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function makeWorkflowExitSnapshotInvalidValue(typeName: string): WorkflowExitSnapshotInvalidValue {
  const marker = {} as { [WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE]?: true; typeName?: string };
  Object.defineProperty(marker, WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(marker, "typeName", {
    value: typeName,
    enumerable: false,
  });
  return Object.freeze(marker) as WorkflowExitSnapshotInvalidValue;
}

export function isWorkflowExitSnapshotInvalidValue(value: unknown): value is WorkflowExitSnapshotInvalidValue {
  return value !== null && typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE] === true;
}

function cloneWorkflowExitSnapshotValue(
  value: unknown,
  seen: Map<object, unknown>,
  stack: Set<object> = new Set(),
): unknown {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType !== "object") {
    return valueType === "function"
      ? makeWorkflowExitSnapshotInvalidValue("function")
      : value;
  }

  const objectValue = value as object;
  const previousClone = seen.get(objectValue);
  if (previousClone !== undefined) {
    return stack.has(objectValue)
      ? makeWorkflowExitSnapshotInvalidValue("circular object")
      : previousClone;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(objectValue, clone);
    stack.add(objectValue);
    try {
      for (let index = 0; index < value.length; index += 1) {
        clone[index] = cloneWorkflowExitSnapshotValue(value[index], seen, stack);
      }
    } finally {
      stack.delete(objectValue);
    }
    return clone;
  }

  if (!isPlainWorkflowExitSnapshotObject(objectValue)) {
    return makeWorkflowExitSnapshotInvalidValue(workflowSerializableTypeName(value));
  }

  const clone: Record<string, unknown> = {};
  seen.set(objectValue, clone);
  stack.add(objectValue);
  try {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      clone[key] = cloneWorkflowExitSnapshotValue((value as Record<string, unknown>)[key], seen, stack);
    }
  } finally {
    stack.delete(objectValue);
  }
  return clone;
}

function deepFreezeWorkflowExitSnapshotValue(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeWorkflowExitSnapshotValue(item);
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeWorkflowExitSnapshotValue((value as Record<string, unknown>)[key]);
  }
}

export function freezeWorkflowExitOutputSnapshot(snapshot: WorkflowExitOutputSnapshot): WorkflowExitOutputSnapshot {
  return Object.freeze(snapshot);
}

export function captureWorkflowExitOutputSnapshot(rawOutputs: unknown): WorkflowExitOutputSnapshot {
  let snapshot: WorkflowExitOutputSnapshot;
  try {
    const value = cloneWorkflowExitSnapshotValue(rawOutputs, new Map());
    deepFreezeWorkflowExitSnapshotValue(value);
    snapshot = { ok: true, value };
  } catch (err) {
    snapshot = {
      ok: false,
      error: workflowExitSnapshotError("atomic-workflows: ctx.exit() outputs could not be snapshotted", err),
    };
  }
  return freezeWorkflowExitOutputSnapshot(snapshot);
}

function formatWorkflowExitSnapshotPath(parent: string, key: string): string {
  const segment = /^\d+$/.test(key)
    ? `[${key}]`
    : /^[A-Za-z_$][\w$]*$/.test(key)
      ? (parent.length > 0 ? `.${key}` : key)
      : `[${JSON.stringify(key)}]`;
  return `${parent}${segment}`;
}

function findWorkflowExitSnapshotInvalidValue(
  value: unknown,
  path = "",
  seen = new Set<unknown>(),
): { readonly path: string; readonly typeName: string } | undefined {
  if (isWorkflowExitSnapshotInvalidValue(value)) {
    return { path, typeName: value.typeName };
  }
  if (value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findWorkflowExitSnapshotInvalidValue(value[index], `${path}[${index}]`, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const found = findWorkflowExitSnapshotInvalidValue(
      (value as Record<string, unknown>)[key],
      formatWorkflowExitSnapshotPath(path, key),
      seen,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

export function workflowExitSnapshotInvalidValueMessage(label: string, value: unknown): string | undefined {
  const invalid = findWorkflowExitSnapshotInvalidValue(value);
  if (invalid === undefined) return undefined;
  const location = invalid.path.length > 0 ? ` at ${invalid.path}` : "";
  return `${label}${location} must be ${WORKFLOW_SERIALIZABLE_DESCRIPTION}, got ${invalid.typeName}`;
}

const PARENT_WORKFLOW_EXIT_ABORT = Symbol("atomic-workflows.parent-workflow-exit-abort");

interface ParentWorkflowExitAbortReason extends Error {
  readonly [PARENT_WORKFLOW_EXIT_ABORT]: true;
  readonly workflowExitReason?: string;
}

export function parentWorkflowExitRunReason(reason?: string): string {
  return reason === undefined || reason.length === 0
    ? "parent workflow exited"
    : `parent workflow exited: ${reason}`;
}

export function makeParentWorkflowExitAbortReason(reason?: string): ParentWorkflowExitAbortReason {
  const error = new Error(parentWorkflowExitRunReason(reason)) as ParentWorkflowExitAbortReason & {
    [PARENT_WORKFLOW_EXIT_ABORT]: true;
    workflowExitReason?: string;
  };
  Object.defineProperty(error, PARENT_WORKFLOW_EXIT_ABORT, {
    value: true,
    enumerable: false,
  });
  if (reason !== undefined) error.workflowExitReason = reason;
  return error;
}

export interface ParentWorkflowExitAbortProbe {
  readonly workflowExitReason?: string;
}

export function parentWorkflowExitAbortReason(value: unknown): ParentWorkflowExitAbortProbe | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const marker = safeGetProperty(value, PARENT_WORKFLOW_EXIT_ABORT);
  if (!marker.ok || marker.value !== true) return undefined;

  const reason = safeGetProperty(value, "workflowExitReason");
  return reason.ok && typeof reason.value === "string"
    ? { workflowExitReason: reason.value }
    : {};
}

export function isWorkflowExitStatus(value: unknown): value is WorkflowExitStatus {
  return typeof value === "string" && WORKFLOW_EXIT_STATUSES.has(value as WorkflowExitStatus);
}

function safeErrorValue(value: unknown): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // Fall through to a safe wrapper below.
  }
  return new Error(unknownErrorMessage(value));
}

function readWorkflowExitOutputSnapshot(value: unknown): WorkflowExitOutputSnapshot | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const ok = safeGetProperty(value, "ok");
  if (!ok.ok) return undefined;
  if (ok.value === true) {
    const snapshotValue = safeGetProperty(value, "value");
    return snapshotValue.ok ? { ok: true, value: snapshotValue.value } : undefined;
  }
  if (ok.value === false) {
    const error = safeGetProperty(value, "error");
    return error.ok ? { ok: false, error: safeErrorValue(error.value) } : undefined;
  }
  return undefined;
}

function readWorkflowExitSignalCandidate(value: object, scope: symbol): WorkflowExitSignal | undefined {
  const marker = safeGetProperty(value, WORKFLOW_EXIT_SIGNAL);
  if (!marker.ok || marker.value !== true) return undefined;

  const signalScope = safeGetProperty(value, "scope");
  if (!signalScope.ok || signalScope.value !== scope) return undefined;

  const status = safeGetProperty(value, "status");
  if (!status.ok || !isWorkflowExitStatus(status.value)) return undefined;

  const reason = safeGetProperty(value, "reason");
  if (!reason.ok || (reason.value !== undefined && typeof reason.value !== "string")) return undefined;

  const outputSnapshotValue = safeGetProperty(value, "outputSnapshot");
  if (!outputSnapshotValue.ok) return undefined;
  const outputSnapshot = readWorkflowExitOutputSnapshot(outputSnapshotValue.value);
  if (outputSnapshotValue.value !== undefined && outputSnapshot === undefined) return undefined;

  const validationError = safeGetProperty(value, "validationError");
  if (!validationError.ok) return undefined;

  return {
    [WORKFLOW_EXIT_SIGNAL]: true,
    scope,
    status: status.value,
    ...(reason.value !== undefined ? { reason: reason.value } : {}),
    ...(outputSnapshot !== undefined ? { outputSnapshot } : {}),
    ...(validationError.value !== undefined ? { validationError: safeErrorValue(validationError.value) } : {}),
  };
}

export function findWorkflowExitSignal(error: unknown, scope: symbol, seen = new Set<unknown>()): WorkflowExitSignal | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  if (seen.has(error)) return undefined;
  seen.add(error);

  const directSignal = readWorkflowExitSignalCandidate(error, scope);
  if (directSignal !== undefined) return directSignal;

  const errors = safeExecutorAggregateErrorItems(error);
  for (const item of errors) {
    const signal = findWorkflowExitSignal(item, scope, seen);
    if (signal !== undefined) return signal;
  }

  const cause = safeGetProperty(error, "cause");
  if (cause.ok) {
    const causeSignal = findWorkflowExitSignal(cause.value, scope, seen);
    if (causeSignal !== undefined) return causeSignal;
  }

  const reason = safeGetProperty(error, "reason");
  return reason.ok ? findWorkflowExitSignal(reason.value, scope, seen) : undefined;
}

function safeArrayItems(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value)) return [];
    const items: unknown[] = [];
    const { length } = value;
    for (let index = 0; index < length; index += 1) {
      try {
        items.push(value[index]);
      } catch {
        // Ignore inaccessible aggregate items while preserving readable ones.
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function safeExecutorAggregateErrorItems(error: unknown): readonly unknown[] {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return [];
  const errors = safeGetProperty(error, "errors");
  return errors.ok ? safeArrayItems(errors.value) : [];
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("workflow killed", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException("workflow killed", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}
