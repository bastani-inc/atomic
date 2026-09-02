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
}
