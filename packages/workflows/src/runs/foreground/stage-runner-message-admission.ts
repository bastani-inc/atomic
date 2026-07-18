import { AsyncLocalStorage } from "node:async_hooks";
import type { StageSessionRuntime, StageUserMessageDeliveryAction } from "./stage-runner-types.js";

type TurnState = "starting" | "owned" | "terminal";

type PublicTurnId = string | number;

interface TurnGeneration {
  readonly id: number;
  state: TurnState;
  publicStarted: boolean;
  publicTurnId?: PublicTurnId;
}

export interface StageMessageTurn {
  arm(): void;
  observe(): void;
  observeStreaming(): void;
  settle(action?: StageUserMessageDeliveryAction): void;
  invoke<T>(operation: () => T): T;
}

export class StageMessageAdmission {
  private tail: Promise<void> | undefined;
  private session: StageSessionRuntime | undefined;
  private observeStarting: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private nextGeneration = 0;
  private starting: TurnGeneration | undefined;
  private owned: TurnGeneration | undefined;
  private readonly startedGenerations: TurnGeneration[] = [];
  private readonly turnContext = new AsyncLocalStorage<TurnGeneration>();
  private readonly replayedTurnIds = new Set<PublicTurnId>();
  private untaggedReplayCount = 0;

  run<T>(operation: (release: () => void) => Promise<T>): Promise<T> {
    const admission = this.acquire();
    if (typeof admission === "function") return this.runAdmitted(operation, admission);
    return admission.then((release) => this.runAdmitted(operation, release));
  }

  isOwned(session: StageSessionRuntime): boolean {
    return this.session === session && this.owned?.state === "owned";
  }

  startTurn(session: StageSessionRuntime, release: () => void): StageMessageTurn {
    this.bind(session);
    const generation: TurnGeneration = {
      id: ++this.nextGeneration,
      state: "starting",
      publicStarted: false,
    };
    let armed = false;
    let settled = false;
    const observe = (): void => {
      if (!armed || settled || generation.state !== "starting" || this.starting !== generation) return;
      generation.state = "owned";
      this.starting = undefined;
      this.observeStarting = undefined;
      this.owned = generation;
      release();
    };
    return {
      arm: () => {
        if (settled || armed) return;
        armed = true;
        this.starting = generation;
        this.observeStarting = observe;
      },
      observe,
      observeStreaming: () => {
        if (session.isStreaming) observe();
      },
      settle: (action) => {
        if (settled) return;
        settled = true;
        if (this.starting === generation) {
          this.starting = undefined;
          this.observeStarting = undefined;
        }
        if (generation.state === "starting") {
          generation.state = "terminal";
          this.releaseBindingIfIdle();
          return;
        }
        if (generation.state !== "owned") {
          this.releaseBindingIfIdle();
          return;
        }
        if (action === "prompt" && generation.publicStarted) return;
        generation.state = "terminal";
        if (action === "handled") {
          const queuedIndex = this.startedGenerations.findIndex((entry) => entry.id === generation.id);
          if (queuedIndex >= 0) this.startedGenerations.splice(queuedIndex, 1);
        }
        if (this.owned === generation) this.owned = undefined;
        this.releaseBindingIfIdle();
      },
      invoke: (operation) => this.turnContext.run(generation, operation),
    };
  }

  reset(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session = undefined;
    this.observeStarting = undefined;
    this.starting = undefined;
    this.owned = undefined;
    this.startedGenerations.length = 0;
    this.replayedTurnIds.clear();
    this.untaggedReplayCount = 0;
  }

  dispose(): void {
    this.reset();
  }

  private bind(session: StageSessionRuntime): void {
    if (this.session === session) return;
    this.reset();
    this.session = session;
    let subscribing = true;
    this.unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") {
        if (subscribing) this.recordReplayedStart(event.turnId);
        else this.observePublicStart(event.turnId);
        return;
      }
      if (event.type === "agent_end") this.endStartedTurn(event.turnId, !subscribing);
    });
    subscribing = false;
  }

  private recordReplayedStart(turnId: PublicTurnId | undefined): void {
    if (turnId === undefined) this.untaggedReplayCount += 1;
    else this.replayedTurnIds.add(turnId);
  }

  private observePublicStart(turnId: PublicTurnId | undefined): void {
    const contextual = this.turnContext.getStore();
    const generation = contextual !== undefined && contextual.state !== "terminal"
      ? contextual
      : this.starting ?? this.owned;
    if (generation === undefined || generation.state === "terminal") return;
    this.observeStarting?.();
    if (generation.publicStarted) return;
    generation.publicStarted = true;
    if (turnId !== undefined) {
      this.replayedTurnIds.delete(turnId);
      generation.publicTurnId = turnId;
    }
    this.startedGenerations.push(generation);
  }

  private endStartedTurn(turnId: PublicTurnId | undefined, releaseIfIdle = true): void {
    if (turnId !== undefined && this.replayedTurnIds.delete(turnId)) {
      if (releaseIfIdle) this.releaseBindingIfIdle();
      return;
    }
    const contextual = turnId === undefined ? this.turnContext.getStore() : undefined;
    let generationIndex = contextual === undefined
      ? -1
      : this.startedGenerations.findIndex((entry) => entry.id === contextual.id);
    if (
      generationIndex < 0
      && turnId === undefined
      && this.startedGenerations.length === 1
      && this.startedGenerations[0]?.publicTurnId !== undefined
    ) generationIndex = 0;
    if (generationIndex < 0 && turnId === undefined && this.untaggedReplayCount > 0) {
      this.untaggedReplayCount -= 1;
      return;
    }
    if (generationIndex < 0) {
      generationIndex = turnId === undefined
        ? this.startedGenerations.findIndex((entry) => entry.publicTurnId === undefined)
        : this.startedGenerations.findIndex((entry) => entry.publicTurnId === turnId);
    }
    if (
      generationIndex < 0
      && this.startedGenerations.length === 1
      && (turnId === undefined || this.startedGenerations[0]?.publicTurnId === undefined)
    ) generationIndex = 0;
    if (generationIndex < 0) return;
    const [generation] = this.startedGenerations.splice(generationIndex, 1);
    if (generation === undefined) return;
    generation.state = "terminal";
    if (this.owned === generation) this.owned = undefined;
    if (releaseIfIdle) this.releaseBindingIfIdle();
  }

  private releaseBindingIfIdle(): void {
    if (this.starting !== undefined || this.owned !== undefined || this.startedGenerations.length > 0) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session = undefined;
    this.replayedTurnIds.clear();
    this.untaggedReplayCount = 0;
  }

  private acquire(): (() => void) | Promise<() => void> {
    const previous = this.tail;
    const next = Promise.withResolvers<void>();
    this.tail = next.promise;
    const release = (): void => {
      next.resolve();
      if (this.tail === next.promise) this.tail = undefined;
    };
    return previous === undefined ? release : previous.then(() => release);
  }

  private async runAdmitted<T>(operation: (release: () => void) => Promise<T>, release: () => void): Promise<T> {
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
    try {
      return await operation(releaseOnce);
    } finally {
      releaseOnce();
    }
  }
}
