import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NestedRunSummary } from "../../shared/types.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
	MAX_NESTED_EVENT_BYTES,
	MAX_PROCESSED_NESTED_EVENTS,
	NESTED_EVENTS_DIR,
	REGISTRY_FILE,
	ROUTE_FILE,
	assertSafeId,
	commonRouteRoot,
	containedPath,
	validateRouteShape,
	type NestedEventRecord,
	type NestedRegistry,
	type NestedRoute,
} from "./nested-events-core.ts";
import { applyNestedEvent, parseNestedEventRecords, parseRecord, sanitizeSummary } from "./nested-events-sanitize.ts";

const REGISTRY_LOCK_DIR = ".registry.lock";
const REGISTRY_LOCK_TIMEOUT_MS = 2_000;
const REGISTRY_LOCK_STALE_MS = 30_000;
const REGISTRY_LOCK_POLL_MS = 10;

function registryPath(route: NestedRoute): string {
	return path.join(commonRouteRoot(route), REGISTRY_FILE);
}

function registryLockPath(route: NestedRoute): string {
	return path.join(commonRouteRoot(route), REGISTRY_LOCK_DIR);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRegistryLock(route: NestedRoute): () => void {
	const lockPath = registryLockPath(route);
	const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			try {
				fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, { mode: 0o600 });
			} catch {
				// Lock ownership metadata is diagnostic only.
			}
			return () => fs.rmSync(lockPath, { recursive: true, force: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > REGISTRY_LOCK_STALE_MS) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for nested registry lock for root '${route.rootRunId}'.`);
			sleepSync(REGISTRY_LOCK_POLL_MS);
		}
	}
}

export function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined {
	assertSafeId("rootRunId", rootRunId);
	let entries: string[];
	try {
		entries = fs.readdirSync(NESTED_EVENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${rootRunId}-`)) continue;
		const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
			if (metadata.rootRunId !== rootRunId || typeof metadata.capabilityToken !== "string") continue;
			const route = {
				rootRunId,
				eventSink: path.join(routeRoot, "events"),
				controlInbox: path.join(routeRoot, "controls"),
				capabilityToken: metadata.capabilityToken,
			};
			validateRouteShape(route);
			return route;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Ignoring unreadable nested route metadata under '${routeRoot}':`, error);
			}
			continue;
		}
	}
	return undefined;
}

export function projectNestedRegistryForRoot(rootRunId: string): NestedRegistry | undefined {
	const route = findNestedRouteForRootId(rootRunId);
	return route ? projectNestedEvents(route) : undefined;
}

export function findNestedRun(children: NestedRunSummary[] | undefined, id: string): NestedRunSummary | undefined {
	if (!children?.length) return undefined;
	for (const child of children) {
		if (child.id === id) return child;
		const nested = findNestedRun(child.children, id) ?? findNestedRun(child.steps?.flatMap((step) => step.children ?? []), id);
		if (nested) return nested;
	}
	return undefined;
}

export interface NestedRunMatch {
	rootRunId: string;
	route: NestedRoute;
	run: NestedRunSummary;
}

export interface NestedRunResolutionScope {
	routes: NestedRoute[];
	descendantOf?: { parentRunId: string; parentStepIndex?: number };
}

function collectNestedRuns(children: NestedRunSummary[] | undefined, output: NestedRunSummary[] = []): NestedRunSummary[] {
	for (const child of children ?? []) {
		output.push(child);
		collectNestedRuns(child.children, output);
		collectNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output);
	}
	return output;
}

function collectScopedNestedRuns(children: NestedRunSummary[] | undefined, scope: NestedRunResolutionScope["descendantOf"], output: NestedRunSummary[] = []): NestedRunSummary[] {
	if (!scope) return collectNestedRuns(children, output);
	for (const child of children ?? []) {
		if (child.parentRunId === scope.parentRunId && (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)) {
			collectNestedRuns([child], output);
			continue;
		}
		collectScopedNestedRuns(child.children, scope, output);
		collectScopedNestedRuns(child.steps?.flatMap((step) => step.children ?? []), scope, output);
	}
	return output;
}

function listNestedRoutes(): NestedRoute[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(NESTED_EVENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const routes: NestedRoute[] = [];
	for (const entry of entries) {
		const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
		try {
			const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown; capabilityToken?: unknown };
			if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string") continue;
			const route = {
				rootRunId: metadata.rootRunId,
				eventSink: path.join(routeRoot, "events"),
				controlInbox: path.join(routeRoot, "controls"),
				capabilityToken: metadata.capabilityToken,
			};
			validateRouteShape(route);
			routes.push(route);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Ignoring unreadable nested route metadata under '${routeRoot}':`, error);
			}
			continue;
		}
	}
	return routes;
}

export function findNestedRunMatchesById(id: string, options: { prefix?: boolean; scope?: NestedRunResolutionScope } = {}): NestedRunMatch[] {
	assertSafeId("id", id);
	const matches: NestedRunMatch[] = [];
	for (const route of options.scope?.routes ?? listNestedRoutes()) {
		try {
			const registry = projectNestedEvents(route);
			for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
				if (options.prefix ? run.id.startsWith(id) : run.id === id) matches.push({ rootRunId: route.rootRunId, route, run });
			}
		} catch {
			continue;
		}
	}
	return matches;
}

export function findNestedRunById(id: string): { rootRunId: string; run: NestedRunSummary } | undefined {
	const match = findNestedRunMatchesById(id)[0];
	return match ? { rootRunId: match.rootRunId, run: match.run } : undefined;
}

export function readNestedRegistry(route: NestedRoute): NestedRegistry {
	validateRouteShape(route);
	try {
		const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf-8")) as NestedRegistry;
		return {
			rootRunId: route.rootRunId,
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
			children: Array.isArray(parsed.children) ? parsed.children.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child)) : [],
			processedEvents: Array.isArray(parsed.processedEvents) ? parsed.processedEvents.filter((item): item is string => typeof item === "string").slice(-MAX_PROCESSED_NESTED_EVENTS) : [],
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] };
	}
}

export function projectNestedEvents(route: NestedRoute): NestedRegistry {
	validateRouteShape(route);
	const release = acquireRegistryLock(route);
	try {
		let registry = readNestedRegistry(route);
		const seen = new Set(registry.processedEvents);
		let changed = false;
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(route.eventSink).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl")).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const entry of entries) {
			if (seen.has(entry)) continue;
			const eventPath = path.join(route.eventSink, entry);
			if (!containedPath(route.eventSink, eventPath)) continue;
			let content: string;
			try {
				const stat = fs.statSync(eventPath);
				if (!stat.isFile() || stat.size > MAX_NESTED_EVENT_BYTES) continue;
				content = fs.readFileSync(eventPath, "utf-8");
			} catch {
				continue;
			}
			for (const event of parseNestedEventRecords(content, route)) {
				registry = applyNestedEvent(registry, event);
				changed = true;
			}
			seen.add(entry);
			changed = true;
		}
		if (changed) {
			// Event files are immutable; retain enough filenames for worst-case bounded fanout without unbounded registry growth.
			registry = { ...registry, processedEvents: [...seen].slice(-MAX_PROCESSED_NESTED_EVENTS) };
			// Registry projection is lock-serialized across parent and fanout-child processes.
			// Child and runner processes only create immutable event files, so parent status.json
			// remains owned by the existing runner writer and is never rewritten here.
			writeAtomicJson(registryPath(route), registry);
		}
		return registry;
	} finally {
		release();
	}
}

export function writeRouteRecord(dir: string, ts: number, payload: object): string {
	const content = `${JSON.stringify(payload)}\n`;
	if (Buffer.byteLength(content, "utf-8") > MAX_NESTED_EVENT_BYTES) throw new Error("Nested route record exceeds the maximum size.");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name = `${String(ts).padStart(13, "0")}-${randomUUID()}.json`;
	const tmp = path.join(dir, `.${name}.tmp`);
	const finalPath = path.join(dir, name);
	fs.writeFileSync(tmp, content, { mode: 0o600 });
	fs.renameSync(tmp, finalPath);
	return finalPath;
}

export function writeNestedEvent(route: NestedRoute, event: Omit<NestedEventRecord, "rootRunId" | "capabilityToken">): void {
	// Child and runner processes append immutable route events; parent projection owns registry/status aggregation.
	validateRouteShape(route);
	const record: NestedEventRecord = {
		...event,
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
	};
	const sanitized = parseRecord(JSON.stringify(record), route);
	if (!sanitized) throw new Error("Nested event record failed validation.");
	writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}
