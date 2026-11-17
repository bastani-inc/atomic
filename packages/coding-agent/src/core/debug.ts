import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ENV_DEBUG, getDebugLogPath, getEnvNames } from "../config.js";
import { redactCredentialShapes } from "../utils/credential-redaction.js";
import { DebugLogUnwritableError } from "./debug-errors.ts";
import { isDebugSettingOn } from "./debug-setting.ts";

/** A diagnostic area. Each is on in debug mode, or while its own environment variable is set. */
export type DebugArea = "workflow" | "decision" | "pooled-watch" | "pool" | "storage" | "engine";

/** Each area's own environment variable; `decision`, `pool`, `storage` and `engine` have none. */
export const DEBUG_AREA_VARIABLES: Readonly<Record<DebugArea, string | undefined>> = {
	workflow: "ATOMIC_WORKFLOW_DEBUG",
	decision: undefined,
	"pooled-watch": "ATOMIC_DEBUG_POOLED_WATCH",
	pool: undefined,
	storage: undefined,
	engine: undefined,
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
	const debug = getEnvNames(ENV_DEBUG)
		.map((name) => env[name])
		.find((value) => value !== undefined);
	return isDebugSettingOn() || debug === "1";
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

interface PendingLine {
	readonly path: string;
	readonly line: string;
}

/** Lines reported and not yet appended, each with its file, in the order they were reported. */
const pendingLines: PendingLine[] = [];
/** The line being appended, until its append has finished. */
let appending: PendingLine | undefined;
/** The appends in progress, while there are any. */
let draining: Promise<void> | undefined;
let exitFlushRegistered = false;

/**
 * Appends `line` to the file at `path` without blocking the event loop: lines are appended in the order they were
 * reported, and those still waiting when the process exits are written then.
 */
function appendLine(path: string, line: string): void {
	pendingLines.push({ path, line });
	if (!exitFlushRegistered) {
		exitFlushRegistered = true;
		process.once("exit", () => writePendingLinesSync());
	}
	draining ??= drainPendingLines();
}

async function drainPendingLines(): Promise<void> {
	try {
		for (appending = pendingLines.shift(); appending !== undefined; appending = pendingLines.shift()) {
			const { path, line } = appending;
			try {
				await mkdir(dirname(path), { recursive: true });
				await appendFile(path, `${line}\n`);
			} catch (error) {
				recordFailure(path, error);
			}
		}
	} finally {
		appending = undefined;
		draining = undefined;
	}
}

/**
 * Writes the lines still waiting as the process exits, when nothing can wait for them any longer: the one being
 * appended first, since its append cannot finish once the process exits.
 */
function writePendingLinesSync(): void {
	if (appending !== undefined) pendingLines.unshift(appending);
	appending = undefined;
	for (let next = pendingLines.shift(); next !== undefined; next = pendingLines.shift()) {
		try {
			mkdirSync(dirname(next.path), { recursive: true });
			appendFileSync(next.path, `${next.line}\n`);
		} catch (error) {
			recordFailure(next.path, error);
		}
	}
}

function recordFailure(path: string, error: unknown): void {
	if (debugLogFailure !== undefined) return;
	debugLogFailure = new DebugLogUnwritableError(path, { cause: error });
	console.warn(debugLogFailure.message);
}

/** Resolves once every debug record reported so far is in its file, or its failure is recorded. */
export async function flushDebugLog(): Promise<void> {
	while (draining !== undefined) await draining;
}

/**
 * Appends `record` to the debug output file `path` as one JSON line, with credentials redacted, without blocking: it is
 * in the file once {@link flushDebugLog} resolves. A failure is recorded once (see {@link getDebugLogFailure}), never
 * thrown.
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
