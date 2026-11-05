import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ENV_DEBUG, getDebugLogPath, getEnvNames } from "../config.js";
import { redactCredentialShapes } from "../utils/credential-redaction.js";
import { DebugLogUnwritableError } from "./debug-errors.ts";
import { isDebugSettingOn } from "./debug-setting.ts";

/** A diagnostic area. Each is on in debug mode, or while its own environment variable is set. */
export type DebugArea = "workflow" | "model-routing" | "pooled-watch" | "pool";

/** Each area's own environment variable; `pool` has none. */
export const DEBUG_AREA_VARIABLES: Readonly<Record<DebugArea, string | undefined>> = {
	workflow: "ATOMIC_WORKFLOW_DEBUG",
	"model-routing": "ATOMIC_MODEL_ROUTING_DEBUG",
	"pooled-watch": "ATOMIC_DEBUG_POOLED_WATCH",
	pool: undefined,
};

export type DebugValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type DebugFields = Readonly<Record<string, DebugValue>>;

const MAX_DEBUG_TEXT_LENGTH = 2_000;

let debugLogFailure: DebugLogUnwritableError | undefined;

/** The value of `area`'s own variable while it turns the area on, such as a trace file path. */
function areaVariableValue(area: DebugArea, env: NodeJS.ProcessEnv): string | undefined {
	const name = DEBUG_AREA_VARIABLES[area];
	if (name === undefined) return undefined;
	const value = env[name];
	if (area === "pooled-watch") return value === "" || value === "0" ? undefined : value;
	return value === "1" ? value : undefined;
}

function isDebugModeOn(env: NodeJS.ProcessEnv): boolean {
	return isDebugSettingOn() || getEnvNames(ENV_DEBUG).some((name) => env[name] === "1");
}

/**
 * Whether debug output is on: everywhere when the `debug` setting, `--debug` or `ATOMIC_DEBUG=1` is on, and for
 * `area` also while its own environment variable is set. Without `area`, only the first three count.
 */
export function isDebugEnabled(area?: DebugArea, env: NodeJS.ProcessEnv = process.env): boolean {
	return isDebugModeOn(env) || (area !== undefined && areaVariableValue(area, env) !== undefined);
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

function appendLine(path: string, line: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${line}\n`);
	} catch (error) {
		if (debugLogFailure !== undefined) return;
		debugLogFailure = new DebugLogUnwritableError(path, { cause: error });
		console.warn(debugLogFailure.message);
	}
}

/**
 * Appends `record` to the debug output file `path` as one JSON line, with credentials redacted. A failure is recorded
 * once (see {@link getDebugLogFailure}), never thrown.
 */
export function appendDebugRecord(path: string, record: DebugFields): void {
	appendLine(path, JSON.stringify(safeFields(record)));
}

function appendDebugLog(area: DebugArea, event: string, fields: DebugFields): void {
	const record = { at: new Date().toISOString(), pid: process.pid, area, event, data: safeFields(fields) };
	appendLine(getDebugLogPath(), JSON.stringify(record));
}

/**
 * Records one diagnostic event of `area`. In debug mode it is appended to the debug log that `/debug` shows, with
 * credentials redacted. While the area's own variable is set, `ownOutput` also writes it where that variable always
 * has, and receives the variable's value.
 */
export function reportDebug(
	area: DebugArea,
	event: string,
	fields: DebugFields,
	ownOutput?: (variable: string) => void,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (isDebugModeOn(env)) appendDebugLog(area, event, fields);
	const own = areaVariableValue(area, env);
	if (ownOutput !== undefined && own !== undefined) ownOutput(own);
}

/** The first failure to write a debug log file in this process, if any. Later records are still attempted. */
export function getDebugLogFailure(): DebugLogUnwritableError | undefined {
	return debugLogFailure;
}
