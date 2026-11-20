import type { ExtensionAPI, SessionManager } from "../../src/index.ts";

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];

// #6097: a custom message's display is a boolean; earlier web-access releases sent "tool".
export const shown: Message = { customType: "notice", content: "shown", display: true };
export const hidden: Message = { customType: "notice", content: "hidden", display: false };
// @ts-expect-error display is a boolean, not a rendering hint
export const named: Message = { customType: "notice", content: "named", display: "tool" };
// @ts-expect-error display is required
export const missing: Message = { customType: "notice", content: "missing" };
export const batch: Parameters<ExtensionAPI["sendMessages"]>[0] = [
	// @ts-expect-error display is a boolean in a batch too
	{ customType: "notice", content: "named", display: "tool" },
];
export type AppendDisplay = Parameters<SessionManager["appendCustomMessageEntry"]>[2];
// @ts-expect-error a saved custom message entry takes a boolean display
export const appended: AppendDisplay = "tool";
