import type { ExtensionContext } from "@bastani/atomic";
import type { Message, SessionInfo } from "./types.js";

export interface IntercomExtensionTestOverrides {
  captureInboundHandler?: (handler: (ctx: ExtensionContext, from: SessionInfo, message: Message) => void) => void;
}
