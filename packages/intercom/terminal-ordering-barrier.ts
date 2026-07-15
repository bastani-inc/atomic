import type { ExtensionAPI } from "@bastani/atomic";
import { SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, type InboundMessageEntry } from "./intercom-utils.js";
import type { InboundIdleQueue } from "./inbound-idle-queue.js";

export { SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT } from "./intercom-utils.js";

const GLOBAL_BARRIER_HANDLER = "__atomicTerminalOrderingBarrierHandler";

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
  sourceSessionTargets: string[];
  dispatch?(prefix: OrderedTerminalPreludeMessage[]): void;
}

interface TerminalOrderingBarrierOptions {
  queue: InboundIdleQueue;
  toMessage?(entry: InboundMessageEntry): OrderedTerminalPreludeMessage;
  deliver(entry: InboundMessageEntry, mode: "prelude"): void;
  onDrain?(): void;
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
  const terminalId = typeof record.terminalId === "string" && record.terminalId
    ? record.terminalId : `${record.source}:${record.terminalAt}`;
  return {
    runId: record.runId,
    terminalId,
    terminalAt: record.terminalAt,
    source: record.source,
    sourceSessionTargets,
    ...(typeof record.dispatch === "function"
      ? { dispatch: record.dispatch as (prefix: OrderedTerminalPreludeMessage[]) => void }
      : {}),
  };
}

export function emitGlobalTerminalOrderingBarrier(value: unknown): void {
  const handler = (globalThis as Record<string, unknown>)[GLOBAL_BARRIER_HANDLER];
  if (typeof handler === "function") (handler as (payload: unknown) => void)(value);
}

/** Claims accepted same-child messages before terminal delivery. */
export function registerTerminalOrderingBarrier(
  pi: Pick<ExtensionAPI, "events">,
  options: TerminalOrderingBarrierOptions,
): () => void {
  const drainedTargetsByTerminal = new Map<string, Set<string>>();
  const handle = (value: unknown): void => {
    const barrier = parseBarrier(value);
    if (!barrier) return;
    const terminalKey = `${barrier.runId}\0${barrier.terminalId}`;
    const drainedTargets = drainedTargetsByTerminal.get(terminalKey) ?? new Set<string>();
    const pendingTargets = barrier.sourceSessionTargets.filter((target) => !drainedTargets.has(target));
    if (pendingTargets.length === 0) return;
    const claim = options.queue.claimOrdinarySourceTargets(barrier.runId, pendingTargets, barrier.terminalAt);
    if (barrier.dispatch && options.toMessage) {
      try {
        barrier.dispatch(claim.entries.map(options.toMessage));
      } catch (error) {
        claim.rollbackFrom(0);
        throw error;
      }
    } else {
      for (let index = 0; index < claim.entries.length; index++) {
        try {
          options.deliver(claim.entries[index]!, "prelude");
        } catch (error) {
          claim.rollbackFrom(index);
          throw error;
        }
      }
    }
    if ((barrier.dispatch && options.toMessage) || claim.entries.length > 0) {
      for (const target of pendingTargets) drainedTargets.add(target);
      drainedTargetsByTerminal.set(terminalKey, drainedTargets);
    }
    if (drainedTargetsByTerminal.size > 1_000) {
      const oldestKey = drainedTargetsByTerminal.keys().next().value;
      if (oldestKey !== undefined) drainedTargetsByTerminal.delete(oldestKey);
    }
    if (claim.entries.length > 0) options.onDrain?.();
  };
  (globalThis as Record<string, unknown>)[GLOBAL_BARRIER_HANDLER] = handle;
  const unsubscribe = pi.events.on(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, handle);
  return () => {
    unsubscribe();
    const globals = globalThis as Record<string, unknown>;
    if (globals[GLOBAL_BARRIER_HANDLER] === handle) delete globals[GLOBAL_BARRIER_HANDLER];
  };
}
