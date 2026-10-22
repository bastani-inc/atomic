import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import { isWorkflowRuntimeFrame, normalizeStackPath, parsePromptStackFrame } from "../runs/shared/prompt-callsite.js";
import type { StageContext } from "../shared/types.js";

export type RejectionEffect = "fail-run" | "ignore";

export interface RunRejectionScope {
	run<T>(callback: () => T): T;
	contain<T>(promise: Promise<T>, effect?: RejectionEffect): Promise<T>;
	settle(): Promise<void>;
	close(): void;
}

export interface RunRejectionScopeOptions {
	readonly source?: string;
	readonly fail: (error: object) => void;
}

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

interface ScopeState {
	readonly source: string | undefined;
	fail: (error: object) => void;
	readonly primitives: Map<Primitive, RejectionEffect>;
	live: boolean;
}

type Attribution = Map<ScopeState, RejectionEffect>;

const EVENT = "unhandledRejection";
const BOUNDARY_KEY = Symbol.for("atomic-workflows/run-rejection-boundary@2");
const FLAG = "--unhandled-rejections";
const MAX_CAUSE_DEPTH = 8;
const MAX_PRIMITIVES_PER_RUN = 64;
const NATIVE_REPORTING_MODES: ReadonlySet<string> = new Set(["throw", "warn-with-error-code"]);

interface RejectionBoundary {
	readonly version: 2;
	readonly store: AsyncLocalStorage<ScopeState>;
	readonly owners: WeakMap<object, Attribution>;
	readonly scopes: Set<ScopeState>;
	readonly sources: Set<string>;
	listener: ((reason: unknown) => void) | undefined;
}

function boundaryBag(): Record<symbol, RejectionBoundary | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RejectionBoundary | undefined>;
}

function sharedBoundary(): RejectionBoundary {
	const bag = boundaryBag();
	const existing = bag[BOUNDARY_KEY];
	if (existing !== undefined && existing.version === 2) return existing;
	const created: RejectionBoundary = {
		version: 2,
		store: new AsyncLocalStorage(),
		owners: new WeakMap(),
		scopes: new Set(),
		sources: new Set(),
		listener: undefined,
	};
	bag[BOUNDARY_KEY] = created;
	return created;
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isPrimitive(value: unknown): value is Primitive {
	return !isObject(value);
}

function safeField(value: object, key: "cause" | "errors" | "stack"): unknown {
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

function strongerEffect(left: RejectionEffect | undefined, right: RejectionEffect): RejectionEffect {
	return left === "fail-run" || right === "fail-run" ? "fail-run" : "ignore";
}

function addAttribution(into: Attribution, scope: ScopeState, effect: RejectionEffect): void {
	into.set(scope, strongerEffect(into.get(scope), effect));
}

function recordedOwners(boundary: RejectionBoundary, reason: unknown): Attribution {
	const found: Attribution = new Map();
	const seen = new Set<object>();
	const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: reason, depth: 0 }];
	while (pending.length > 0) {
		const { value, depth } = pending.pop()!;
		if (depth > MAX_CAUSE_DEPTH) continue;
		if (isPrimitive(value)) {
			if (depth === 0 || (value !== undefined && value !== null)) {
				for (const scope of boundary.scopes) {
					const effect = scope.primitives.get(value);
					if (effect !== undefined) addAttribution(found, scope, effect);
				}
			}
			continue;
		}
		if (seen.has(value)) continue;
		seen.add(value);
		for (const [scope, effect] of boundary.owners.get(value) ?? []) addAttribution(found, scope, effect);
		pending.push({ value: safeField(value, "cause"), depth: depth + 1 });
		const errors = safeField(value, "errors");
		if (Array.isArray(errors)) for (const entry of errors) pending.push({ value: entry, depth: depth + 1 });
	}
	return found;
}

function authoringSource(reason: unknown, sources: ReadonlySet<string>): string | undefined {
	if (!isObject(reason)) return undefined;
	const stack = safeField(reason, "stack");
	if (typeof stack !== "string") return undefined;
	for (const line of stack.split("\n")) {
		if (!line.trimStart().startsWith("at ")) continue;
		const path = parsePromptStackFrame(line)?.normalizedPath;
		if (path === undefined || /\/node_modules\//.test(path)) continue;
		if (sources.has(path)) return path;
		if (isWorkflowRuntimeFrame(path)) return undefined;
	}
	return undefined;
}

function attribute(boundary: RejectionBoundary, reason: unknown): Attribution | undefined {
	const recorded = recordedOwners(boundary, reason);
	if (recorded.size > 0) return recorded;
	const scoped = boundary.store.getStore();
	if (scoped !== undefined && boundary.scopes.has(scoped)) return new Map([[scoped, "fail-run"]]);
	const origin = authoringSource(reason, boundary.sources);
	if (origin === undefined) return undefined;
	const owners: Attribution = new Map();
	for (const scope of boundary.scopes) if (scope.source === origin) owners.set(scope, "fail-run");
	return owners;
}

function unhandledRejectionError(reason: unknown): Error {
	return Object.assign(
		new Error(
			"This error originated either by throwing inside of an async function without a catch block, " +
				`or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${inspect(reason)}".`,
		),
		{ code: "ERR_UNHANDLED_REJECTION" },
	);
}

function unhandledRejectionsMode(): string {
	const args = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
	let mode = "throw";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg.startsWith(`${FLAG}=`)) mode = arg.slice(FLAG.length + 1);
		else if (arg === FLAG && args[index + 1] !== undefined) mode = args[index + 1] ?? mode;
	}
	return mode;
}

function surfaceNatively(boundary: RejectionBoundary, reason: unknown): void {
	const listener = boundary.listener;
	if (listener === undefined || process.listenerCount(EVENT) > 1) return;
	if (!NATIVE_REPORTING_MODES.has(unhandledRejectionsMode())) return;
	process.nextTick(() => {
		process.removeListener(EVENT, listener);
		void Promise.reject(reason);
		setImmediate(() => {
			if (!process.listeners(EVENT).includes(listener)) process.on(EVENT, listener);
		});
	});
}

function onUnhandledRejection(reason: unknown): void {
	const boundary = sharedBoundary();
	const owners = attribute(boundary, reason);
	if (owners === undefined) {
		surfaceNatively(boundary, reason);
		return;
	}
	const error = isObject(reason) ? reason : unhandledRejectionError(reason);
	for (const [scope, effect] of owners) {
		if (effect !== "fail-run" || !scope.live) continue;
		try {
			scope.fail(error);
		} catch {}
	}
}

function ensureInstalled(boundary: RejectionBoundary): void {
	if (boundary.listener !== undefined) return;
	boundary.listener = onUnhandledRejection;
	process.on(EVENT, onUnhandledRejection);
}

function record(boundary: RejectionBoundary, scope: ScopeState, reason: unknown, effect: RejectionEffect): void {
	if (isPrimitive(reason)) {
		recordPrimitive(scope, reason, effect);
		return;
	}
	const owners = boundary.owners.get(reason);
	if (owners === undefined) boundary.owners.set(reason, new Map([[scope, effect]]));
	else addAttribution(owners, scope, effect);
}

function recordPrimitive(scope: ScopeState, reason: Primitive, effect: RejectionEffect): void {
	if (!scope.live) return;
	if (scope.primitives.size >= MAX_PRIMITIVES_PER_RUN && !scope.primitives.has(reason)) {
		const oldest = scope.primitives.keys().next();
		if (!oldest.done) scope.primitives.delete(oldest.value);
	}
	scope.primitives.set(reason, strongerEffect(scope.primitives.get(reason), effect));
}

function discardFailure(): void {}

function afterPendingRejectionReports(): Promise<void> {
	return new Promise((resolve) => {
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {
			port1.close();
			port2.close();
			resolve();
		};
		port2.postMessage(undefined);
	});
}

export function openRunRejectionScope(options: RunRejectionScopeOptions): RunRejectionScope {
	const boundary = sharedBoundary();
	ensureInstalled(boundary);
	const source = options.source === undefined ? undefined : normalizeStackPath(options.source);
	const scope: ScopeState = {
		source,
		fail: options.fail,
		primitives: new Map(),
		live: true,
	};
	boundary.scopes.add(scope);
	if (source !== undefined) boundary.sources.add(source);
	return {
		run: (callback) => boundary.store.run(scope, callback),
		contain: (promise, effect = "fail-run") => {
			void promise.then(undefined, (reason: unknown) => record(boundary, scope, reason, effect));
			return promise;
		},
		settle: afterPendingRejectionReports,
		close: () => {
			scope.live = false;
			scope.fail = discardFailure;
			void afterPendingRejectionReports().then(() => {
				scope.primitives.clear();
				boundary.scopes.delete(scope);
			});
		},
	};
}

export function containStageRejections<T extends StageContext>(stage: T, scope: RunRejectionScope): T {
	const contained = Object.create(stage) as T;
	Object.defineProperties(contained, {
		prompt: { value: (...args: Parameters<StageContext["prompt"]>) => scope.contain(stage.prompt(...args)) },
		complete: { value: (...args: Parameters<StageContext["complete"]>) => scope.contain(stage.complete(...args)) },
	});
	return contained;
}
