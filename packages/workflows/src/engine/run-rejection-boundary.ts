import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import { normalizeStackPath, parsePromptStackFrame } from "../runs/shared/prompt-callsite.js";
import type { StageContext, WorkflowUIContext } from "../shared/types.js";
import { isWorkflowRuntimeModule } from "../shared/workflow-source.js";

export type RejectionEffect = "fail-run" | "ignore";

export type StopReason = object | string;

export interface RunRejectionScope {
	run<T>(callback: () => T): T;
	contain<T>(promise: Promise<T>, effect?: RejectionEffect): Promise<T>;
	watch<T>(promise: Promise<T>): Promise<T>;
	ignore(reason: StopReason): void;
	settle(): Promise<void>;
	close(): void;
}

export interface RunRejectionScopeOptions {
	readonly runId: string;
	readonly parentRunId?: string;
	readonly source?: string;
	readonly fail: (error: object) => void;
}

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

interface PrimitiveEntry {
	readonly effect: RejectionEffect;
	readonly generation: number;
}

interface ScopeState {
	readonly runId: string;
	readonly source: string | undefined;
	parent: ScopeState | undefined;
	fail: (error: object) => void;
	readonly primitives: Map<Primitive, PrimitiveEntry>;
	generation: number;
	live: boolean;
	sharedSource: boolean;
}

type Attribution = Map<ScopeState, RejectionEffect>;

const EVENT = "unhandledRejection";
const BOUNDARY_KEY = Symbol.for("atomic-workflows/run-rejection-boundary@5");
const FLAG = "--unhandled-rejections";
const MAX_CAUSE_DEPTH = 8;
const MAX_PRIMITIVES_PER_RUN = 64;
const MAX_STOP_STRINGS = 64;
const ENDED_RUN_GRACE_MS = 30_000;
const NATIVE_REPORTING_MODES: ReadonlySet<string> = new Set(["throw", "warn-with-error-code"]);

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

type EndedRunTrees = Map<string, number>;

interface RejectionBoundary {
	readonly version: 5;
	readonly store: AsyncLocalStorage<ScopeState>;
	readonly owners: WeakMap<object, Attribution>;
	readonly promises: WeakMap<Promise<unknown>, ScopeState>;
	readonly scopes: Set<ScopeState>;
	readonly runs: Map<string, ScopeState>;
	readonly ended: Map<string, EndedRunTrees>;
	readonly stops: Set<string>;
	listener: RejectionListener | undefined;
}

function boundaryBag(): Record<symbol, RejectionBoundary | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RejectionBoundary | undefined>;
}

function sharedBoundary(): RejectionBoundary {
	const bag = boundaryBag();
	const existing = bag[BOUNDARY_KEY];
	if (existing !== undefined && existing.version === 5) return existing;
	const created: RejectionBoundary = {
		version: 5,
		store: new AsyncLocalStorage(),
		owners: new WeakMap(),
		promises: new WeakMap(),
		scopes: new Set(),
		runs: new Map(),
		ended: new Map(),
		stops: new Set(),
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

interface RecordedOwners {
	readonly owners: Attribution;
	readonly stopped: boolean;
}

function recordedOwners(boundary: RejectionBoundary, reason: unknown): RecordedOwners {
	const owners: Attribution = new Map();
	let stopped = false;
	const seen = new Set<object>();
	const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: reason, depth: 0 }];
	while (pending.length > 0) {
		const { value, depth } = pending.pop()!;
		if (depth > MAX_CAUSE_DEPTH) continue;
		if (isPrimitive(value)) {
			if (depth === 0 || (value !== undefined && value !== null)) {
				for (const scope of boundary.scopes) {
					const entry = scope.primitives.get(value);
					if (entry !== undefined) addAttribution(owners, scope, entry.effect);
				}
				if (typeof value === "string" && boundary.stops.has(value)) stopped = true;
			}
			continue;
		}
		if (seen.has(value)) continue;
		seen.add(value);
		for (const [scope, effect] of boundary.owners.get(value) ?? []) addAttribution(owners, scope, effect);
		pending.push({ value: safeField(value, "cause"), depth: depth + 1 });
		const errors = safeField(value, "errors");
		if (Array.isArray(errors)) for (const entry of errors) pending.push({ value: entry, depth: depth + 1 });
	}
	return { owners, stopped };
}

function pruneEndedSources(boundary: RejectionBoundary): void {
	const now = Date.now();
	for (const [source, trees] of boundary.ended) {
		for (const [rootRunId, endedAt] of trees) if (now - endedAt > ENDED_RUN_GRACE_MS) trees.delete(rootRunId);
		if (trees.size === 0) boundary.ended.delete(source);
	}
}

function rootRunId(scope: ScopeState): string {
	let root = scope;
	while (root.parent !== undefined) root = root.parent;
	return root.runId;
}

function recordEndedRun(boundary: RejectionBoundary, scope: ScopeState): void {
	if (scope.source === undefined) return;
	const trees = boundary.ended.get(scope.source) ?? new Map<string, number>();
	trees.set(rootRunId(scope), Date.now());
	boundary.ended.set(scope.source, trees);
}

function endedInAnotherRunTree(boundary: RejectionBoundary, source: string, live: ScopeState): boolean {
	const liveRoot = rootRunId(live);
	for (const endedRoot of boundary.ended.get(source)?.keys() ?? []) if (endedRoot !== liveRoot) return true;
	return false;
}

function recognizedSources(boundary: RejectionBoundary): ReadonlySet<string> {
	pruneEndedSources(boundary);
	const sources = new Set(boundary.ended.keys());
	for (const scope of boundary.scopes) if (scope.live && scope.source !== undefined) sources.add(scope.source);
	return sources;
}

function authoringSource(reason: unknown, sources: ReadonlySet<string>): string | undefined {
	if (sources.size === 0 || !isObject(reason)) return undefined;
	const stack = safeField(reason, "stack");
	if (typeof stack !== "string") return undefined;
	for (const line of stack.split("\n")) {
		if (!line.trimStart().startsWith("at ")) continue;
		const path = parsePromptStackFrame(line)?.normalizedPath;
		if (path === undefined) continue;
		if (isWorkflowRuntimeModule(path)) return undefined;
		if (/\/node_modules\//.test(path)) continue;
		if (sources.has(path)) return path;
	}
	return undefined;
}

function hasAncestorIn(scope: ScopeState, candidates: ReadonlySet<ScopeState>): boolean {
	for (let ancestor = scope.parent; ancestor !== undefined; ancestor = ancestor.parent) {
		if (candidates.has(ancestor)) return true;
	}
	return false;
}

function outermostLiveRuns(boundary: RejectionBoundary, source: string): Set<ScopeState> {
	const matching = new Set<ScopeState>();
	for (const scope of boundary.scopes) if (scope.live && scope.source === source) matching.add(scope);
	const outermost = new Set<ScopeState>();
	for (const scope of matching) if (!hasAncestorIn(scope, matching)) outermost.add(scope);
	return outermost;
}

function runOfSource(boundary: RejectionBoundary, source: string): Attribution | undefined {
	const [only, ...others] = outermostLiveRuns(boundary, source);
	if (only === undefined) return new Map();
	if (others.length > 0 || only.sharedSource) return undefined;
	if (endedInAnotherRunTree(boundary, source, only)) return undefined;
	return new Map([[only, "fail-run"]]);
}

function markSharedSource(boundary: RejectionBoundary, source: string): void {
	const runs = outermostLiveRuns(boundary, source);
	if (runs.size > 1) for (const run of runs) run.sharedSource = true;
}

function rejectingRun(
	boundary: RejectionBoundary,
	recorded: Attribution,
	promise: Promise<unknown> | undefined,
	scoped: ScopeState | undefined,
): ScopeState | undefined {
	const tracked = promise === undefined ? undefined : boundary.promises.get(promise);
	if (tracked !== undefined && recorded.has(tracked)) return tracked;
	if (scoped !== undefined && recorded.has(scoped)) return scoped;
	return undefined;
}

function attribute(
	boundary: RejectionBoundary,
	reason: unknown,
	promise: Promise<unknown> | undefined,
): Attribution | undefined {
	const { owners: recorded, stopped } = recordedOwners(boundary, reason);
	const scoped = boundary.store.getStore();
	if (recorded.size > 1) {
		const rejecting = rejectingRun(boundary, recorded, promise, scoped);
		if (rejecting !== undefined) return new Map([[rejecting, recorded.get(rejecting) ?? "fail-run"]]);
	}
	if (recorded.size > 0) return recorded;
	if (stopped) return new Map();
	if (scoped !== undefined && boundary.scopes.has(scoped)) return new Map([[scoped, "fail-run"]]);
	const origin = authoringSource(reason, recognizedSources(boundary));
	if (origin === undefined) return undefined;
	if (scoped !== undefined) return new Map([[scoped, "ignore"]]);
	return runOfSource(boundary, origin);
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
	const args = [...(process.env.NODE_OPTIONS ?? "").split(/\s+/), ...process.execArgv];
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

function onUnhandledRejection(reason: unknown, promise?: Promise<unknown>): void {
	const boundary = sharedBoundary();
	const owners = attribute(boundary, reason, promise);
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

function recordStop(boundary: RejectionBoundary, reason: string): void {
	boundary.stops.delete(reason);
	boundary.stops.add(reason);
	if (boundary.stops.size <= MAX_STOP_STRINGS) return;
	const oldest = boundary.stops.values().next();
	if (!oldest.done) boundary.stops.delete(oldest.value);
}

function recordPrimitive(scope: ScopeState, reason: Primitive, effect: RejectionEffect): void {
	if (!scope.live) return;
	if (scope.primitives.size >= MAX_PRIMITIVES_PER_RUN && !scope.primitives.has(reason)) {
		const oldest = scope.primitives.keys().next();
		if (!oldest.done) scope.primitives.delete(oldest.value);
	}
	scope.generation += 1;
	const generation = scope.generation;
	scope.primitives.set(reason, { effect: strongerEffect(scope.primitives.get(reason)?.effect, effect), generation });
	void afterPendingRejectionReports().then(() => {
		if (scope.primitives.get(reason)?.generation === generation) scope.primitives.delete(reason);
	});
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
	pruneEndedSources(boundary);
	const scope: ScopeState = {
		runId: options.runId,
		source: options.source === undefined ? undefined : normalizeStackPath(options.source),
		parent: options.parentRunId === undefined ? undefined : boundary.runs.get(options.parentRunId),
		fail: options.fail,
		primitives: new Map(),
		generation: 0,
		live: true,
		sharedSource: false,
	};
	boundary.scopes.add(scope);
	boundary.runs.set(scope.runId, scope);
	if (scope.source !== undefined) markSharedSource(boundary, scope.source);
	return {
		run: (callback) => boundary.store.run(scope, callback),
		contain: (promise, effect = "fail-run") => {
			boundary.promises.set(promise, scope);
			void promise.then(undefined, (reason: unknown) => record(boundary, scope, reason, effect));
			return promise;
		},
		watch: (promise) => {
			const watched = promise.then(undefined, (reason: unknown) => {
				record(boundary, scope, reason, "fail-run");
				throw reason;
			});
			boundary.promises.set(watched, scope);
			return watched;
		},
		ignore: (reason) => {
			if (typeof reason === "string") recordStop(boundary, reason);
			else record(boundary, scope, reason, "ignore");
		},
		settle: afterPendingRejectionReports,
		close: () => {
			scope.live = false;
			scope.fail = discardFailure;
			recordEndedRun(boundary, scope);
			void afterPendingRejectionReports().then(() => {
				scope.primitives.clear();
				scope.parent = undefined;
				boundary.scopes.delete(scope);
				if (boundary.runs.get(scope.runId) === scope) boundary.runs.delete(scope.runId);
			});
		},
	};
}

const WATCHED_STAGE_METHODS = [
	"prompt",
	"complete",
	"sendUserMessage",
	"steer",
	"followUp",
	"setModel",
	"setThinkingLevel",
	"cycleModel",
	"cycleThinkingLevel",
	"navigateTree",
	"compact",
	"abort",
] as const satisfies readonly (keyof StageContext)[];

type WatchedStageMethod = (typeof WATCHED_STAGE_METHODS)[number];
type StageMethodValue = Awaited<ReturnType<StageContext[WatchedStageMethod]>>;

export function containStageRejections<T extends StageContext>(stage: T, scope: RunRejectionScope): T {
	const contained = Object.create(stage) as T;
	const descriptors: PropertyDescriptorMap = {};
	for (const name of WATCHED_STAGE_METHODS) {
		descriptors[name] = {
			value: (...args: Parameters<StageContext[WatchedStageMethod]>) => {
				const result: Promise<StageMethodValue> | StageMethodValue = Reflect.apply(stage[name], stage, args);
				return result instanceof Promise ? scope.watch(result) : result;
			},
		};
	}
	Object.defineProperties(contained, descriptors);
	return contained;
}

export function containUiRejections(ui: WorkflowUIContext, scope: RunRejectionScope): WorkflowUIContext {
	return {
		input: (prompt) => scope.watch(ui.input(prompt)),
		confirm: (message) => scope.watch(ui.confirm(message)),
		select: (message, options) => scope.watch(ui.select(message, options)),
		editor: (initial) => scope.watch(ui.editor(initial)),
		custom: (factory, options) => scope.watch(ui.custom(factory, options)),
	};
}
