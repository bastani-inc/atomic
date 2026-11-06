import type { DetachedToolCall, DetachedToolResult, ReleasedAgentSession } from "@bastani/atomic";
import type { StageWaitKind } from "../../shared/authoring-contract-stage.js";
import { StageWakeError } from "../../shared/stage-wait-errors.js";
import {
	isStageWakeKindRegistered,
	type StageWake,
	type StageWakeDelivery,
	type StageWakeHandler,
	type StageWakeKinds,
	stageWakeHandler,
} from "../../shared/stage-wake.js";

/** The resident record of one waiting stage: everything that stays in memory while its session is released. */
export interface StageWaitEntry {
	readonly runId: string;
	readonly stageId: string;
	readonly reason: StageWaitKind;
	readonly wakeKey: string;
	/** When the stage released its session (epoch milliseconds). */
	readonly since?: number;
}

/** The identity of a stage's mailbox, opened when the stage starts. */
export interface StageMailboxIdentity {
	readonly runId: string;
	readonly stageId: string;
	readonly wakeKey: string;
	/** The stage's durable replay key: the identity a rebuilt run finds the stage by again. */
	readonly replayKey?: string | undefined;
}

/**
 * One stage's wait on detached tool calls, handed over when its run is evicted from memory: plain identity and the
 * call handles, which belong to the tools running the calls rather than to the stage.
 */
export interface EvictedToolWait {
	readonly stageId: string;
	readonly replayKey: string;
	readonly wakeKey: string;
	readonly since: number;
	/** The watch whose result subscriptions report the calls' results while the run is evicted. */
	readonly watchId: number;
	readonly calls: readonly DetachedToolCall[];
	/** The ids of the calls whose results had arrived by the time the wait was handed over. */
	readonly settledCallIds: readonly string[];
	/** The stage's stored conversation, as a released agent session names it (#4326). */
	readonly session: ReleasedAgentSession;
}

/** What a stage waits on, released: its detached calls, and the session it gave up. */
export interface StageToolWait {
	readonly calls: readonly DetachedToolCall[];
	readonly session: ReleasedAgentSession;
}

/** Messages sent to a waiting stage while its run was evicted, in arrival order. */
export interface PendingStageWakes {
	readonly stageId: string;
	readonly wakes: readonly StageWake[];
}

/**
 * What an evicted run's stages wait on, handed from the evicted execution to the rebuilt one: their tool waits, and
 * the messages sent to them meanwhile, by replay key.
 */
export interface StageWaitHandoff {
	readonly waits: readonly EvictedToolWait[];
	readonly wakes: ReadonlyMap<string | undefined, PendingStageWakes>;
}

/**
 * Reported once when messages could not reach their stage: messages still queued when the stage or the run ended,
 * or a handler that failed.
 */
export type StageWakeReport =
	| {
			readonly reason: "stage-ended" | "run-ended";
			readonly runId: string;
			readonly stageId: string;
			/** The kinds of the unread messages, in arrival order. */
			readonly kinds: readonly string[];
	  }
	| {
			readonly reason: "handler-failed";
			readonly runId: string;
			readonly stageId: string;
			readonly kind: string;
			/** What the handler threw; a thrown value that is not an `Error` is wrapped in one as its `cause`. */
			readonly error: Error;
	  };

export interface StageWakeDispatcherOptions {
	/** Receives each {@link StageWakeReport} once; defaults to one `console.warn` line per report. */
	readonly report?: (report: StageWakeReport) => void;
}

type WaitFailure = Error | DOMException | string;

/** The detached calls a stage waits on, and their results so far. */
interface ToolResultsWatch {
	/** Tells a result of this watch from a late one of a watch it replaced, whose calls may share ids. */
	readonly id: number;
	readonly callIds: readonly string[];
	readonly results: Map<string, DetachedToolResult>;
}

/** A stage's mailbox: lives from the stage's start to its end, across any number of waits. */
interface Mailbox extends StageMailboxIdentity {
	readonly queue: StageWake[];
	/** Set while the stage waits: its entry in the resident index. */
	entry?: StageWaitEntry;
	cancelled?: WaitFailure;
	/** True while a handler runs for one of the stage's messages; the stage takes nothing else meanwhile. */
	handling: boolean;
	accepts?: keyof StageWakeKinds;
	resolve?: (wake: StageWake) => void;
	reject?: (reason: WaitFailure) => void;
	watch?: ToolResultsWatch;
}

export function stageWakeKey(runId: string, stageId: string): string {
	return `${runId}/${stageId}`;
}

/** What a run's wake route takes, whichever copy of this module created it: its dispatcher, or its eviction record. */
export interface StageWakeRoute {
	deliver(wakeKey: string, wake: StageWake): StageWakeDelivery;
	toolResultSettled(wakeKey: string, watchId: number, callId: string, result: DetachedToolResult): void;
	toolResultFailed(wakeKey: string, watchId: number, error: unknown): void;
}

// Shared across module copies: an SDK host's import may deliver to a run started by the extension bundle.
const dispatchersKey = Symbol.for("atomic-workflows/stage-wake-dispatchers@1");
const processState = globalThis as typeof globalThis & Record<symbol, Map<string, StageWakeRoute> | undefined>;
const dispatchersByRun: Map<string, StageWakeRoute> = processState[dispatchersKey] ?? new Map();
processState[dispatchersKey] = dispatchersByRun;

/** Watch ids are unique in the process, so a rebuilt run's dispatcher never mistakes a result of an earlier watch. */
let lastWatchId = 0;

/** Route a run's wakes and tool results to `route` from now on, in place of whatever routed them. */
export function routeStageWakes(runId: string, route: StageWakeRoute): void {
	dispatchersByRun.set(runId, route);
}

/** Stop routing a run's wakes to `route`, when it still routes them. */
export function unrouteStageWakes(runId: string, route: StageWakeRoute): void {
	if (dispatchersByRun.get(runId) === route) dispatchersByRun.delete(runId);
}

/**
 * Send a message to a stage of a live run in this process, for example when a feature outside the stage finishes
 * work the stage waits on. Throws `StageWakeError` (`unknown-wake-kind`) when no module registered the message's kind.
 */
export function deliverStageWake(runId: string, stageId: string, wake: StageWake): StageWakeDelivery {
	const dispatcher = dispatchersByRun.get(runId);
	if (dispatcher === undefined) {
		assertRegisteredKind(runId, stageId, wake);
		return { status: "run-not-live" };
	}
	return dispatcher.deliver(stageWakeKey(runId, stageId), wake);
}

function assertRegisteredKind(runId: string, stageId: string, wake: StageWake): void {
	if (!isStageWakeKindRegistered(wake.kind)) throw new StageWakeError({ runId, stageId, kind: String(wake.kind) });
}

function abortReason(signal: AbortSignal): WaitFailure {
	const reason = signal.reason;
	if (reason instanceof Error || reason instanceof DOMException || typeof reason === "string") return reason;
	return new DOMException("workflow killed", "AbortError");
}

function warnReport(report: StageWakeReport): void {
	const stage = `stage ${report.stageId} of run ${report.runId}`;
	if (report.reason === "handler-failed") {
		console.warn(`atomic-workflows: the "${report.kind}" wake handler failed for ${stage}: ${report.error.message}`);
		return;
	}
	const ended = report.reason === "stage-ended" ? "ended" : "ended with its run";
	console.warn(
		`atomic-workflows: ${stage} ${ended} with ${report.kinds.length} unread wake message(s): ${report.kinds.join(", ")}`,
	);
}

/**
 * Subscribe to one detached call's result. Module-level so the subscription captures only the run's id, a weak
 * reference to the dispatcher, the stage's wake key, the watch and the call id, never the call or the stage. A result
 * that settles after the dispatcher's run was evicted reaches whatever routes the run's wakes now: its eviction record,
 * or the dispatcher of the run rebuilt from it.
 */
function watchToolResult(
	runId: string,
	dispatcher: WeakRef<StageWakeDispatcher>,
	wakeKey: string,
	watchId: number,
	callId: string,
	result: Promise<DetachedToolResult>,
): void {
	const route = (): StageWakeRoute | undefined => {
		const origin = dispatcher.deref();
		return origin === undefined || origin.evicted ? dispatchersByRun.get(runId) : origin;
	};
	result.then(
		(settled) => route()?.toolResultSettled(wakeKey, watchId, callId, settled),
		(error: unknown) => route()?.toolResultFailed(wakeKey, watchId, error),
	);
}

/**
 * Run one handler for a stage, after the delivery that started it returns, and hand the stage back to the dispatcher
 * when it settles. Module-level so the pending handler captures only what it needs.
 */
async function runHandler(
	dispatcher: StageWakeDispatcher,
	mailbox: Mailbox,
	handler: StageWakeHandler,
	wake: StageWake,
	signal: AbortSignal | undefined,
): Promise<void> {
	try {
		await Promise.resolve().then(() =>
			handler(wake, { runId: mailbox.runId, stageId: mailbox.stageId, waiting: mailbox.entry?.reason, signal }),
		);
	} catch (error) {
		dispatcher.handlerFailed(mailbox, wake.kind, error);
	} finally {
		dispatcher.handlerSettled(mailbox);
	}
}

/**
 * The one owner of waiting for a run. Every stage has a mailbox from its start to its end; everything that wakes a
 * stage arrives there as a message. A stage takes one message at a time, in arrival order, so no stage is rehydrated
 * twice at once: a message of the kind the stage waits for ends its wait, a message of a kind with a handler runs that
 * handler, and a message of a kind without a handler stays queued for the stage's next wait of its kind. The run's
 * abort signal has one listener here, however many stages wait.
 */
export class StageWakeDispatcher implements StageWakeRoute {
	private readonly mailboxes = new Map<string, Mailbox>();
	/** Results the run's previous process recorded for stages' waits, by replay key, until each stage resumes. */
	private readonly resumeResults = new Map<string, readonly DetachedToolResult[]>();
	/** Tool waits the run's eviction handed over, by replay key, until each stage waits on them again. */
	private readonly resumeWaits = new Map<string | undefined, EvictedToolWait>();
	/** Messages sent to stages while the run was evicted, by replay key, until each stage's mailbox opens. */
	private readonly resumeWakes = new Map<string | undefined, PendingStageWakes>();
	private waiting = 0;
	/** Set once the run is evicted: the dispatcher no longer takes anything for it. */
	private evictedRun = false;
	private readonly removeAbortListener: (() => void) | undefined;
	private readonly runId: string;
	private readonly signal: AbortSignal | undefined;
	private readonly report: (report: StageWakeReport) => void;

	constructor(
		runId: string,
		signal: AbortSignal | undefined,
		options: StageWakeDispatcherOptions = {},
		resumed?: StageWaitHandoff,
	) {
		this.runId = runId;
		this.signal = signal;
		this.report = options.report ?? warnReport;
		for (const wait of resumed?.waits ?? []) this.resumeWaits.set(wait.replayKey, wait);
		for (const [replayKey, pending] of resumed?.wakes ?? []) this.resumeWakes.set(replayKey, pending);
		dispatchersByRun.set(runId, this);
		if (signal === undefined || signal.aborted) return;
		const onAbort = (): void => this.cancelAll(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		this.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
	}

	/** True once the run was evicted from memory. */
	get evicted(): boolean {
		return this.evictedRun;
	}

	/**
	 * Open a stage's mailbox when the stage starts. Messages for it queue from now on, after those it was sent while
	 * its run was evicted. Opening it again does nothing.
	 */
	open(stage: StageMailboxIdentity): void {
		const mailbox = this.mailbox(stage);
		const pending = this.resumeWakes.get(stage.replayKey);
		if (pending === undefined) return;
		this.resumeWakes.delete(stage.replayKey);
		mailbox.queue.push(...pending.wakes);
		this.drain(mailbox);
	}

	/**
	 * Close a stage's mailbox when the stage ends. Messages it never took are reported once, a wait still pending
	 * rejects, and the results of detached calls still outstanding are no longer awaited.
	 */
	close(wakeKey: string): void {
		this.closeMailbox(wakeKey, "stage-ended");
	}

	/** Mark a stage as waiting, with its reason, opening its mailbox if needed. A stage that already waits keeps its entry. */
	register(entry: StageWaitEntry): void {
		const mailbox = this.mailbox(entry);
		if (mailbox.entry !== undefined) return;
		mailbox.entry = entry;
		this.waiting += 1;
	}

	/** End a stage's wait. Its mailbox, unread messages and outstanding detached calls stay for its next wait. */
	unregister(wakeKey: string): void {
		const mailbox = this.mailboxes.get(wakeKey);
		if (mailbox?.entry === undefined) return;
		mailbox.entry = undefined;
		this.waiting -= 1;
	}

	/**
	 * Wait for the stage's first queued message of `kind`, leaving other kinds queued in order. A handler message that
	 * arrived first runs before. Rejects with the run's abort reason, or the reason passed to `cancel`.
	 */
	park<Kind extends keyof StageWakeKinds>(wakeKey: string, kind: Kind): Promise<Extract<StageWake, { kind: Kind }>> {
		if (this.signal?.aborted) return Promise.reject(abortReason(this.signal));
		const mailbox = this.mailboxes.get(wakeKey);
		if (mailbox === undefined)
			return Promise.reject(new DOMException(`atomic-workflows: stage ${wakeKey} is not open`, "AbortError"));
		if (mailbox.cancelled !== undefined) return Promise.reject(mailbox.cancelled);
		if (mailbox.resolve !== undefined)
			return Promise.reject(
				new DOMException(
					`atomic-workflows: stage ${wakeKey} is already waiting for a message`,
					"InvalidStateError",
				),
			);
		const parked = Promise.withResolvers<Extract<StageWake, { kind: Kind }>>();
		mailbox.accepts = kind;
		mailbox.resolve = parked.resolve as (wake: StageWake) => void;
		mailbox.reject = parked.reject;
		this.drain(mailbox);
		return parked.promise;
	}

	/**
	 * Deliver `{ kind: "tool-results", results }` to the stage, in call order, once every call's result has settled.
	 * Replaces a watch still outstanding; results of the calls it watched are then ignored.
	 */
	watchToolResults(wakeKey: string, calls: readonly DetachedToolCall[]): void {
		const mailbox = this.mailboxes.get(wakeKey);
		if (mailbox === undefined)
			throw new DOMException(`atomic-workflows: stage ${wakeKey} is not open`, "InvalidStateError");
		lastWatchId += 1;
		const watch: ToolResultsWatch = {
			id: lastWatchId,
			callIds: calls.map((call) => call.toolCallId),
			results: new Map(),
		};
		mailbox.watch = watch;
		if (calls.length === 0) {
			this.finishWatch(mailbox, watch);
			return;
		}
		const self = new WeakRef(this);
		for (const call of calls) watchToolResult(this.runId, self, wakeKey, watch.id, call.toolCallId, call.result);
	}

	/** @internal Record one watched call's result; delivers the stage's tool results once all have settled. */
	toolResultSettled(wakeKey: string, watchId: number, callId: string, result: DetachedToolResult): void {
		const mailbox = this.mailboxes.get(wakeKey);
		const watch = mailbox?.watch;
		if (mailbox === undefined || watch?.id !== watchId) {
			this.settleUnadoptedCall(wakeKey, watchId, callId);
			return;
		}
		watch.results.set(callId, result);
		if (watch.results.size === new Set(watch.callIds).size) this.finishWatch(mailbox, watch);
	}

	/** A call of a wait handed over by an eviction settled before its stage waits on it again: kept with the wait. */
	private settleUnadoptedCall(wakeKey: string, watchId: number, callId: string): void {
		for (const [replayKey, wait] of this.resumeWaits)
			if (wait.wakeKey === wakeKey && wait.watchId === watchId && !wait.settledCallIds.includes(callId))
				this.resumeWaits.set(replayKey, { ...wait, settledCallIds: [...wait.settledCallIds, callId] });
	}

	/**
	 * @internal A watched call's result rejected, which `DetachedToolCall` promises never happens: the stage's wait
	 * fails with the rejection rather than waiting forever.
	 */
	toolResultFailed(wakeKey: string, watchId: number, error: unknown): void {
		const mailbox = this.mailboxes.get(wakeKey);
		if (mailbox?.watch?.id !== watchId) return;
		mailbox.watch = undefined;
		this.cancel(wakeKey, error instanceof Error || typeof error === "string" ? error : String(error));
	}

	/**
	 * Deliver a message to a stage. Throws `StageWakeError` (`unknown-wake-kind`) when no module registered its kind;
	 * otherwise returns what became of it.
	 */
	deliver(wakeKey: string, wake: StageWake): StageWakeDelivery {
		const mailbox = this.mailboxes.get(wakeKey);
		assertRegisteredKind(mailbox?.runId ?? this.runId, mailbox?.stageId ?? stageIdOf(wakeKey), wake);
		if (mailbox === undefined) return { status: "stage-not-open" };
		mailbox.queue.push(wake);
		return { status: this.drain(mailbox, wake) ?? "queued" };
	}

	/** Fail a stage's current and later waits, for example when the stage itself is aborted, until it closes. */
	cancel(wakeKey: string, reason: WaitFailure): void {
		const mailbox = this.mailboxes.get(wakeKey);
		if (mailbox === undefined) return;
		mailbox.cancelled = reason;
		const reject = mailbox.reject;
		this.clearPark(mailbox);
		reject?.(reason);
	}

	/** The resident index: one entry per waiting stage. */
	entries(): StageWaitEntry[] {
		const entries: StageWaitEntry[] = [];
		for (const mailbox of this.mailboxes.values()) if (mailbox.entry !== undefined) entries.push(mailbox.entry);
		return entries;
	}

	/**
	 * Keep the results the run's previous process recorded for the wait of the stage on `replayKey`, so the stage,
	 * resumed, continues its turn from them instead of running its calls again.
	 */
	keepResultsForResume(replayKey: string, results: readonly DetachedToolResult[]): void {
		this.resumeResults.set(replayKey, results);
	}

	/** The results kept for the stage resumed on `replayKey`, handed out once. */
	takeResultsForResume(replayKey: string): readonly DetachedToolResult[] | undefined {
		const results = this.resumeResults.get(replayKey);
		this.resumeResults.delete(replayKey);
		return results;
	}

	/** The results kept for the stage resumed on `replayKey`, still kept for it. */
	resultsKeptForResume(replayKey: string): readonly DetachedToolResult[] | undefined {
		return this.resumeResults.get(replayKey);
	}

	/** How many stages wait. */
	get size(): number {
		return this.waiting;
	}

	/**
	 * Hand over every stage's wait on detached tool calls, with what `waitOf` finds the stage waiting on, and stop
	 * taking anything for the run, settling nothing: the
	 * stages' parked waits are dropped, never rejected, so their calls keep running and nothing they await resumes.
	 * Stages released between turns hand nothing over; replaying the run restores them. Messages queued for a stage are
	 * handed over with it, to queue for it again once the rebuilt run opens its mailbox. Returns `undefined`, changing
	 * nothing, while a stage holds something a replay cannot restore: a wait on anything else, a wait with its session
	 * still live, a handler running, a cancelled wait, or messages queued for a stage without a replay key.
	 */
	evict(waitOf: (stageId: string) => StageToolWait | undefined): StageWaitHandoff | undefined {
		const waits: EvictedToolWait[] = [];
		const wakes = new Map(this.resumeWakes);
		for (const mailbox of this.mailboxes.values()) {
			const { entry, watch } = mailbox;
			if (mailbox.handling || mailbox.cancelled !== undefined) return undefined;
			if (mailbox.queue.length > 0) {
				if (mailbox.replayKey === undefined) return undefined;
				wakes.set(mailbox.replayKey, { stageId: mailbox.stageId, wakes: [...mailbox.queue] });
			}
			if (entry === undefined) {
				if (watch !== undefined || mailbox.resolve !== undefined) return undefined;
				continue;
			}
			if (entry.reason === "release" || entry.reason === "idle") continue;
			const waiting = waitOf(mailbox.stageId);
			if (entry.reason !== "tool" || watch === undefined || mailbox.replayKey === undefined || waiting === undefined)
				return undefined;
			waits.push({
				stageId: mailbox.stageId,
				replayKey: mailbox.replayKey,
				wakeKey: mailbox.wakeKey,
				since: entry.since ?? Date.now(),
				watchId: watch.id,
				calls: waiting.calls,
				settledCallIds: [...watch.results.keys()],
				session: waiting.session,
			});
		}
		waits.push(...this.resumeWaits.values());
		this.evictedRun = true;
		this.removeAbortListener?.();
		this.mailboxes.clear();
		this.resumeWaits.clear();
		this.resumeWakes.clear();
		this.waiting = 0;
		unrouteStageWakes(this.runId, this);
		return { waits, wakes };
	}

	/** The tool wait the run's eviction handed over for the stage on `replayKey`, handed out once. */
	takeToolWaitForResume(replayKey: string | undefined): EvictedToolWait | undefined {
		const wait = this.resumeWaits.get(replayKey);
		this.resumeWaits.delete(replayKey);
		return wait;
	}

	/** True while the tool wait the run's eviction handed over for the stage on `replayKey` is still to be taken. */
	holdsToolWaitForResume(replayKey: string): boolean {
		return this.resumeWaits.has(replayKey);
	}

	/** The tool waits the run's eviction handed over that no stage has waited on again yet. */
	unadoptedToolWaits(): EvictedToolWait[] {
		return [...this.resumeWaits.values()];
	}

	/**
	 * Stop observing the run when it ends: every mailbox still open closes, and its unread messages are reported. The
	 * detached calls of a tool wait the run's eviction handed over that no stage waited on again are aborted.
	 */
	dispose(): void {
		this.removeAbortListener?.();
		for (const wakeKey of [...this.mailboxes.keys()]) this.closeMailbox(wakeKey, "run-ended");
		this.resumeResults.clear();
		for (const wait of this.resumeWaits.values()) {
			const reason = new DOMException(
				`atomic-workflows: run ${this.runId} ended before stage ${wait.stageId} waited on its detached calls again`,
				"AbortError",
			);
			for (const call of wait.calls) call.abort(reason);
		}
		this.resumeWaits.clear();
		for (const pending of this.resumeWakes.values())
			this.report({
				reason: "run-ended",
				runId: this.runId,
				stageId: pending.stageId,
				kinds: pending.wakes.map((wake) => wake.kind),
			});
		this.resumeWakes.clear();
		unrouteStageWakes(this.runId, this);
	}

	/** @internal A handler failed: report it once. The stage carries on. */
	handlerFailed(mailbox: Mailbox, kind: string, thrown: unknown): void {
		const error = thrown instanceof Error ? thrown : new Error(String(thrown), { cause: thrown });
		this.report({ reason: "handler-failed", runId: mailbox.runId, stageId: mailbox.stageId, kind, error });
	}

	/** @internal A handler settled: the stage takes its next message. */
	handlerSettled(mailbox: Mailbox): void {
		mailbox.handling = false;
		if (this.mailboxes.get(mailbox.wakeKey) === mailbox) this.drain(mailbox);
	}

	private mailbox(stage: StageMailboxIdentity): Mailbox {
		let mailbox = this.mailboxes.get(stage.wakeKey);
		if (mailbox === undefined) {
			mailbox = {
				runId: stage.runId,
				stageId: stage.stageId,
				wakeKey: stage.wakeKey,
				replayKey: stage.replayKey,
				queue: [],
				handling: false,
			};
			if (this.signal?.aborted) mailbox.cancelled = abortReason(this.signal);
			this.mailboxes.set(stage.wakeKey, mailbox);
		}
		return mailbox;
	}

	private finishWatch(mailbox: Mailbox, watch: ToolResultsWatch): void {
		mailbox.watch = undefined;
		const results = watch.callIds.map((callId) => watch.results.get(callId)!);
		this.deliver(mailbox.wakeKey, { kind: "tool-results", results });
	}

	/**
	 * Hand the stage the messages it can take now, in arrival order: a message of the kind it waits for ends its wait,
	 * and a message with a handler runs it, after which the stage takes nothing more until the handler settles. Messages
	 * of other kinds stay queued. Returns what became of `probe`, when it was taken.
	 */
	private drain(mailbox: Mailbox, probe?: StageWake): "delivered" | "handled" | undefined {
		let taken: "delivered" | "handled" | undefined;
		let index = 0;
		while (!mailbox.handling && mailbox.cancelled === undefined && index < mailbox.queue.length) {
			const wake = mailbox.queue[index]!;
			const resolve = mailbox.accepts === wake.kind ? mailbox.resolve : undefined;
			const handler = resolve === undefined ? stageWakeHandler(wake.kind) : undefined;
			if (resolve === undefined && handler === undefined) {
				index += 1;
				continue;
			}
			mailbox.queue.splice(index, 1);
			if (wake === probe) taken = resolve === undefined ? "handled" : "delivered";
			if (resolve !== undefined) {
				this.clearPark(mailbox);
				resolve(wake);
				continue;
			}
			mailbox.handling = true;
			void runHandler(this, mailbox, handler!, wake, this.signal);
		}
		return taken;
	}

	private clearPark(mailbox: Mailbox): void {
		mailbox.accepts = undefined;
		mailbox.resolve = undefined;
		mailbox.reject = undefined;
	}

	private closeMailbox(wakeKey: string, reason: "stage-ended" | "run-ended"): void {
		const mailbox = this.mailboxes.get(wakeKey);
		if (mailbox === undefined) return;
		this.mailboxes.delete(wakeKey);
		if (mailbox.entry !== undefined) this.waiting -= 1;
		mailbox.entry = undefined;
		mailbox.watch = undefined;
		const reject = mailbox.reject;
		this.clearPark(mailbox);
		reject?.(new DOMException(`atomic-workflows: stage ${wakeKey} ended while it waited`, "AbortError"));
		const unread = mailbox.queue.splice(0);
		if (unread.length > 0)
			this.report({
				reason,
				runId: mailbox.runId,
				stageId: mailbox.stageId,
				kinds: unread.map((wake) => wake.kind),
			});
	}

	private cancelAll(reason: WaitFailure): void {
		for (const wakeKey of [...this.mailboxes.keys()]) this.cancel(wakeKey, reason);
	}
}

function stageIdOf(wakeKey: string): string {
	const slash = wakeKey.indexOf("/");
	return slash < 0 ? wakeKey : wakeKey.slice(slash + 1);
}
