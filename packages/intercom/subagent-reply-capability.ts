import type { ExtensionAPI } from "@bastani/atomic";
import type { IntercomClient } from "./broker/client.js";
import type { SessionInfo } from "./types.js";

/** Execution termination is not agent_end: interactive idle remains replyable. */
export function registerSubagentReplyCapability(
  pi: Pick<ExtensionAPI, "on">,
  client: () => Pick<IntercomClient, "updatePresence"> | null,
): () => SessionInfo["replyCapability"] {
  let signal: AbortSignal | undefined;
  let unbind: (() => void) | undefined;
  const capability = (): SessionInfo["replyCapability"] => {
    if (!signal) return undefined;
    return signal.aborted ? "terminal" : "live";
  };
  pi.on("session_start", (_event, ctx) => {
    unbind?.();
    signal = ctx.subagentPolicy?.executionEnded;
    const current = signal;
    const terminal = () => {
      if (signal !== current) return;
      client()?.updatePresence({ replyCapability: "terminal" });
    };
    current?.addEventListener("abort", terminal, { once: true });
    unbind = () => current?.removeEventListener("abort", terminal);
    if (current?.aborted) terminal();
  });
  pi.on("session_shutdown", () => {
    unbind?.();
    unbind = undefined;
    signal = undefined;
  });
  return capability;
}
