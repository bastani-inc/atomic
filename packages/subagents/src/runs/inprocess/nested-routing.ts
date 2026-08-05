/**
 * In-process nested routing and control registry.
 *
 * Routes still expose the file-backed shape for compatibility with cold starts and
 * older sessions, but a live host registers the same route here. Live children are
 * addressed by their run id or canonical task path, so control never needs a
 * request file, an inherited capability-token environment variable, or a poller.
 */

export interface InProcessNestedRouteKey {
	readonly rootRunId: string;
	readonly capabilityToken: string;
}

export interface InProcessControlRequest {
	readonly type: "subagent.nested.control-request";
	readonly rootRunId: string;
	readonly capabilityToken: string;
	readonly ts: number;
	readonly requestId: string;
	readonly targetRunId: string;
	readonly action: "interrupt" | "resume";
	readonly message?: string;
	readonly filePath: string;
}

export interface InProcessControlResult {
	readonly ts: number;
	readonly requestId: string;
	readonly targetRunId: string;
	readonly ok: boolean;
	readonly message: string;
	readonly filePath?: string;
}

export interface InProcessNestedResumeOutcome {
	readonly status: "ok" | "error" | "interrupted" | "continued";
	readonly path: string;
	readonly sessionFile?: string;
	readonly envelope?: string;
}

export interface InProcessNestedAttemptHandle {
	readonly runId: string;
	readonly path: string;
	readonly status: () => string;
	readonly interrupt: () => Promise<void>;
	readonly resume: (message: string) => Promise<InProcessNestedResumeOutcome>;
}

interface RouteState {
	readonly key: InProcessNestedRouteKey;
	readonly events: object[];
	readonly controlRequests: Map<string, InProcessControlRequest>;
	readonly controlResults: Map<string, InProcessControlResult>;
	readonly listeners: Set<(request: InProcessControlRequest) => void | Promise<void>>;
}

const routeStates = new Map<string, RouteState>();
const attemptHandles = new Map<string, Map<string, InProcessNestedAttemptHandle>>();

function routeKey(route: InProcessNestedRouteKey): string {
	return `${route.rootRunId}\u0000${route.capabilityToken}`;
}

function attemptKey(id: string): string {
	return id.trim();
}

function stateFor(route: InProcessNestedRouteKey): RouteState | undefined {
	return routeStates.get(routeKey(route));
}

export function registerInProcessNestedRoute(route: InProcessNestedRouteKey): void {
	const key = routeKey(route);
	if (!routeStates.has(key)) {
		routeStates.set(key, {
			key: { rootRunId: route.rootRunId, capabilityToken: route.capabilityToken },
			events: [],
			controlRequests: new Map(),
			controlResults: new Map(),
			listeners: new Set(),
		});
	}
}

export function unregisterInProcessNestedRoute(route: InProcessNestedRouteKey): void {
	routeStates.delete(routeKey(route));
}

export function hasInProcessNestedRoute(route: InProcessNestedRouteKey): boolean {
	return stateFor(route) !== undefined;
}

export function appendInProcessNestedEvent(route: InProcessNestedRouteKey, event: object): void {
	const state = stateFor(route);
	if (!state) return;
	state.events.push(event);
	if (state.events.length > 20_000) state.events.splice(0, state.events.length - 20_000);
}

export function readInProcessNestedEvents(route: InProcessNestedRouteKey): readonly object[] {
	return stateFor(route)?.events ?? [];
}

export function appendInProcessControlRequest(route: InProcessNestedRouteKey, request: InProcessControlRequest): void {
	const state = stateFor(route);
	if (!state) return;
	state.controlRequests.set(request.requestId, request);
	for (const listener of state.listeners) queueMicrotask(() => void listener(request));
}

export function readInProcessControlRequests(route: InProcessNestedRouteKey): readonly InProcessControlRequest[] {
	return stateFor(route) ? [...stateFor(route)!.controlRequests.values()] : [];
}

export function removeInProcessControlRequest(route: InProcessNestedRouteKey, requestId: string): void {
	stateFor(route)?.controlRequests.delete(requestId);
}

export function appendInProcessControlResult(route: InProcessNestedRouteKey, result: InProcessControlResult): void {
	const state = stateFor(route);
	if (!state) return;
	state.controlResults.set(result.requestId, result);
}

export function readInProcessControlResults(route: InProcessNestedRouteKey): readonly InProcessControlResult[] {
	return stateFor(route) ? [...stateFor(route)!.controlResults.values()] : [];
}

export function subscribeInProcessControlRequests(
	route: InProcessNestedRouteKey,
	listener: (request: InProcessControlRequest) => void | Promise<void>,
): (() => void) | undefined {
	const state = stateFor(route);
	if (!state) return undefined;
	state.listeners.add(listener);
	for (const request of state.controlRequests.values()) queueMicrotask(() => void listener(request));
	return () => state.listeners.delete(listener);
}

export function registerInProcessNestedAttempt(handle: InProcessNestedAttemptHandle): () => void {
	const key = attemptKey(handle.runId);
	let handles = attemptHandles.get(key);
	if (!handles) {
		handles = new Map();
		attemptHandles.set(key, handles);
	}
	handles.set(handle.path, handle);
	const pathKey = attemptKey(handle.path);
	if (pathKey !== key) {
		let byPath = attemptHandles.get(pathKey);
		if (!byPath) {
			byPath = new Map();
			attemptHandles.set(pathKey, byPath);
		}
		byPath.set(handle.path, handle);
	}
	return () => {
		for (const lookupKey of [key, pathKey]) {
			const current = attemptHandles.get(lookupKey);
			if (!current || current.get(handle.path) !== handle) continue;
			current.delete(handle.path);
			if (current.size === 0) attemptHandles.delete(lookupKey);
		}
	};
}

function handlesFor(id: string): InProcessNestedAttemptHandle[] {
	return [...(attemptHandles.get(attemptKey(id))?.values() ?? [])];
}

export interface InProcessNestedControlResult {
	readonly ok: boolean;
	readonly message: string;
	readonly outcome?: InProcessNestedResumeOutcome;
}

export async function interruptInProcessNestedAttempt(
	targetId: string,
): Promise<InProcessNestedControlResult | undefined> {
	const handles = handlesFor(targetId);
	if (handles.length === 0) return undefined;
	const active = handles.filter((handle) => handle.status() === "running" || handle.status() === "continued");
	if (active.length === 0) {
		return { ok: false, message: `Nested run ${targetId} has no active child attempt to interrupt.` };
	}
	await Promise.all(active.map((handle) => handle.interrupt()));
	return { ok: true, message: `Interrupt requested for nested run ${targetId}.` };
}

export async function resumeInProcessNestedAttempt(
	targetId: string,
	message: string,
): Promise<InProcessNestedControlResult | undefined> {
	const handles = handlesFor(targetId);
	if (handles.length === 0) return undefined;
	const handle =
		handles.find((candidate) => candidate.status() === "interrupted" || candidate.status() === "error") ?? handles[0];
	if (!handle) return undefined;
	if (handle.status() === "running" || handle.status() === "continued") {
		return { ok: false, message: `Nested run ${targetId} is still running; resume is not required.` };
	}
	const outcome = await handle.resume(message);
	return {
		ok: outcome.status === "ok" || outcome.status === "continued",
		message:
			outcome.status === "ok"
				? `Reloaded nested run ${targetId} through the in-process control plane.`
				: `Nested run ${targetId} resume ended with status '${outcome.status}'.`,
		outcome,
	};
}

export function clearInProcessNestedRouting(): void {
	routeStates.clear();
	attemptHandles.clear();
}
