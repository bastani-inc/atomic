/**
 * Block-minting wrapper around `ExtensionUIContext`.
 *
 * Applied once, at the `get ui()` accessor in `runner-context.ts`, so every
 * extension that opens a blocking dialog reports the agent as blocked without
 * knowing the block door exists.
 *
 * The wrapper is transparent by construction: it awaits the host method, hands
 * back exactly what the host returned, lets rejections propagate untouched, and
 * releases its block in `finally` so an abort ends the block too.
 */

import type { UserBlock } from "./block-types.ts";
import type { ExtensionUIContext } from "./ui-types.ts";
import { openUserBlock } from "./user-blocks.ts";

/** The dialog methods that stop the agent until the user answers. */
const BLOCKING_UI_METHODS = ["select", "confirm", "input", "custom", "editor"] as const;

type BlockingUiMethod = (typeof BLOCKING_UI_METHODS)[number];

const blockingUiMethods = new Set<string>(BLOCKING_UI_METHODS);

const isBlockingUiMethod = (property: string | symbol): property is BlockingUiMethod =>
	typeof property === "string" && blockingUiMethods.has(property);

/**
 * The short label reported while the dialog is open.
 *
 * `custom()` takes a component factory rather than a title, so there is no
 * caller-supplied text to use and a fixed label is reported instead.
 */
function blockLabel(method: BlockingUiMethod, args: readonly unknown[]): string {
	if (method === "custom") return "Custom dialog";
	const title = args[0];
	return typeof title === "string" && title.length > 0 ? title : method;
}

type UnknownFunction = (...args: never[]) => unknown;

function wrapBlockingMethod(method: BlockingUiMethod, original: UnknownFunction, self: ExtensionUIContext) {
	return function blockingUiCall(this: unknown, ...args: never[]): unknown {
		let block: UserBlock;
		try {
			block = openUserBlock(blockLabel(method, args), "dialog");
		} catch {
			// The block door must never be the reason a dialog fails to open.
			return Reflect.apply(original, this ?? self, args);
		}

		let result: unknown;
		try {
			result = Reflect.apply(original, this ?? self, args);
		} catch (error) {
			block.release();
			throw error;
		}

		// The host methods all return promises, but a test double or a future
		// synchronous implementation must not strand the block.
		if (!(result instanceof Promise)) {
			block.release();
			return result;
		}
		return result.finally(() => block.release());
	};
}

const wrappedContexts = new WeakMap<ExtensionUIContext, ExtensionUIContext>();

/**
 * Return a block-minting view of `ui`.
 *
 * Memoized per underlying context so `ctx.ui === ctx.ui` and
 * `ctx.ui.select === ctx.ui.select` keep holding, exactly as they did before
 * wrapping existed.
 */
export function withUserBlocks(ui: ExtensionUIContext): ExtensionUIContext {
	const existing = wrappedContexts.get(ui);
	if (existing) return existing;

	const methodCache = new Map<BlockingUiMethod, UnknownFunction>();
	const wrapped = new Proxy(ui, {
		get(target, property, receiver): unknown {
			const value = Reflect.get(target, property, receiver);
			if (!isBlockingUiMethod(property) || typeof value !== "function") return value;
			const cached = methodCache.get(property);
			if (cached) return cached;
			const created = wrapBlockingMethod(property, value as UnknownFunction, target);
			methodCache.set(property, created as UnknownFunction);
			return created;
		},
	});
	wrappedContexts.set(ui, wrapped);
	// A second `withUserBlocks(wrapped)` — for instance from a host that already
	// received a wrapped context — must not stack a second block per dialog.
	wrappedContexts.set(wrapped, wrapped);
	return wrapped;
}
