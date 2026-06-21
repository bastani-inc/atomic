import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR, type NestedRouteInfo, type NestedRunSummary } from "../../shared/types.ts";
import { isSafeNestedPathId, parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_MAX_DEPTH,
} from "./pi-args.ts";
import { getEnvValue } from "@bastani/atomic";

export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
export const NESTED_RUNS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
export const ROUTE_FILE = "route.json";
export const REGISTRY_FILE = "registry.json";
export const MAX_NESTED_EVENT_BYTES = 64 * 1024;
export const MAX_NESTED_STEPS = 12;
export const MAX_NESTED_CHILDREN = 16;
export const MAX_NESTED_DEPTH = SUBAGENT_PARENT_MAX_DEPTH;
export const MAX_PROCESSED_NESTED_EVENTS = 20_000;
type NestedStatusEventType = "subagent.nested.started" | "subagent.nested.updated" | "subagent.nested.completed";
type NestedControlResultEventType = "subagent.nested.control-result";

export type NestedRoute = NestedRouteInfo;

export interface NestedEventRecord {
	type: NestedStatusEventType;
	ts: number;
	rootRunId: string;
	parentRunId: string;
	parentStepIndex?: number;
	capabilityToken: string;
	child: NestedRunSummary;
}

export interface NestedControlResultRecord {
	type: NestedControlResultEventType;
	ts: number;
	rootRunId: string;
	capabilityToken: string;
	requestId: string;
	targetRunId: string;
	ok: boolean;
	message: string;
}

export interface NestedControlRequestRecord {
	type: "subagent.nested.control-request";
	ts: number;
	rootRunId: string;
	capabilityToken: string;
	requestId: string;
	targetRunId: string;
	action: "interrupt" | "resume";
	message?: string;
}

export interface NestedRegistry {
	rootRunId: string;
	updatedAt: number;
	children: NestedRunSummary[];
	processedEvents: string[];
}

export function isSafeNestedId(value: unknown): value is string {
	return isSafeNestedPathId(value);
}

export function assertSafeNestedId(label: string, value: string): void {
	if (!isSafeNestedId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}

export function assertSafeId(label: string, value: string): void {
	assertSafeNestedId(label, value);
}

export function containedPath(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

export function commonRouteRoot(route: Pick<NestedRoute, "eventSink" | "controlInbox">): string {
	return path.dirname(path.resolve(route.eventSink));
}

export function validateNestedRouteShape(route: NestedRoute): void {
	assertSafeId("rootRunId", route.rootRunId);
	assertSafeId("capabilityToken", route.capabilityToken);
	if (!containedPath(NESTED_EVENTS_DIR, route.eventSink)) throw new Error("Nested event sink is outside the subagent nested event root.");
	if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox)) throw new Error("Nested control inbox is outside the subagent nested event root.");
	if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox))) throw new Error("Nested event sink and control inbox must share one route root.");
}

export function validateRouteShape(route: NestedRoute): void {
	validateNestedRouteShape(route);
}

export function createNestedRoute(rootRunId: string): NestedRoute {
	assertSafeId("rootRunId", rootRunId);
	const capabilityToken = randomUUID();
	const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
	const eventSink = path.join(routeRoot, "events");
	const controlInbox = path.join(routeRoot, "controls");
	fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
	fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(routeRoot, ROUTE_FILE), `${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`, { mode: 0o600 });
	return { rootRunId, eventSink, controlInbox, capabilityToken };
}

function newestMtimeMs(filePath: string): number {
	let newest = fs.statSync(filePath).mtimeMs;
	let entries: string[];
	try {
		entries = fs.readdirSync(filePath);
	} catch {
		return newest;
	}
	for (const entry of entries) {
		const childPath = path.join(filePath, entry);
		try {
			const stat = fs.statSync(childPath);
			newest = Math.max(newest, stat.isDirectory() ? newestMtimeMs(childPath) : stat.mtimeMs);
		} catch {
			// Nested runtime cleanup is best-effort housekeeping.
		}
	}
	return newest;
}

function cleanupOldSubdirectories(root: string, maxAgeDays: number): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	for (const entry of entries) {
		const entryPath = path.join(root, entry);
		try {
			if (newestMtimeMs(entryPath) < cutoff) fs.rmSync(entryPath, { recursive: true, force: true });
		} catch {
			// Keep startup resilient if a child process removes or rewrites an entry while scanning.
		}
	}
}

export function cleanupOldNestedRuntimeDirs(maxAgeDays: number): void {
	cleanupOldSubdirectories(NESTED_EVENTS_DIR, maxAgeDays);
	cleanupOldSubdirectories(NESTED_RUNS_DIR, maxAgeDays);
}

export function readSubagentEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (env === process.env) return getEnvValue(name);
	// Atomic keeps reading legacy pi-prefixed env vars so older parent processes can route nested children.
	const legacyName = name.replace(/^[A-Z0-9]+_/, "PI_");
	return env[name] ?? (legacyName === name ? undefined : env[legacyName]);
}

export function resolveNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	const rootRunId = readSubagentEnv(env, SUBAGENT_PARENT_ROOT_RUN_ID_ENV);
	const eventSink = readSubagentEnv(env, SUBAGENT_PARENT_EVENT_SINK_ENV);
	const controlInbox = readSubagentEnv(env, SUBAGENT_PARENT_CONTROL_INBOX_ENV);
	const capabilityToken = readSubagentEnv(env, SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV);
	if (!rootRunId || !eventSink || !controlInbox || !capabilityToken) return undefined;
	const route = { rootRunId, eventSink, controlInbox, capabilityToken };
	validateRouteShape(route);
	const routeFile = path.join(commonRouteRoot(route), ROUTE_FILE);
	const metadata = JSON.parse(fs.readFileSync(routeFile, "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
	if (metadata.rootRunId !== rootRunId || metadata.capabilityToken !== capabilityToken) {
		throw new Error("Nested event route metadata does not match the provided root id and capability token.");
	}
	return route;
}

export function resolveInheritedNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	try {
		return resolveNestedRouteFromEnv(env);
	} catch (error) {
		console.error("Ignoring invalid nested subagent event route:", error);
		return undefined;
	}
}

export function resolveNestedParentAddressFromEnv(env: NodeJS.ProcessEnv = process.env): { parentRunId: string; parentStepIndex?: number; depth: number; path: NestedPathEntry[] } | undefined {
	const parentRunId = readSubagentEnv(env, SUBAGENT_PARENT_RUN_ID_ENV);
	if (!isSafeNestedId(parentRunId)) return undefined;
	const rawIndex = readSubagentEnv(env, SUBAGENT_PARENT_CHILD_INDEX_ENV);
	const parentStepIndex = rawIndex && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
	const depth = Math.min(Math.max(1, clampNumber(Number(readSubagentEnv(env, SUBAGENT_PARENT_DEPTH_ENV))) ?? 1), MAX_NESTED_DEPTH);
	const parsedPath = parseNestedPathEnv(readSubagentEnv(env, SUBAGENT_PARENT_PATH_ENV));
	const nestedPath = parsedPath.length ? parsedPath : [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }];
	return { parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth, path: nestedPath };
}

export function resolveNestedAsyncDir(rootRunId: string, run: NestedRunSummary): string | undefined {
	if (!run.asyncDir) return undefined;
	const resolved = path.resolve(run.asyncDir);
	const nestedRoot = path.resolve(NESTED_RUNS_DIR, rootRunId, run.id);
	const relative = path.relative(nestedRoot, resolved);
	return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}

export function clampNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringValue(value: unknown, max = 512): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}
