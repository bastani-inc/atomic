import type { ExtensionContext } from "@bastani/atomic";
import type { Message, SessionInfo } from "./types.js";

export type IntercomConnectReason = "startup" | "background" | "tool" | "overlay";

export interface IntercomExtensionTestOverrides {
  captureInboundHandler?: (handler: (ctx: ExtensionContext, from: SessionInfo, message: Message) => void) => void;
  /**
   * Invoked at the start of every broker connection attempt, before the broker is spawned.
   * Throwing (or rejecting) fails exactly that attempt through the production catch/finally
   * path, which is how a test forces a single reconnect failure deterministically.
   */
  beforeConnectAttempt?: (reason: IntercomConnectReason) => void | Promise<void>;
  /**
   * Bound on how long a connection attempt waits for the broker to answer `register`, chosen per client by its
   * return address (the session id for the main client, `<session>:pending-stage-route:<group>` for the routes of an invocation group).
   * Returning `undefined` keeps the production bound, which is how a test makes one connection time out quickly.
   */
  connectTimeoutMs?: (returnAddress: string) => number | undefined;
}
