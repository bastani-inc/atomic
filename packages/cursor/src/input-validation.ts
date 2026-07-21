import type { Context } from "@earendil-works/pi-ai/compat";
import { CursorError } from "./errors.js";

export function assertCurrentCursorInputIsTextOnly(context: Context, modelId: string): void {
	const last = context.messages.at(-1);
	if (last?.role === "user" && typeof last.content !== "string" && last.content.some((part) => part.type === "image")) {
		throw new CursorError("ProtocolError", `Cursor model ${JSON.stringify(modelId)} accepts text only; current user images are unsupported.`, { operation: "request" });
	}
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "toolResult") break;
		if (message.content.some((part) => part.type === "image")) {
			throw new CursorError("ProtocolError", "Cursor accepts text-only live tool results; image content is unsupported.", { operation: "request" });
		}
	}
}
