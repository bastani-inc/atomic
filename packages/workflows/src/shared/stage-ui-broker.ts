import { randomUUID } from "node:crypto";
import type { Component, Focusable, TUI } from "@bastani/atomic-tui";
import type {
	PiCustomComponent,
	PiCustomOverlayFactory,
	PiCustomOverlayOptions,
	PiKeybindings,
	PiTheme,
} from "../extension/wiring.js";
import type { StageQuestionnaireInput } from "../extension/workflow-human-input.js";
import { type PrimitivePromptAnswer, type PrimitivePromptKind, requirePrimitivePromptAnswer } from "./prompt-answer.js";
import { createSessionScopedSingleton } from "./session-scoped-singleton.js";
import type { StageInputAnswer, StagePromptAdapter } from "./stage-prompt.js";
import { ownsStageRecord, type StageRecordOwner, stageRecordOwner } from "./stage-record-owner.js";
import type { StagePromptAnswerSource, Store } from "./store.js";
import { currentWorkflowStore } from "./store-factory.js";
import type { PendingPrompt, StageInputRequest, StageSnapshot } from "./store-types.js";

export interface StageCustomUiRequest<T = unknown> {
	readonly id: string;
	readonly runId: string;
	readonly stageId: string;
	readonly factory: PiCustomOverlayFactory<T>;
	readonly owner?: AbortSignal;
	readonly options?: PiCustomOverlayOptions;
	readonly createdAt: number;
	readonly sessionId?: string;
	readonly humanInput?: StageQuestionnaireInput;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

export interface StageCustomUiHost {
	showCustomUi(request: StageCustomUiRequest): void;
	hideCustomUi?(request: StageCustomUiRequest, reason: unknown): void;
}

export interface StagePromptResolvedEvent {
	readonly runId: string;
	readonly stageId: string;
	readonly prompt: StageInputRequest;
	readonly answer: unknown;
	readonly answeredAt: number;
	readonly answerSource?: StagePromptAnswerSource;
}

export interface AnswerStagePromptOptions {
	/** Identifies who answered the prompt so notification code can avoid echoing workflow-tool answers. */
	readonly answerSource?: StagePromptAnswerSource;
}

export type StagePromptResolvedListener = (event: StagePromptResolvedEvent) => void;
export type StageRequestRegisteredListener = () => void;
export type StageStatusesChangedListener = () => void;

function key(runId: string, stageId: string): string {
	return `${runId}\0${stageId}`;
}

const EMPTY_STATUSES: ReadonlyMap<string, string> = new Map();

function nextRequestId(): string {
	return `stage-ui-${randomUUID()}`;
}

export type StageDialogJournal = (request?: PendingPrompt) => Promise<void>;

export interface StageDialogRequest {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
	readonly answerWithHost?: () => Promise<PrimitivePromptAnswer | undefined>;
	readonly unrecorded?: () => Promise<PrimitivePromptAnswer | undefined>;
}

function writeDialogJournal(journal: StageDialogJournal, request?: PendingPrompt): Promise<void> {
	try {
		return journal(request);
	} catch (error) {
		return Promise.reject(error);
	}
}

function untilSettledOrAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** One registration of a live stage. Its signal is unique even when the same registry reuses the stage ID. */
export interface StageUiOwner {
	readonly signal: AbortSignal;
	release(): void;
}

type StageUiKey = AbortSignal | string;
interface StageRegistration {
	readonly signal: AbortSignal;
	retire(message: string): void;
}

// A store can be shared by separately constructed brokers, including copies of the extension after a reload.
const ownershipKey = Symbol.for("atomic-workflows/stage-ui-owners@1");
interface RouteOrigin {
	current: boolean;
	readonly source?: { readonly store: WeakRef<Store>; readonly runId: string; readonly record: StageRecordOwner };
}
type Origins = Map<string, WeakRef<RouteOrigin>>;
interface StageDirectory {
	readonly owners: Map<string, StageRegistration>;
	readonly origins: Origins;
}
interface StageOwnership {
	readonly stores: WeakMap<Store, StageDirectory>;
	readonly producers: WeakMap<AbortSignal, RouteOrigin>;
}
const processState = globalThis as typeof globalThis & Record<symbol, StageOwnership | undefined>;
const ownership: StageOwnership = processState[ownershipKey] ?? { stores: new WeakMap(), producers: new WeakMap() };
processState[ownershipKey] = ownership;
// A released session can still receive a late ask. Retain the address watermark only as long as a route can use it.
const retiredOrigins = new FinalizationRegistry<{
	directory: WeakRef<Origins>;
	key: string;
	ref: WeakRef<RouteOrigin>;
}>(({ directory, key, ref }) => {
	const origins = directory.deref();
	if (origins?.get(key) === ref) origins.delete(key);
});
export function stageRouteIsCurrent(producer: AbortSignal): boolean {
	const origin = ownership.producers.get(producer);
	if (!origin) return !producer.aborted;
	const source = origin.source;
	if (!origin.current || !source) return origin.current;
	const record = source.store
		.deref()
		?.run(source.runId)
		?.stages.find((stage) => stage.id === source.record.stageId);
	return ownsStageRecord(source.record, record);
}

export class StageUiBroker {
	private readonly store: Store;
	private readonly owners: Map<string, StageRegistration>;
	private readonly origins: Origins;
	private readonly pending = new Map<StageUiKey, StageCustomUiRequest>();
	private readonly dialogs = new Map<StageUiKey, string>();
	private readonly turns = new Map<
		StageUiKey,
		{ readonly queue: PromiseWithResolvers<void>[]; readonly lifetime?: AbortController }
	>();
	private readonly customTurns = new Map<StageUiKey, object>();
	private readonly dialogJournals = new Map<StageUiKey, { readonly journal: StageDialogJournal }>();
	private readonly hosts = new Map<StageUiKey, { readonly host: StageCustomUiHost; readonly owner?: AbortSignal }>();
	private readonly presenters = new WeakMap<StageCustomUiRequest, StageCustomUiHost>();
	// Headless-answer adapters keyed by (runId, stageId). Populated by the
	// executor's ask_user_question watcher and the readiness gate so a brokered
	// custom-UI prompt can be answered programmatically (e.g. via `workflow
	// send`) without a TUI host rendering the interactive component.
	private readonly adapters = new Map<StageUiKey, StagePromptAdapter>();
	private readonly resolvedPromptIds = new Map<StageUiKey, string>();
	private readonly resolvedListeners = new Set<StagePromptResolvedListener>();
	private readonly registeredListeners = new Set<StageRequestRegisteredListener>();
	// Extension `ctx.ui.setStatus` writes per stage session, keyed by (runId, stageId).
	// Stage sessions have no footer of their own; the attached stage chat renders these.
	private readonly statuses = new Map<StageUiKey, Map<string, string>>();
	private readonly statusListeners = new Set<StageStatusesChangedListener>();

	constructor(store: Store = currentWorkflowStore()) {
		this.store = store;
		const directory = ownership.stores.get(store) ?? { owners: new Map(), origins: new Map() };
		ownership.stores.set(store, directory);
		this.owners = directory.owners;
		this.origins = directory.origins;
	}

	private stageKey(runId: string, stageId: string): StageUiKey {
		const stageKey = key(runId, stageId);
		return this.owners.get(stageKey)?.signal ?? stageKey;
	}

	currentStageOwner(runId: string, stageId: string): AbortSignal | undefined {
		return this.owners.get(key(runId, stageId))?.signal;
	}

	private hostFor(stageKey: StageUiKey, runId: string, stageId: string): StageCustomUiHost | undefined {
		const registration = this.hosts.get(stageKey) ?? this.hosts.get(key(runId, stageId));
		const owner = registration?.owner;
		if (owner && (owner.aborted || (typeof stageKey !== "string" && stageKey !== owner))) return undefined;
		return registration?.host;
	}

	private retire(stageKey: StageUiKey, controller: AbortController | undefined, message: string): void {
		const pending = this.pending.get(stageKey);
		this.adapters.delete(stageKey);
		this.resolvedPromptIds.delete(stageKey);
		this.dialogJournals.delete(stageKey);
		const statusesChanged = this.statuses.delete(stageKey);
		const turns = this.turns.get(stageKey);
		this.turns.delete(stageKey);
		this.customTurns.delete(stageKey);
		if (turns?.lifetime || controller || pending) {
			const reason = new Error(message);
			turns?.lifetime?.abort(reason);
			controller?.abort(reason);
			if (pending) this.reject(pending, reason);
		}
		if (controller) this.hosts.delete(stageKey);
		if (statusesChanged) this.notifyStatusesChanged();
	}

	claimStage(
		runId: string,
		stageId: string,
		{
			store = this.store,
			record = store.run(runId)?.stages.find((stage) => stage.id === stageId),
			reopen = false,
		}: { store?: Store; record?: StageSnapshot; reopen?: boolean } = {},
	): StageUiOwner {
		const stageKey = key(runId, stageId);
		const previous = this.owners.get(stageKey);
		const controller = new AbortController();
		const prior = this.origins.get(stageKey);
		let origin = prior?.deref();
		if (!reopen || origin === undefined || !ownsStageRecord(origin.source?.record, record)) {
			if (origin) origin.current = false;
			if (prior) retiredOrigins.unregister(prior);
			origin = {
				current: true,
				...(record === undefined
					? {}
					: { source: { store: new WeakRef(store), runId, record: stageRecordOwner(record) } }),
			};
			const ref = new WeakRef(origin);
			this.origins.set(stageKey, ref);
			retiredOrigins.register(origin, { directory: new WeakRef(this.origins), key: stageKey, ref }, ref);
		}
		ownership.producers.set(controller.signal, origin);
		const run = this.store.run(runId);
		const runRecord = run && new WeakRef(run);
		const registration: StageRegistration = {
			signal: controller.signal,
			retire: (message) =>
				this.store.batch(() => {
					const hadInput = this.adapters.has(controller.signal) || this.pending.has(controller.signal);
					if (hadInput && runRecord?.deref() === this.store.run(runId)) {
						this.store.clearStageInputRequest(runId, stageId);
						this.store.recordStageAwaitingInput(runId, stageId, false);
					}
					this.retire(controller.signal, controller, message);
				}),
		};
		this.owners.set(stageKey, registration);
		const replaced = `atomic-workflows: stage ${stageId} was replaced`;
		if (previous) previous.retire(replaced);
		else this.retire(stageKey, undefined, replaced);
		return {
			signal: controller.signal,
			release: () => {
				if (this.owners.get(stageKey) !== registration) return;
				this.owners.delete(stageKey);
				registration.retire(`atomic-workflows: stage ${stageId} was released`);
			},
		};
	}

	/** Record (or, with `undefined`, remove) one extension status written by a stage's session. */
	setStageStatus(
		runId: string,
		stageId: string,
		statusKey: string,
		text: string | undefined,
		owner?: AbortSignal,
	): void {
		const stageKey = this.stageKey(runId, stageId);
		if (owner !== undefined && owner !== stageKey) return;
		const current = this.statuses.get(stageKey);
		if (text === undefined) {
			if (!current?.delete(statusKey)) return;
			if (current.size === 0) this.statuses.delete(stageKey);
		} else {
			if (current?.get(statusKey) === text) return;
			if (current) current.set(statusKey, text);
			else this.statuses.set(stageKey, new Map([[statusKey, text]]));
		}
		this.notifyStatusesChanged();
	}

	/** Extension statuses written by this stage's own session; never the main session's. */
	getStageStatuses(runId: string, stageId: string): ReadonlyMap<string, string> {
		return this.statuses.get(this.stageKey(runId, stageId)) ?? EMPTY_STATUSES;
	}

	/** Drop a stage's statuses, e.g. when a new session replaces it or the stage ends. */
	clearStageStatuses(runId: string, stageId: string, owner?: AbortSignal): void {
		if (this.statuses.delete(owner ?? this.stageKey(runId, stageId))) this.notifyStatusesChanged();
	}

	onStageStatusesChanged(listener: StageStatusesChangedListener): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	private notifyStatusesChanged(): void {
		for (const listener of this.statusListeners) {
			try {
				listener();
			} catch {
				// A viewer's repaint failure must not break the extension's status write.
			}
		}
	}

	/**
	 * Register the structured descriptor + headless result builder for the
	 * prompt a stage is about to raise (or has just raised) via
	 * `requestCustomUi`. Surfaces the descriptor on the stage snapshot so
	 * `workflow answer` / status can see and answer it. Safe to call before or
	 * after the matching `requestCustomUi`; the (runId, stageId) key joins them.
	 */
	provideStagePrompt(runId: string, stageId: string, adapter: StagePromptAdapter, owner?: AbortSignal): void {
		const hostKey = this.stageKey(runId, stageId);
		if (owner !== undefined && owner !== hostKey) return;
		this.adapters.set(hostKey, adapter);
		// A newly provided adapter represents a fresh prompt instance, even when
		// the caller reuses the same prompt id (readiness gates historically did).
		// Clear the resolved marker unconditionally so a raced answer for this new
		// request cannot be mistaken for a duplicate answer to the prior instance.
		this.resolvedPromptIds.delete(hostKey);
		this.store.recordStageInputRequest(runId, stageId, adapter.prompt);
	}

	/** Drop a stage's headless-answer adapter and clear its snapshot descriptor. */
	clearStagePrompt(runId: string, stageId: string, owner?: AbortSignal): void {
		const current = this.stageKey(runId, stageId);
		if (this.adapters.delete(owner ?? current) && (owner === undefined || current === owner)) {
			this.store.clearStageInputRequest(runId, stageId);
		}
	}

	/**
	 * Settle and hide any brokered prompt that belongs to a stage whose workflow
	 * lifecycle has ended. Detaching a host intentionally does not cancel human
	 * input, but terminal stage/run cleanup must not leave stale HIL UI mounted.
	 */
	cancelStagePrompt(runId: string, stageId: string, reason: unknown, owner?: AbortSignal): void {
		const hostKey = owner ?? this.stageKey(runId, stageId);
		const request = this.pending.get(hostKey);
		if (request) {
			this.reject(request, reason);
			return;
		}
		this.clearStagePrompt(runId, stageId, owner);
	}

	/**
	 * Return the structured descriptor for a stage's brokered prompt when BOTH a
	 * headless-answer adapter and a live pending request exist for it — i.e. when
	 * `answerStagePrompt` can actually resolve something right now.
	 */
	peekStagePrompt(runId: string, stageId: string): StageInputRequest | undefined {
		const hostKey = this.stageKey(runId, stageId);
		const adapter = this.adapters.get(hostKey);
		if (adapter && this.pending.has(hostKey)) return adapter.prompt;
		return undefined;
	}

	/** Runner-owned human hosts need the original questionnaire and live identity. */
	peekStageQuestionnaire(runId: string, stageId: string) {
		const hostKey = this.stageKey(runId, stageId);
		const adapter = this.adapters.get(hostKey);
		const request = this.pending.get(hostKey);
		if (!adapter?.questionnaireParams || !request) return undefined;
		return {
			requestId: request.id,
			params: adapter.questionnaireParams,
			prompt: adapter.prompt,
			sessionId: request.sessionId,
			humanInput: request.humanInput,
		};
	}

	/**
	 * Headlessly answer a stage's pending brokered prompt. Resolves the awaiting
	 * `ctx.ui.custom` promise with the adapter-built result. Returns `false` when
	 * there is no adapter+request pair for the stage.
	 */
	answerStagePrompt(
		runId: string,
		stageId: string,
		answer: StageInputAnswer,
		options: AnswerStagePromptOptions = {},
	): boolean {
		const hostKey = this.stageKey(runId, stageId);
		const adapter = this.adapters.get(hostKey);
		const request = this.pending.get(hostKey);
		if (!adapter || !request) return false;
		this.resolve(request, adapter.buildResult(answer), options);
		return true;
	}

	wasStagePromptResolved(runId: string, stageId: string, promptId: string): boolean {
		return this.resolvedPromptIds.get(this.stageKey(runId, stageId)) === promptId;
	}

	onStagePromptResolved(listener: StagePromptResolvedListener): () => void {
		this.resolvedListeners.add(listener);
		return () => {
			this.resolvedListeners.delete(listener);
		};
	}

	/**
	 * Fires after a stage's custom UI request becomes pending. The store cannot
	 * announce it: a stage that already reported awaiting input publishes no change.
	 */
	onStageRequestRegistered(listener: StageRequestRegisteredListener): () => void {
		this.registeredListeners.add(listener);
		return () => {
			this.registeredListeners.delete(listener);
		};
	}

	private notifyStageRequestRegistered(): void {
		for (const listener of this.registeredListeners) {
			try {
				listener();
			} catch {
				// Listener failures must not prevent the request from being registered.
			}
		}
	}

	private notifyStagePromptAnswered(event: StagePromptResolvedEvent): void {
		for (const listener of this.resolvedListeners) {
			try {
				listener(event);
			} catch {
				// Listener failures must not prevent the prompt from resolving.
			}
		}
	}

	private hideHost(host: StageCustomUiHost | undefined, request: StageCustomUiRequest, reason: unknown): void {
		if (this.presenters.get(request) !== host) return;
		this.presenters.delete(request);
		try {
			host?.hideCustomUi?.(request, reason);
		} catch {
			// Host teardown is best-effort; request settlement must still continue.
		}
	}

	private showHostOrReject(host: StageCustomUiHost, request: StageCustomUiRequest): void {
		if (request.humanInput?.usesOwnBinding()) return;
		this.presenters.set(request, host);
		try {
			host.showCustomUi(request);
		} catch (error) {
			this.reject(request, error);
		}
	}

	registerHost(runId: string, stageId: string, host: StageCustomUiHost, owner?: AbortSignal): () => void {
		const current = this.currentStageOwner(runId, stageId);
		if (owner?.aborted || (owner !== undefined && current !== undefined && current !== owner)) return () => {};
		// A caller can mount the live handle in another broker with no producer of its own.
		const hostKey = owner !== undefined && current === owner ? owner : key(runId, stageId);
		const previousHost = this.hostFor(this.stageKey(runId, stageId), runId, stageId);
		const registration = { host, owner };
		this.hosts.set(hostKey, registration);
		const request = this.pending.get(this.stageKey(runId, stageId));
		if (previousHost && previousHost !== host && request) {
			this.hideHost(previousHost, request, new Error(`atomic-workflows: stage ${stageId} custom UI host replaced`));
		}
		const activeRequest = this.pending.get(this.stageKey(runId, stageId));
		if (
			activeRequest &&
			this.hosts.get(hostKey) === registration &&
			this.hostFor(this.stageKey(runId, stageId), runId, stageId) === host
		)
			this.showHostOrReject(host, activeRequest);
		return () => {
			if (this.hosts.get(hostKey) !== registration) return;
			this.hosts.delete(hostKey);
			const displayed = this.pending.get(owner ?? this.stageKey(runId, stageId));
			if (displayed && this.presenters.get(displayed) === host) this.presenters.delete(displayed);
			// Unregistering a host means it stops *displaying* the request — not that
			// the request is cancelled. A stage-scoped human-input request (e.g.
			// ask_user_question / readiness gate) outlives any one attached chat:
			// detaching leaves it pending (the stage stays awaiting_input) and a
			// future host re-displays it. The request is settled only by the user
			// answering (resolve) or the run aborting (its AbortSignal -> reject).
		};
	}

	hasStageDialog(runId: string, stageId: string): boolean {
		return this.dialogs.has(this.stageKey(runId, stageId));
	}

	registerDialogJournal(runId: string, stageId: string, journal: StageDialogJournal, owner?: AbortSignal): () => void {
		const hostKey = this.stageKey(runId, stageId);
		if (owner !== undefined && owner !== hostKey) return () => {};
		const registration = { journal };
		this.dialogJournals.set(hostKey, registration);
		return () => {
			if (this.dialogJournals.get(hostKey) === registration) this.dialogJournals.delete(hostKey);
		};
	}

	async requestDialog(
		runId: string,
		stageId: string,
		descriptor: Omit<PendingPrompt, "id" | "createdAt" | "kind"> & { readonly kind: PrimitivePromptKind },
		request: StageDialogRequest = {},
	): Promise<PrimitivePromptAnswer | undefined> {
		const hostKey = this.stageKey(runId, stageId);
		request.signal?.throwIfAborted();
		if (this.store.run(runId)?.stages.some((stage) => stage.id === stageId) !== true) {
			const unrecorded = request.answerWithHost ?? request.unrecorded;
			return unrecorded === undefined ? undefined : unrecorded();
		}
		const requestedAt = Date.now();
		const turn = this.takeTurn(hostKey);
		request = { ...request, signal: request.signal ? AbortSignal.any([request.signal, turn.signal]) : turn.signal };
		try {
			if (turn.ready !== undefined) await untilSettledOrAborted(turn.ready, request.signal);
			request.signal?.throwIfAborted();
			return await this.askDialog(
				runId,
				stageId,
				{
					...descriptor,
					source: "stage-dialog",
					id: nextRequestId(),
					createdAt: Date.now(),
					...(request.timeout === undefined ? {} : { expiresAt: requestedAt + request.timeout }),
				},
				request,
				hostKey,
			);
		} finally {
			turn.release();
		}
	}

	private takeTurn(hostKey: StageUiKey) {
		const group = this.turns.get(hostKey) ?? {
			queue: [],
			lifetime: typeof hostKey === "string" ? new AbortController() : undefined,
		};
		const line = group.queue;
		const turn = Promise.withResolvers<void>();
		line.push(turn);
		this.turns.set(hostKey, group);
		return {
			signal: typeof hostKey === "string" ? group.lifetime!.signal : hostKey,
			ready: line.length === 1 ? undefined : turn.promise,
			release: () => {
				const index = line.indexOf(turn);
				if (index < 0) return;
				line.splice(index, 1);
				if (line.length === 0) {
					if (this.turns.get(hostKey) === group) this.turns.delete(hostKey);
				} else if (index === 0) line[0]!.resolve();
			},
		};
	}

	private async askDialog(
		runId: string,
		stageId: string,
		prompt: PendingPrompt & { readonly kind: PrimitivePromptKind },
		{ signal, answerWithHost }: StageDialogRequest,
		hostKey: StageUiKey,
	): Promise<PrimitivePromptAnswer | undefined> {
		const journal = this.dialogJournals.get(hostKey);
		const cancel = () => {
			this.store.resolveStagePendingPrompt(runId, stageId, prompt.id, undefined, { recordAnswer: false });
		};
		this.dialogs.set(hostKey, prompt.id);
		try {
			signal?.throwIfAborted();
			if (journal !== undefined) await untilSettledOrAborted(writeDialogJournal(journal.journal, prompt), signal);
			signal?.throwIfAborted();
			signal?.addEventListener("abort", cancel, { once: true });
			if (!this.store.recordStagePendingPrompt(runId, stageId, prompt)) {
				throw new Error(`atomic-workflows: stage ${stageId} cannot accept a dialog`);
			}
			const answered = this.store.getStagePromptAnswer(runId, stageId);
			const response =
				answered?.promptId === prompt.id
					? answered.value
					: await new Promise<unknown>((resolve, reject) => {
							this.store.awaitStagePendingPrompt(runId, stageId, prompt.id, signal).then(resolve, reject);
							if (!answerWithHost) return;
							Promise.resolve()
								.then(() => {
									signal?.throwIfAborted();
									return answerWithHost();
								})
								.then((value) => {
									if (signal?.aborted) return;
									this.store.resolveStagePendingPrompt(runId, stageId, prompt.id, value, {
										recordAnswer: value !== undefined,
									});
								}, reject);
						});
			signal?.throwIfAborted();
			return response === undefined ? undefined : requirePrimitivePromptAnswer(prompt, response);
		} finally {
			signal?.removeEventListener("abort", cancel);
			cancel();
			if (this.dialogs.get(hostKey) === prompt.id) this.dialogs.delete(hostKey);
			const custom = this.pending.get(hostKey);
			if (custom && this.stageKey(runId, stageId) === hostKey)
				this.store.recordStageAwaitingInput(runId, stageId, true, custom.createdAt);
			if (journal !== undefined && this.dialogJournals.get(hostKey) === journal)
				void writeDialogJournal(journal.journal).catch(() => {});
		}
	}

	requestCustomUi<T>(
		runId: string,
		stageId: string,
		factory: PiCustomOverlayFactory<T>,
		options?: PiCustomOverlayOptions,
		signal?: AbortSignal,
		sessionId?: string,
		humanInput?: StageQuestionnaireInput,
		owner?: AbortSignal,
	): Promise<T> {
		const hostKey = this.stageKey(runId, stageId);
		if (owner !== undefined && owner !== hostKey)
			return Promise.reject(owner.reason ?? new Error(`atomic-workflows: stage ${stageId} was replaced`));
		// Session pause aborts the tool, not the stage (which remains resumable).
		// Either owner must be able to dismiss its outstanding custom UI request.
		signal = options?.signal ? (signal ? AbortSignal.any([signal, options.signal]) : options.signal) : signal;
		if (signal?.aborted) {
			return Promise.reject(signal.reason ?? new Error("atomic-workflows: stage UI request aborted"));
		}
		if (this.pending.has(hostKey) || this.customTurns.has(hostKey)) {
			return Promise.reject(new Error(`atomic-workflows: stage ${stageId} already has a pending custom UI request`));
		}
		const turn = this.takeTurn(hostKey);
		signal = signal ? AbortSignal.any([signal, turn.signal]) : turn.signal;
		this.customTurns.set(hostKey, turn);
		const release = () => {
			if (this.customTurns.get(hostKey) === turn) this.customTurns.delete(hostKey);
			turn.release();
		};
		const open = () => {
			if (signal?.aborted) {
				release();
				return Promise.reject(signal.reason);
			}
			const result = this.openCustomUi(
				runId,
				stageId,
				factory,
				options,
				signal,
				sessionId,
				humanInput,
				release,
				hostKey,
			);
			turn.release();
			return result;
		};
		if (turn.ready === undefined) return open();
		return untilSettledOrAborted(turn.ready, signal).then(open, (error: unknown) => {
			release();
			throw error;
		});
	}

	private openCustomUi<T>(
		runId: string,
		stageId: string,
		factory: PiCustomOverlayFactory<T>,
		options: PiCustomOverlayOptions | undefined,
		signal: AbortSignal | undefined,
		sessionId: string | undefined,
		humanInput: StageQuestionnaireInput | undefined,
		release: () => void,
		hostKey: StageUiKey,
	): Promise<T> {
		let request!: StageCustomUiRequest<T>;
		const promise = new Promise<T>((resolve, reject) => {
			request = {
				id: nextRequestId(),
				...(typeof hostKey === "string" ? {} : { owner: hostKey }),
				runId,
				stageId,
				factory,
				...(options !== undefined ? { options } : {}),
				...(sessionId === undefined ? {} : { sessionId }),
				...(humanInput === undefined ? {} : { humanInput }),
				createdAt: Date.now(),
				resolve,
				reject,
			};
		});

		const onAbort = (): void => {
			this.reject(request, signal?.reason ?? new Error("atomic-workflows: stage UI request aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		this.pending.set(hostKey, request);
		this.store.recordStageAwaitingInput(runId, stageId, true, request.createdAt);
		const host = this.hostFor(hostKey, runId, stageId);
		if (host && this.pending.get(hostKey) === request) this.showHostOrReject(host, request);
		this.notifyStageRequestRegistered();
		// Re-check after listener registration and host display; AbortSignal does
		// not replay an already-fired abort event for listeners added later.
		if (signal?.aborted) onAbort();

		return promise.finally(() => {
			signal?.removeEventListener("abort", onAbort);
			release();
		});
	}

	resolve<T>(request: StageCustomUiRequest<T>, value: T, options: AnswerStagePromptOptions = {}): void {
		const hostKey = request.owner ?? key(request.runId, request.stageId);
		if (this.pending.get(hostKey)?.id !== request.id || this.stageKey(request.runId, request.stageId) !== hostKey)
			return;
		const prompt = this.adapters.get(hostKey)?.prompt;
		this.pending.delete(hostKey);
		this.adapters.delete(hostKey);
		if (prompt !== undefined) this.resolvedPromptIds.set(hostKey, prompt.id);
		const host = this.presenters.get(request);
		this.store.batch(() => {
			this.store.clearStageInputRequest(request.runId, request.stageId);
			this.store.recordStageAwaitingInput(request.runId, request.stageId, false);
		});
		this.hideHost(host, request, undefined);
		if (prompt !== undefined) {
			this.notifyStagePromptAnswered({
				runId: request.runId,
				stageId: request.stageId,
				prompt,
				answer: value,
				answeredAt: Date.now(),
				...(options.answerSource !== undefined ? { answerSource: options.answerSource } : {}),
			});
		}
		request.resolve(value);
	}

	reject(request: StageCustomUiRequest, reason: unknown): void {
		const hostKey = request.owner ?? key(request.runId, request.stageId);
		if (this.pending.get(hostKey)?.id !== request.id) return;
		this.pending.delete(hostKey);
		this.adapters.delete(hostKey);
		this.resolvedPromptIds.delete(hostKey);
		const host = this.presenters.get(request);
		if (this.stageKey(request.runId, request.stageId) === hostKey)
			this.store.batch(() => {
				this.store.clearStageInputRequest(request.runId, request.stageId);
				this.store.recordStageAwaitingInput(request.runId, request.stageId, false);
			});
		this.hideHost(host, request, reason);
		request.reject(reason);
	}
}

export interface MountedStageCustomUi {
	readonly request: StageCustomUiRequest;
	readonly component: PiCustomComponent & { invalidate(): void; dispose?(): void } & Partial<Focusable>;
}

export async function mountStageCustomUi(
	request: StageCustomUiRequest,
	tui: TUI,
	theme: PiTheme,
	keybindings: PiKeybindings,
	broker: StageUiBroker,
	onDone?: () => void,
	canResolve?: () => boolean,
): Promise<MountedStageCustomUi> {
	const rawComponent = await request.factory(
		tui as unknown as Parameters<StageCustomUiRequest["factory"]>[0],
		theme,
		keybindings,
		(result: unknown) => {
			if (request.humanInput?.usesOwnBinding()) return;
			if (canResolve?.() === false) return;
			broker.resolve(request, result);
			onDone?.();
		},
	);
	const component: PiCustomComponent & { invalidate(): void; dispose?(): void } & Partial<Focusable> = {
		render: (width) => rawComponent.render(width),
		...(rawComponent.handleInput !== undefined
			? { handleInput: (data: string): boolean => rawComponent.handleInput?.(data) === true }
			: {}),
		invalidate: () => rawComponent.invalidate?.(),
		...(rawComponent.dispose !== undefined ? { dispose: () => rawComponent.dispose?.() } : {}),
		...(typeof (rawComponent as PiCustomComponent).capturesBack === "function"
			? { capturesBack: () => (rawComponent as PiCustomComponent).capturesBack?.() === true }
			: {}),
	};
	if ("focused" in rawComponent) {
		Object.defineProperty(component, "focused", {
			get: () => (rawComponent as Component & Partial<Focusable>).focused,
			set: (value: boolean) => {
				(rawComponent as Component & Partial<Focusable>).focused = value;
			},
			enumerable: true,
			configurable: true,
		});
	}
	return { request, component };
}

const SESSION_KEY = "workflows:stage-ui:v1";
const singleton = createSessionScopedSingleton(SESSION_KEY, () => new StageUiBroker());

export const stageUiBroker = singleton.facade;

export function adoptStageUiBroker(
	scope: object,
	preserveCurrentWhenTargetExists = false,
	store: Store = currentWorkflowStore(),
): StageUiBroker {
	return singleton.adopt(scope, {
		preserveCurrentWhenTargetExists: preserveCurrentWhenTargetExists ? () => true : undefined,
		create: () => new StageUiBroker(store),
	});
}

export function currentStageUiBroker(): StageUiBroker {
	return singleton.current();
}
