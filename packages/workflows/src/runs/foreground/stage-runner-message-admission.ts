import type { StageSessionRuntime, StageUserMessageDeliveryAction } from "./stage-runner-types.js";

type TurnState = "starting" | "owned" | "terminal";

interface TurnGeneration {
  readonly id: number;
  state: TurnState;
  publicStarted: boolean;
}

export interface StageMessageTurn {
  arm(): void;
  observe(): void;
  observeStreaming(): void;
  settle(action?: StageUserMessageDeliveryAction): void;
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
        generation.state = "terminal";
        if (action === "handled") {
          const queuedIndex = this.startedGenerations.findIndex((entry) => entry.id === generation.id);
          if (queuedIndex >= 0) this.startedGenerations.splice(queuedIndex, 1);
        }
        if (this.owned === generation) this.owned = undefined;
        this.releaseBindingIfIdle();
      },
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
        if (subscribing) this.recordReplayedStart();
        else this.observePublicStart();
        return;
      }
      if (event.type === "agent_end") this.endOldestStartedTurn(!subscribing);
    });
    subscribing = false;
  }

  private recordReplayedStart(): void {
    this.startedGenerations.push({
      id: ++this.nextGeneration,
      state: "terminal",
      publicStarted: true,
    });
  }

  private observePublicStart(): void {
    const generation = this.starting ?? this.owned;
    if (generation === undefined || generation.state === "terminal") return;
    this.observeStarting?.();
    if (generation.publicStarted) return;
    generation.publicStarted = true;
    this.startedGenerations.push(generation);
  }

  private endOldestStartedTurn(releaseIfIdle = true): void {
    const generation = this.startedGenerations.shift();
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
