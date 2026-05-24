import { randomUUID } from "node:crypto";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { Store } from "./store.js";
import { store as defaultStore } from "./store.js";
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

  constructor(store: Store = defaultStore) {
    this.store = store;
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
        new Error(`pi-workflows: stage ${stageId} custom UI host replaced`),
      );
    }
    this.hosts.set(hostKey, host);
    const activeRequest = this.pending.get(hostKey);
    if (activeRequest) this.showHostOrReject(host, activeRequest);
    return () => {
      if (this.hosts.get(hostKey) !== host) return;
      this.hosts.delete(hostKey);
      const pendingRequest = this.pending.get(hostKey);
      if (pendingRequest) {
        this.reject(
          pendingRequest,
          new Error(`pi-workflows: stage ${stageId} custom UI host unregistered`),
        );
      }
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
      return Promise.reject(signal.reason ?? new Error("pi-workflows: stage UI request aborted"));
    }
    const hostKey = key(runId, stageId);
    const existing = this.pending.get(hostKey);
    if (existing) {
      return Promise.reject(new Error(`pi-workflows: stage ${stageId} already has a pending custom UI request`));
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
      this.reject(request, signal?.reason ?? new Error("pi-workflows: stage UI request aborted"));
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

  resolve<T>(request: StageCustomUiRequest<T>, value: T): void {
    const hostKey = key(request.runId, request.stageId);
    if (this.pending.get(hostKey)?.id !== request.id) return;
    this.pending.delete(hostKey);
    this.store.recordStageAwaitingInput(request.runId, request.stageId, false);
    this.hideHost(this.hosts.get(hostKey), request, undefined);
    request.resolve(value);
  }

  reject(request: StageCustomUiRequest, reason: unknown): void {
    const hostKey = key(request.runId, request.stageId);
    if (this.pending.get(hostKey)?.id !== request.id) return;
    this.pending.delete(hostKey);
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
): Promise<MountedStageCustomUi> {
  const rawComponent = await request.factory(
    tui as unknown as Parameters<StageCustomUiRequest["factory"]>[0],
    theme,
    keybindings,
    (result: unknown) => {
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
