import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ENV_DEBUG, getDebugLogPath, getEnvNames } from "../config.js";
import { redactCredentialShapes } from "../utils/credential-redaction.js";
import { DebugLogUnwritableError } from "./debug-errors.ts";
import { isDebugSettingOn } from "./debug-setting.ts";
import { DiagnosticWriter } from "./diagnostic-writer.ts";

/** Diagnostic areas written to the debug log when debug mode is on. */
export type DebugArea = "decision" | "storage" | "engine";

/** No remaining area has a separate environment switch. */
export const DEBUG_AREA_VARIABLES: Readonly<Record<DebugArea, string | undefined>> = {
	decision: undefined,
	storage: undefined,
	engine: undefined,
};

export type DebugValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type DebugFields = Readonly<Record<string, DebugValue>>;

const MAX_DEBUG_TEXT_LENGTH = 2_000;

let debugLogFailure: DebugLogUnwritableError | undefined;

/** Whether debug mode is on through settings, `--debug`, or `ATOMIC_DEBUG=1`. */
export function isDebugEnabled(_area?: DebugArea, env: NodeJS.ProcessEnv = process.env): boolean {
	const debug = getEnvNames(ENV_DEBUG)
		.map((name) => env[name])
		.find((value) => value !== undefined);
	return isDebugSettingOn() || debug === "1";
}

function safeText(text: string): string {
	const redacted = redactCredentialShapes(text);
	return redacted.length > MAX_DEBUG_TEXT_LENGTH ? `${redacted.slice(0, MAX_DEBUG_TEXT_LENGTH)}…` : redacted;
}

function safeValue(value: DebugValue): DebugValue {
	if (typeof value === "string") return safeText(value);
	if (typeof value === "object" && value !== null)
		return value.map((item) => (typeof item === "string" ? safeText(item) : item));
	return value;
}

function safeFields(fields: DebugFields): Record<string, DebugValue> {
	return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, safeValue(value)]));
}

const writer = new DiagnosticWriter(recordFailure, true);
let exitFlushRegistered = false;

function appendLine(path: string, line: string): Promise<void> {
	if (!exitFlushRegistered) {
		exitFlushRegistered = true;
		process.once("exit", () => writer.flushSync());
	}
	return writer.append(path, `${line}\n`);
}

function appendLineSync(path: string, line: string): void {
	writer.flushSync();
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${line}\n`);
	} catch (error) {
		recordFailure(path, error);
	}
}

function recordFailure(path: string, error: unknown): void {
	if (debugLogFailure !== undefined) return;
	debugLogFailure = new DebugLogUnwritableError(path, { cause: error });
	console.warn(debugLogFailure.message);
}

export async function flushDebugLog(): Promise<void> {
	await writer.written();
}

export function appendDebugRecord(path: string, record: DebugFields): void {
	appendLineSync(path, JSON.stringify(safeFields(record)));
}

export function appendDebugRecordAsync(path: string, record: DebugFields): Promise<void> {
	return appendLine(path, JSON.stringify(safeFields(record)));
}

function debugLogLine(area: DebugArea, event: string, fields: DebugFields): string {
	return JSON.stringify({ at: new Date().toISOString(), pid: process.pid, area, event, data: safeFields(fields) });
}

/** In debug mode, append a redacted diagnostic event to the log that `/debug` shows. */
export function reportDebug(
	area: DebugArea,
	event: string,
	fields: DebugFields,
	_ownOutput?: (variable: string) => void,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (isDebugEnabled(area, env)) appendLineSync(getDebugLogPath(), debugLogLine(area, event, fields));
}

export function reportDebugAsync(
	area: DebugArea,
	event: string,
	fields: DebugFields,
	_ownOutput?: (variable: string) => void,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	return isDebugEnabled(area, env)
		? appendLine(getDebugLogPath(), debugLogLine(area, event, fields))
		: Promise.resolve();
}

/** The first failure to write a debug log file in this process, if any. Later records are still attempted. */
export function getDebugLogFailure(): DebugLogUnwritableError | undefined {
	return debugLogFailure;
}

/** The debug fields that name a failure a fallback absorbed: its class, stable code, message and first cause (#4660). */
export function failureDebugFields(error: unknown): DebugFields {
	if (!(error instanceof Error)) return { message: String(error) };
	const { code } = error as Error & { code?: unknown };
	const { cause } = error;
	return {
		name: error.name,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
		message: error.message,
		cause:
			cause instanceof Error ? `${cause.name}: ${cause.message}` : cause === undefined ? undefined : String(cause),
	};
}
