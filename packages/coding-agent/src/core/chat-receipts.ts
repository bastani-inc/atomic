/** The isolated terminal needs the same display receipt as an in-process view. Normal RPC and SDK event objects
 * retain their exact shape. The shared weak keys also work across two first-party SDK module instances. */
export interface ChatReceipt {
	readonly id: string;
	readonly anchor: string;
}
const key = Symbol.for("atomic.chat-display-receipts.v1");
const writesKey = Symbol.for("atomic.chat-display-writes.v1");
const global = globalThis as typeof globalThis & {
	[key]?: WeakMap<object, ChatReceipt>;
	[writesKey]?: WeakMap<object, Promise<void>>;
};
global[key] ??= new WeakMap<object, ChatReceipt>();
global[writesKey] ??= new WeakMap<object, Promise<void>>();
const receipts = global[key];
const writes = global[writesKey];
export function bindChatReceipt(event: object, receipt: ChatReceipt, saved?: Promise<void>): void {
	receipts.set(event, receipt);
	if (saved) writes.set(event, saved);
}
/** Local UI handoff only. The store promise is not a session/transport barrier or a wire field. */
export function chatReceiptWrite(event: object): Promise<void> | undefined {
	return writes.get(event);
}
export function chatReceipt(event: object): ChatReceipt | undefined {
	return receipts.get(event);
}
export function receiveChatReceipt(event: object): void {
	const data = event as { atomicChatReceipt?: Partial<ChatReceipt> };
	const receipt = data.atomicChatReceipt;
	delete data.atomicChatReceipt;
	if (receipt && typeof receipt.id === "string" && typeof receipt.anchor === "string")
		bindChatReceipt(event, { id: receipt.id, anchor: receipt.anchor });
}
