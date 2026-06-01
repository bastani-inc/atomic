import { randomUUID } from "node:crypto";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { StagePromptAnswerSource, Store } from "./store.js";
import { store as defaultStore } from "./store.js";
import type { StageInputRequest } from "./store-types.js";
import type { StageInputAnswer, StagePromptAdapter } from "./stage-prompt.js";
import type { PiCustomOverlayFactory, PiCustomOverlayOptions, PiKeybindings, PiTheme } from "../extension/wiring.js";

export interface StageCustomUiRequest<T = unknown> {
  readonly id: string;
  readonly runId: string;
  readonly stageId: string;
  readonly factory: PiCustomOverlayFactory<T>;
  readonly options?: PiCustomOverlayOptions;
  readonly createdAt: number;
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

function key(runId: string, stageId: string): string {
  return `${runId}\0${stageId}`;
}

function nextRequestId(): string {
  return `stage-ui-${randomUUID()}`;
}

export class StageUiBroker {
  private readonly store: Store;
  private readonly pending = new Map<string, StageCustomUiRequest>();
  private readonly hosts = new Map<string, StageCustomUiHost>();
  // Headless-answer adapters keyed by (runId, stageId). Populated by the
  // executor's ask_user_question watcher and the readiness gate so a brokered
  // custom-UI prompt can be answered programmatically (e.g. via `workflow
  // send`) without a TUI host rendering the interactive component.
  private readonly adapters = new Map<string, StagePromptAdapter>();
  private readonly resolvedPromptIds = new Map<string, string>();
  private readonly resolvedListeners = new Set<StagePromptResolvedListener>();

  constructor(store: Store = defaultStore) {
    this.store = store;
  }

  /**
   * Register the structured descriptor + headless result builder for the
   * prompt a stage is about to raise (or has just raised) via
   * `requestCustomUi`. Surfaces the descriptor on the stage snapshot so
   * `workflow send` / status can see and answer it. Safe to call before or
   * after the matching `requestCustomUi`; the (runId, stageId) key joins them.
   */
  provideStagePrompt(runId: string, stageId: string, adapter: StagePromptAdapter): void {
    const hostKey = key(runId, stageId);
    this.adapters.set(hostKey, adapter);
    // A newly provided adapter represents a fresh prompt instance, even when
    // the caller reuses the same prompt id (readiness gates historically did).
    // Clear the resolved marker unconditionally so a raced answer for this new
    // request cannot be mistaken for a duplicate answer to the prior instance.
    this.resolvedPromptIds.delete(hostKey);
    this.store.recordStageInputRequest(runId, stageId, adapter.prompt);
  }

  /** Drop a stage's headless-answer adapter and clear its snapshot descriptor. */
  clearStagePrompt(runId: string, stageId: string): void {
    if (this.adapters.delete(key(runId, stageId))) {
      this.store.clearStageInputRequest(runId, stageId);
    }
  }

  /**
   * Settle and hide any brokered prompt that belongs to a stage whose workflow
   * lifecycle has ended. Detaching a host intentionally does not cancel human
   * input, but terminal stage/run cleanup must not leave stale HIL UI mounted.
   */
  cancelStagePrompt(runId: string, stageId: string, reason: unknown): void {
    const hostKey = key(runId, stageId);
    const request = this.pending.get(hostKey);
    if (request) {
      this.reject(request, reason);
      return;
    }
    if (this.adapters.delete(hostKey)) {
      this.store.clearStageInputRequest(runId, stageId);
    }
  }

  /**
   * Return the structured descriptor for a stage's brokered prompt when BOTH a
   * headless-answer adapter and a live pending request exist for it — i.e. when
   * `answerStagePrompt` can actually resolve something right now.
   */
  peekStagePrompt(runId: string, stageId: string): StageInputRequest | undefined {
    const hostKey = key(runId, stageId);
    const adapter = this.adapters.get(hostKey);
    if (adapter && this.pending.has(hostKey)) return adapter.prompt;
    return undefined;
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
    const hostKey = key(runId, stageId);
    const adapter = this.adapters.get(hostKey);
    const request = this.pending.get(hostKey);
    if (!adapter || !request) return false;
    this.resolve(request, adapter.buildResult(answer), options);
    return true;
  }

  wasStagePromptResolved(runId: string, stageId: string, promptId: string): boolean {
    return this.resolvedPromptIds.get(key(runId, stageId)) === promptId;
  }

  onStagePromptResolved(listener: StagePromptResolvedListener): () => void {
    this.resolvedListeners.add(listener);
    return () => {
      this.resolvedListeners.delete(listener);
    };
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
    try {
      host?.hideCustomUi?.(request, reason);
    } catch {
      // Host teardown is best-effort; request settlement must still continue.
    }
  }

  private showHostOrReject(host: StageCustomUiHost, request: StageCustomUiRequest): void {
    try {
      host.showCustomUi(request);
    } catch (error) {
      this.reject(request, error);
    }
  }

  registerHost(runId: string, stageId: string, host: StageCustomUiHost): () => void {
    const hostKey = key(runId, stageId);
    const previousHost = this.hosts.get(hostKey);
    const request = this.pending.get(hostKey);
    if (previousHost && previousHost !== host && request) {
      this.hideHost(
        previousHost,
        request,
        new Error(`atomic-workflows: stage ${stageId} custom UI host replaced`),
      );
    }
    this.hosts.set(hostKey, host);
    const activeRequest = this.pending.get(hostKey);
    if (activeRequest) this.showHostOrReject(host, activeRequest);
    return () => {
      if (this.hosts.get(hostKey) !== host) return;
      this.hosts.delete(hostKey);
      // Unregistering a host means it stops *displaying* the request — not that
      // the request is cancelled. A stage-scoped human-input request (e.g.
      // ask_user_question / readiness gate) outlives any one attached chat:
      // detaching leaves it pending (the stage stays awaiting_input) and a
      // future host re-displays it. The request is settled only by the user
      // answering (resolve) or the run aborting (its AbortSignal -> reject).
    };
  }

  requestCustomUi<T>(
    runId: string,
    stageId: string,
    factory: PiCustomOverlayFactory<T>,
    options?: PiCustomOverlayOptions,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("atomic-workflows: stage UI request aborted"));
    }
    const hostKey = key(runId, stageId);
    const existing = this.pending.get(hostKey);
    if (existing) {
      return Promise.reject(new Error(`atomic-workflows: stage ${stageId} already has a pending custom UI request`));
    }

    let request!: StageCustomUiRequest<T>;
    const promise = new Promise<T>((resolve, reject) => {
      request = {
        id: nextRequestId(),
        runId,
        stageId,
        factory,
        ...(options !== undefined ? { options } : {}),
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
    const host = this.hosts.get(hostKey);
    if (host) this.showHostOrReject(host, request);
    // Re-check after listener registration and host display; AbortSignal does
    // not replay an already-fired abort event for listeners added later.
    if (signal?.aborted) onAbort();

    return promise.finally(() => {
      signal?.removeEventListener("abort", onAbort);
    });
  }

  resolve<T>(request: StageCustomUiRequest<T>, value: T, options: AnswerStagePromptOptions = {}): void {
    const hostKey = key(request.runId, request.stageId);
    if (this.pending.get(hostKey)?.id !== request.id) return;
    const prompt = this.adapters.get(hostKey)?.prompt;
    this.pending.delete(hostKey);
    this.adapters.delete(hostKey);
    if (prompt !== undefined) this.resolvedPromptIds.set(hostKey, prompt.id);
    this.store.clearStageInputRequest(request.runId, request.stageId);
    this.store.recordStageAwaitingInput(request.runId, request.stageId, false);
    this.hideHost(this.hosts.get(hostKey), request, undefined);
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
    const hostKey = key(request.runId, request.stageId);
    if (this.pending.get(hostKey)?.id !== request.id) return;
    this.pending.delete(hostKey);
    this.adapters.delete(hostKey);
    this.resolvedPromptIds.delete(hostKey);
    this.store.clearStageInputRequest(request.runId, request.stageId);
    this.store.recordStageAwaitingInput(request.runId, request.stageId, false);
    this.hideHost(this.hosts.get(hostKey), request, reason);
    request.reject(reason);
  }
}

export interface MountedStageCustomUi {
  readonly request: StageCustomUiRequest;
  readonly component: Component & { dispose?(): void };
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
      if (canResolve?.() === false) return;
      broker.resolve(request, result);
      onDone?.();
    },
  );
  const component: Component & { dispose?(): void } & Partial<Focusable> = {
    render: (width) => rawComponent.render(width),
    ...(rawComponent.handleInput !== undefined
      ? { handleInput: (data: string) => rawComponent.handleInput?.(data) }
      : {}),
    invalidate: () => rawComponent.invalidate?.(),
    ...(rawComponent.dispose !== undefined ? { dispose: () => rawComponent.dispose?.() } : {}),
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

export const stageUiBroker = new StageUiBroker();
