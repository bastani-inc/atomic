import type { Middleware } from "@anthropic-ai/sdk";

// The native provider constructs new params per request. A frozen hook result can be shared or
// replaced; never mark it, modify a client-wide encoder, or wrap the caller's fetch/admission.
interface Receipt {
	key?: WeakRef<object>;
	rewrite?: (json: string) => string;
}
let pending: WeakMap<object, Receipt> | undefined;
let count = 0;

function retire(receipt: Receipt): void {
	if (!receipt.rewrite) return;
	const key = receipt.key?.deref();
	if (key) pending?.delete(key);
	receipt.key = undefined;
	receipt.rewrite = undefined;
	if (--count === 0) pending = undefined;
}

/** @internal Hand off only a qualified first fork request. The caller also retires on stream failure. */
export function stageAnthropicSerializedBody(key: object, rewrite: (json: string) => string): () => void {
	const previous = pending?.get(key);
	if (previous) retire(previous);
	const receipt: Receipt = { key: new WeakRef(key), rewrite };
	pending ??= new WeakMap();
	pending.set(key, receipt);
	count++;
	return retire.bind(undefined, receipt);
}

function rewriteOnce(transform: Receipt["rewrite"]): Middleware {
	return (request, next) => {
		const rewrite = transform;
		transform = undefined;
		if (rewrite && typeof request.body === "string") request.body = rewrite(request.body);
		return next(request);
	};
}

/** @internal Consume before sending. With no pending fork there is not even a payload lookup. */
export function takeAnthropicSerializedBody(key: object): Middleware | undefined {
	const receipt = pending?.get(key);
	if (!receipt) return undefined;
	const rewrite = receipt.rewrite;
	retire(receipt);
	return rewriteOnce(rewrite);
}
