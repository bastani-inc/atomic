import type { ExtensionAPI } from "@bastani/atomic";
import { SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, type InboundMessageEntry } from "./intercom-utils.js";
import type { InboundIdleQueue } from "./inbound-idle-queue.js";

export { SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT } from "./intercom-utils.js";

const GLOBAL_BARRIER_HANDLER = "__atomicTerminalOrderingBarrierHandler";
const GLOBAL_BARRIER_REGISTRY = "__atomicTerminalOrderingBarrierRegistry";
const terminalOwnerIds = new WeakMap<object, number>();
let nextTerminalOwnerId = 1;

export interface OrderedTerminalPreludeMessage {
  customType: "intercom_message";
  content: string;
  display: true;
  details: InboundMessageEntry;
}

export interface TerminalOrderingBarrier {
  runId: string;
  terminalId: string;
  terminalAt: number;
  source: "background-notify" | "result-relay";
  owner?: object;
  sourceSessionTargets: string[];
  dispatch?(prefix: OrderedTerminalPreludeMessage[]): unknown;
}

interface TerminalOrderingBarrierOptions {
  queue: InboundIdleQueue;
  toMessage?(entry: InboundMessageEntry): OrderedTerminalPreludeMessage;
  deliver(entry: InboundMessageEntry, mode: "prelude"): unknown;
  onDrain?(): void;
  isCurrent?(): boolean;
}

function parseBarrier(value: unknown): TerminalOrderingBarrier | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || !record.runId) return null;
  if (typeof record.terminalAt !== "number" || !Number.isFinite(record.terminalAt)) return null;
  if (record.source !== "background-notify" && record.source !== "result-relay") return null;
  if (!Array.isArray(record.sourceSessionTargets)) return null;
  const sourceSessionTargets = record.sourceSessionTargets
    .filter((target): target is string => typeof target === "string")
    .map((target) => target.trim())
    .filter(Boolean);
  if (sourceSessionTargets.length === 0) return null;
  const owner = record.terminalOwner && typeof record.terminalOwner === "object" ? record.terminalOwner : undefined;
  const terminalId = typeof record.terminalId === "string" && record.terminalId
    ? record.terminalId : `${record.source}:${record.terminalAt}`;
  return {
    runId: record.runId,
    terminalId,
    terminalAt: record.terminalAt,
    ...(owner ? { owner } : {}),
    source: record.source,
    sourceSessionTargets,
    ...(typeof record.dispatch === "function"
      ? { dispatch: record.dispatch as (prefix: OrderedTerminalPreludeMessage[]) => unknown }
      : {}),
  };
}

interface GlobalBarrierRegistration {
  handle: (payload: unknown) => void;
  isCurrent: () => boolean;
}
type GlobalBarrierRegistry = GlobalBarrierRegistration[] & { previousHandler?: unknown };

function globalBarrierRegistry(): GlobalBarrierRegistry {
  const globals = globalThis as Record<string, unknown>;
  const current = globals[GLOBAL_BARRIER_REGISTRY];
  if (Array.isArray(current)) return current as GlobalBarrierRegistry;
  const registry = [] as GlobalBarrierRegistry;
  registry.previousHandler = globals[GLOBAL_BARRIER_HANDLER];
  globals[GLOBAL_BARRIER_REGISTRY] = registry;
  return registry;
}

export function emitGlobalTerminalOrderingBarrier(value: unknown): void {
  const registry = globalBarrierRegistry();
  for (let index = registry.length - 1; index >= 0; index -= 1) {
    const registration = registry[index];
    if (!registration?.isCurrent()) continue;
    registration.handle(value);
    return;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (typeof value === "object" || typeof value === "function")
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

function terminalRollbackIndex(error: unknown, fallback: number): number {
  if (!error || typeof error !== "object") return fallback;
  const value = (error as { terminalPreludeDelivered?: unknown }).terminalPreludeDelivered;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function terminalOwnerId(owner: object | undefined): number {
  if (!owner) return 0;
  const existing = terminalOwnerIds.get(owner);
  if (existing) return existing;
  const id = nextTerminalOwnerId++;
  terminalOwnerIds.set(owner, id);
  return id;
}

/** Claims accepted same-child messages before terminal delivery. */
export function registerTerminalOrderingBarrier(
  pi: Pick<ExtensionAPI, "events">,
  options: TerminalOrderingBarrierOptions,
): () => void {
  const drainedTargetsByTerminal = new Map<string, Set<string>>();
  const inFlightByTerminal = new Map<string, Promise<void>>();
  const handle = (value: unknown): void => {
    if (options.isCurrent?.() === false) return;
    const barrier = parseBarrier(value);
    if (!barrier) return;
    const envelope = value as { completion?: Promise<void> };
    if (envelope.completion) return;
    const terminalKey = `${terminalOwnerId(barrier.owner)}:${barrier.runId}\0${barrier.terminalId}`;
    const currentOwner = inFlightByTerminal.get(terminalKey);
    if (currentOwner) { envelope.completion = currentOwner; return; }
    const drainedTargets = drainedTargetsByTerminal.get(terminalKey) ?? new Set<string>();
    const pendingTargets = barrier.sourceSessionTargets.filter((target) => !drainedTargets.has(target));
    if (pendingTargets.length === 0) return;
    const claim = options.queue.claimOrdinarySourceTargets(barrier.runId, pendingTargets, barrier.terminalAt);
    const ownership = Promise.withResolvers<void>();
    void ownership.promise.catch(() => {});
    inFlightByTerminal.set(terminalKey, ownership.promise);
    const failOwnership = (error: unknown): void => {
      if (inFlightByTerminal.get(terminalKey) === ownership.promise) inFlightByTerminal.delete(terminalKey);
      ownership.reject(error);
    };
    const finish = (): void => {
      if ((barrier.dispatch && options.toMessage) || claim.entries.length > 0) {
        for (const target of pendingTargets) drainedTargets.add(target);
        drainedTargetsByTerminal.set(terminalKey, drainedTargets);
      }
      if (drainedTargetsByTerminal.size > 1_000) {
        const oldestKey = drainedTargetsByTerminal.keys().next().value;
        if (oldestKey !== undefined) drainedTargetsByTerminal.delete(oldestKey);
      }
      if (claim.entries.length > 0) options.onDrain?.();
      if (inFlightByTerminal.get(terminalKey) === ownership.promise) inFlightByTerminal.delete(terminalKey);
      ownership.resolve();
    };
    const observe = (completion: Promise<void>): void => {
      envelope.completion = ownership.promise;
      void completion.then(() => {}, (error) => {
        failOwnership(error);
        if (envelope.completion === ownership.promise) delete envelope.completion;
      });
    };
    if (barrier.dispatch && options.toMessage) {
      let dispatched: unknown;
      let dispatchedAsync: boolean;
      try {
        dispatched = barrier.dispatch(claim.entries.map(options.toMessage));
        dispatchedAsync = isPromiseLike(dispatched);
      } catch (error) {
        claim.rollbackFrom(terminalRollbackIndex(error, 0));
        failOwnership(error);
        throw error;
      }
      if (dispatchedAsync) {
        observe(Promise.resolve(dispatched).then(finish, (error) => {
          claim.rollbackFrom(terminalRollbackIndex(error, 0));
          throw error;
        }));
        return;
      }
      finish();
      return;
    }
    for (let index = 0; index < claim.entries.length; index++) {
      let delivered: unknown;
      let deliveredAsync: boolean;
      try {
        delivered = options.deliver(claim.entries[index]!, "prelude");
        deliveredAsync = isPromiseLike(delivered);
      } catch (error) {
        claim.rollbackFrom(index);
        failOwnership(error);
        throw error;
      }
      if (!deliveredAsync) continue;
      observe((async (): Promise<void> => {
        let current = index;
        try {
          await delivered;
          for (current = index + 1; current < claim.entries.length; current++) {
            await options.deliver(claim.entries[current]!, "prelude");
          }
          finish();
        } catch (error) {
          claim.rollbackFrom(current);
          throw error;
        }
      })());
      return;
    }
    finish();
  };
  const globals = globalThis as Record<string, unknown>;
  const registry = globalBarrierRegistry();
  const registration = { handle, isCurrent: () => options.isCurrent?.() !== false };
  registry.push(registration);
  globals[GLOBAL_BARRIER_HANDLER] = emitGlobalTerminalOrderingBarrier;
  const unsubscribe = pi.events.on(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, handle);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    unsubscribe();
    const index = registry.indexOf(registration);
    if (index >= 0) registry.splice(index, 1);
    if (registry.length === 0) {
      if (globals[GLOBAL_BARRIER_HANDLER] === emitGlobalTerminalOrderingBarrier) {
        if (typeof registry.previousHandler === "function") globals[GLOBAL_BARRIER_HANDLER] = registry.previousHandler;
        else delete globals[GLOBAL_BARRIER_HANDLER];
      }
      if (globals[GLOBAL_BARRIER_REGISTRY] === registry) delete globals[GLOBAL_BARRIER_REGISTRY];
    }
  };
}
