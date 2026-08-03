import type {
	WorkflowSerializableValue,
	WorkflowToolError,
	WorkflowToolFailure,
	WorkflowToolOutcome,
	WorkflowToolSuccess,
} from "../shared/types.js";
import {
	errorMessage,
	errorName,
	field,
	redactSensitiveText,
	selectProcessFailureError,
} from "../shared/workflow-failures-signals.js";

export const TOOL_FAILURE_TEXT_LIMIT_BYTES = 16_384;
const TRUNCATION_PREFIX = "[workflow tool output truncated; showing final bytes]\n";

function safeField(error: unknown, key: string): unknown {
	try {
		return field(error, key);
	} catch {
		return undefined;
	}
}

function exposedText(error: unknown, key: "stdout" | "stderr"): string | undefined {
	const value = safeField(error, key);
	if (typeof value === "string") return value;
	try {
		if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
		if (ArrayBuffer.isView(value)) {
			return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function boundedSafeToolFailureText(value: string): string {
	const redacted = redactSensitiveText(value);
	const bytes = new TextEncoder().encode(redacted);
	if (bytes.byteLength <= TOOL_FAILURE_TEXT_LIMIT_BYTES) return redacted;
	const prefix = new TextEncoder().encode(TRUNCATION_PREFIX);
	const tailLength = Math.max(0, TOOL_FAILURE_TEXT_LIMIT_BYTES - prefix.byteLength);
	let start = bytes.byteLength - tailLength;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	while (start < bytes.byteLength) {
		try {
			return TRUNCATION_PREFIX + decoder.decode(bytes.slice(start));
		} catch {
			start += 1;
		}
	}
	return TRUNCATION_PREFIX.slice(0, TOOL_FAILURE_TEXT_LIMIT_BYTES);
}

function safeErrorText(error: unknown): string {
	try {
		return String(error);
	} catch {
		return "Tool callback failed";
	}
}

export function normalizeWorkflowToolError(error: unknown): WorkflowToolError {
	error = selectProcessFailureError(error);
	const exitCode = safeField(error, "exitCode");
	const stdout = exposedText(error, "stdout");
	const stderr = exposedText(error, "stderr");
	let message: string;
	let name: string;
	try {
		message = errorMessage(error);
	} catch {
		message = safeErrorText(error);
	}
	try {
		name = errorName(error) ?? "Error";
	} catch {
		name = "Error";
	}
	return {
		name: boundedSafeToolFailureText(name),
		message: boundedSafeToolFailureText(message),
		...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
		...(stdout !== undefined ? { stdout: boundedSafeToolFailureText(stdout) } : {}),
		...(stderr !== undefined ? { stderr: boundedSafeToolFailureText(stderr) } : {}),
	};
}

export function workflowToolSuccess<TValue extends WorkflowSerializableValue>(
	value: TValue,
	attempts: number,
	cached: boolean,
): WorkflowToolSuccess<TValue> {
	return { ok: true, value, attempts, cached };
}

export function workflowToolFailure(error: unknown, attempts: number, cached: boolean): WorkflowToolFailure {
	return { ok: false, error: normalizeWorkflowToolError(error), attempts, cached };
}

export function workflowToolOutcomeFromValue<TValue extends WorkflowSerializableValue>(
	value: WorkflowSerializableValue,
): WorkflowToolOutcome<TValue> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, WorkflowSerializableValue>;
	if (!Number.isInteger(candidate.attempts) || typeof candidate.cached !== "boolean") return undefined;
	if (candidate.ok === true && "value" in candidate) return candidate as WorkflowToolSuccess<TValue>;
	const error = candidate.error;
	if (candidate.ok !== false || error === null || typeof error !== "object" || Array.isArray(error)) return undefined;
	const details = error as Record<string, WorkflowSerializableValue>;
	if (
		typeof details.name !== "string" ||
		typeof details.message !== "string" ||
		(details.exitCode !== undefined && !Number.isInteger(details.exitCode)) ||
		(details.stdout !== undefined && typeof details.stdout !== "string") ||
		(details.stderr !== undefined && typeof details.stderr !== "string")
	)
		return undefined;
	return candidate as WorkflowToolFailure;
}

export function replayedWorkflowToolOutcome<TValue extends WorkflowSerializableValue>(
	outcome: WorkflowToolOutcome<TValue>,
): WorkflowToolOutcome<TValue> {
	return { ...outcome, cached: true };
}
