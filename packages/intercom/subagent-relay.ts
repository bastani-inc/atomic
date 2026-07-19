import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { randomUUID } from "crypto";
import type { IntercomClient } from "./broker/client.ts";
import type { SessionInfo, Message } from "./types.ts";
import {
  SUBAGENT_CONTROL_INTERCOM_EVENT,
  SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_RESULT_INTERCOM_EVENT,
  SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT,
  getErrorMessage,
  parseSubagentIntercomPayload,
  parseSubagentResultBarrier,
} from "./intercom-utils.js";
import { DeliveredMessageCache } from "./broker/delivered-message-cache.js";
import { buildSendSignature } from "./broker/send-signature.js";
import { emitGlobalTerminalOrderingBarrier } from "./terminal-ordering-barrier.js";

interface SubagentRelayDeps {
  runtimeGeneration(): number;
  runtimeStarted(): boolean;
  runtimeContext(): ExtensionContext | null;
  getLiveContext(ctx?: ExtensionContext | null, generation?: number): ExtensionContext | null;
  currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: IntercomClient): boolean;
  sendIncomingMessage(entry: { from: SessionInfo; message: Message; bodyText: string }, delivery: "trigger" | "followUp", generation?: number): unknown;
  ensureConnected(reason: "background"): Promise<IntercomClient>;
  resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null>;
  homeGroup?(): string;
}

async function dispatchRelayFallback(
  pi: ExtensionAPI,
  prefix: Array<{ customType: string; content: string; display: boolean; details?: unknown }>,
  terminalMessage: { customType: string; content: string; display: boolean; details?: unknown },
): Promise<void> {
  let delivered = 0;
  try {
    for (const message of prefix) {
      await pi.sendMessage(message, { deliverAs: "steer" });
      delivered += 1;
    }
    await pi.sendMessage(terminalMessage, { triggerTurn: true });
  } catch (error) {
    const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error });
    Object.assign(failure, { terminalPreludeDelivered: delivered });
    throw failure;
  }
}

export function registerSubagentRelay(pi: ExtensionAPI, deps: SubagentRelayDeps): void {
  const { getLiveContext, currentSessionTargetMatches, sendIncomingMessage, ensureConnected, resolveSessionTarget } = deps;
  const localDeliveries = new DeliveredMessageCache();
  const localDeliveriesInFlight = new Map<string, { signature: string; completion: Promise<void> }>();
  function deliverLocalSubagentRelayMessage(
    sender: "subagent-control" | "subagent-result",
    status: string,
    messageText: string,
    terminalBarrier?: { runId: string; terminalId?: string; sourceSessionTargets: string[] },
  ): Promise<void> {
    const now = Date.now();
    const entry = {
      from: {
        id: sender, name: sender, cwd: deps.runtimeContext()?.cwd ?? process.cwd(),
        model: sender, pid: process.pid, startedAt: now, lastActivity: now, status, group: deps.homeGroup?.(),
      },
      message: { id: randomUUID(), timestamp: now, content: { text: messageText } },
      bodyText: messageText,
    };
    let dispatched = false;
    let completion: Promise<void> | undefined;
    if (terminalBarrier) {
      const payload = {
        ...terminalBarrier,
        terminalAt: now,
        source: "result-relay" as const,
        dispatch: (prefix: Array<{ customType: string; content: string; display: boolean; details?: unknown }>) => {
          dispatched = true;
          const terminalMessage = {
            customType: "intercom_message",
            content: `**📨 From ${sender}** (${entry.from.cwd})\n\n${messageText}`,
            display: true,
            details: entry,
          };
          if (typeof pi.sendMessages === "function") {
            return pi.sendMessages([...prefix, terminalMessage], { triggerTurn: true });
          }
          return dispatchRelayFallback(pi, prefix, terminalMessage);
        },
      };
      Object.defineProperty(payload, "terminalOwner", { value: pi });
      pi.events.emit(SUBAGENT_TERMINAL_ORDERING_BARRIER_EVENT, payload);
      emitGlobalTerminalOrderingBarrier(payload);
      completion = (payload as typeof payload & { completion?: Promise<void> }).completion;
    }
    if (completion) return completion;
    if (!dispatched) return Promise.resolve(sendIncomingMessage(entry, "trigger")).then(() => {});
    return Promise.resolve();
  }
  function recordSubagentDeliveryError(entryType: string, to: string, message: string, error: unknown): void {
    pi.appendEntry(entryType, {
      to,
      message,
      error: getErrorMessage(error),
      timestamp: Date.now(),
    });
  }
  function emitResultDelivery(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (!requestId) return;
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
      requestId,
      delivered,
      ...(error ? { error: getErrorMessage(error) } : {}),
    });
  }
  function acknowledgeResult(options: { acknowledge?: boolean }, requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (options.acknowledge) emitResultDelivery(requestId, delivered, error);
  }
  async function deliverLocal(
    parsed: ReturnType<typeof parseSubagentIntercomPayload> & {},
    options: { sender: "subagent-control" | "subagent-result"; status: string; errorEntryType: string; acknowledge?: boolean; terminalBarrier?: { runId: string; terminalId?: string; sourceSessionTargets: string[] } },
  ): Promise<void> {
    try {
      const signature = buildSendSignature(parsed.to, { text: parsed.message });
      const match = parsed.requestId ? localDeliveries.lookup(parsed.requestId, signature) : "miss";
      if (match === "conflict") {
        throw new Error(`Intercom message ID '${parsed.requestId}' was already delivered with a different target or payload`);
      }
      if (match === "miss") {
        const pending = parsed.requestId ? localDeliveriesInFlight.get(parsed.requestId) : undefined;
        if (pending && pending.signature !== signature) {
          await pending.completion;
          throw new Error(`Intercom message ID '${parsed.requestId}' was already delivered with a different target or payload`);
        }
        let delivery = pending?.completion;
        if (!delivery && parsed.requestId) {
          const deferred = Promise.withResolvers<void>();
          delivery = deferred.promise;
          void delivery.catch(() => {});
          localDeliveriesInFlight.set(parsed.requestId, { signature, completion: delivery });
          try {
            void deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message, options.terminalBarrier).then(deferred.resolve, deferred.reject);
          } catch (error) {
            deferred.reject(error);
          }
          void delivery.finally(() => { localDeliveriesInFlight.delete(parsed.requestId!); }).catch(() => {});
        } else if (!delivery) {
          delivery = deliverLocalSubagentRelayMessage(options.sender, options.status, parsed.message, options.terminalBarrier);
        }
        await delivery;
        if (parsed.requestId) localDeliveries.record(parsed.requestId, signature);
      }
      acknowledgeResult(options, parsed.requestId, true);
    } catch (error) {
      try {
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
      } catch (recordError) {
        console.error("Failed to record local subagent relay error:", recordError);
      }
      try {
        acknowledgeResult(options, parsed.requestId, false, error);
      } catch (ackError) {
        console.error("Failed to acknowledge local subagent relay error:", ackError);
      }
    }
  }
  function relaySubagentIntercomPayload(payload: unknown, options: {
    sender: "subagent-control" | "subagent-result";
    status: string;
    errorEntryType: string;
    acknowledge?: boolean;
  }): void {
    const parsed = parseSubagentIntercomPayload(payload);
    if (!parsed) return;
    const terminalBarrier = options.sender === "subagent-result" ? parseSubagentResultBarrier(payload) ?? undefined : undefined;

    const relayGeneration = deps.runtimeGeneration();
    void (async () => {
      const runtimeLive = () => Boolean(getLiveContext(deps.runtimeContext(), relayGeneration));
      const relayStillLive = () => !deps.runtimeStarted() || runtimeLive();
      if (!relayStillLive()) {
        acknowledgeResult(options, parsed.requestId, false);
        return;
      }
      if (currentSessionTargetMatches(parsed.to)) {
        await deliverLocal(parsed, { ...options, terminalBarrier });
        return;
      }
      if (!deps.runtimeStarted()) {
        // The runtime never initialized for this session (no session_start
        // reached the extension and no lifecycle context was available), so a
        // broker connection attempt can only fail. Acknowledge the message as
        // undelivered without recording a misleading connection error entry;
        // callers treat an undelivered ack as their inline-result fallback.
        acknowledgeResult(options, parsed.requestId, false, new Error("Intercom runtime not initialized"));
        return;
      }

      let activeClient: IntercomClient;
      let target: string;
      try {
        activeClient = await ensureConnected("background");
        target = await resolveSessionTarget(activeClient, parsed.to) ?? parsed.to;
      } catch (error) {
        if (!relayStillLive()) {
          acknowledgeResult(options, parsed.requestId, false, error);
          return;
        }
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        acknowledgeResult(options, parsed.requestId, false, error);
        return;
      }

      if (!relayStillLive()) {
        acknowledgeResult(options, parsed.requestId, false);
        return;
      }
      if (currentSessionTargetMatches(parsed.to, target, activeClient)) {
        await deliverLocal(parsed, { ...options, terminalBarrier });
        return;
      }

      try {
        const result = await activeClient.send(target, {
          text: parsed.message,
          ...(parsed.requestId ? { messageId: parsed.requestId } : {}),
        });
        if (!relayStillLive()) {
          acknowledgeResult(options, parsed.requestId, result.delivered);
          return;
        }
        if (!result.delivered) {
          const error = new Error(result.reason ?? "Session may not exist or has disconnected.");
          recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
          acknowledgeResult(options, parsed.requestId, false, error);
          return;
        }
        acknowledgeResult(options, parsed.requestId, true);
      } catch (error) {
        if (!relayStillLive()) {
          acknowledgeResult(options, parsed.requestId, false, error);
          return;
        }
        recordSubagentDeliveryError(options.errorEntryType, parsed.to, parsed.message, error);
        acknowledgeResult(options, parsed.requestId, false, error);
      }
    })();
  }
  pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-control",
      status: "needs_attention",
      errorEntryType: "intercom_control_error",
    });
  });
  pi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, (payload) => {
    relaySubagentIntercomPayload(payload, {
      sender: "subagent-result",
      status: "result",
      errorEntryType: "intercom_result_error",
      acknowledge: true,
    });
  });
}
