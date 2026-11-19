/** The isolated terminal needs the same display receipt as an in-process view. Normal RPC and SDK event objects
 * retain their exact shape. The shared weak keys also work across two first-party SDK module instances. */
export interface ChatReceipt {
	readonly id: string;
	readonly anchor: string;
}
const key = Symbol.for("atomic.chat-display-receipts.v1");
const global = globalThis as typeof globalThis & { [key]?: WeakMap<object, ChatReceipt> };
global[key] ??= new WeakMap<object, ChatReceipt>();
const receipts = global[key];
export function bindChatReceipt(event: object, receipt: ChatReceipt): void {
	receipts.set(event, receipt);
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
