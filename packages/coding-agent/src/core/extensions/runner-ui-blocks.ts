/**
 * Block-minting wrapper around `ExtensionUIContext`.
 *
 * Applied once, at the `get ui()` accessor in `runner-context.ts`, so every
 * extension that opens a blocking dialog reports the agent as blocked without
 * knowing the block door exists.
 *
 * The wrapper is transparent by construction: it calls the host method on the
 * host's own object, hands back exactly what the host returned, lets rejections
 * propagate untouched, and releases its block in `finally` so an abort ends the
 * block too.
 */

import type { UserBlock } from "./block-types.ts";
import type { ExtensionUIContext } from "./ui-types.ts";
import { openUserBlock } from "./user-blocks.ts";

/** The dialog methods that stop the agent until the user answers. */
const BLOCKING_UI_METHODS = ["select", "confirm", "input", "custom", "editor"] as const;

type BlockingUiMethod = (typeof BLOCKING_UI_METHODS)[number];

/** The host's own signature for one blocking dialog. */
type BlockingUiFunction<M extends BlockingUiMethod> = ExtensionUIContext[M];

type BlockingUiArgs<M extends BlockingUiMethod> = Parameters<BlockingUiFunction<M>>;

type BlockingUiResult<M extends BlockingUiMethod> = ReturnType<BlockingUiFunction<M>>;

const blockingUiMethods = new Set<string>(BLOCKING_UI_METHODS);

const isBlockingUiMethod = (property: string | symbol): property is BlockingUiMethod =>
	typeof property === "string" && blockingUiMethods.has(property);

/**
 * The short label reported while the dialog is open.
 *
 * `custom()` takes a component factory rather than a title, so there is no
 * caller-supplied text to use and a fixed label is reported instead.
 */
function blockLabel<M extends BlockingUiMethod>(method: M, args: BlockingUiArgs<M>): string {
	if (method === "custom") return "Custom dialog";
	const title = args[0];
	return typeof title === "string" && title.length > 0 ? title : method;
}

/**
 * Wrap one blocking dialog so it mints a block for its duration.
 *
 * The host method is always applied to `host`, never to the proxy. A host that
 * keys per-instance state off its own object identity — a `WeakMap`, a private
 * field — would otherwise see a different receiver after wrapping and silently
 * change behavior, which is exactly what wrapping must not do.
 */
function wrapBlockingMethod<M extends BlockingUiMethod>(
	method: M,
	host: ExtensionUIContext,
	original: BlockingUiFunction<M>,
): BlockingUiFunction<M> {
	const wrapped = (...args: BlockingUiArgs<M>): BlockingUiResult<M> => {
		let block: UserBlock;
		try {
			block = openUserBlock(blockLabel(method, args), "dialog");
		} catch {
			// The block door must never be the reason a dialog fails to open.
			return Reflect.apply(original, host, args) as BlockingUiResult<M>;
		}

		let result: BlockingUiResult<M>;
		try {
			result = Reflect.apply(original, host, args) as BlockingUiResult<M>;
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
		return result.finally(() => block.release()) as BlockingUiResult<M>;
	};
	return wrapped as BlockingUiFunction<M>;
}

/**
 * Any callable member of the UI context, blocking or not.
 *
 * `never[]` keeps this assignable from every concrete method signature without
 * widening a single argument to `any` or `unknown`.
 */
type UiCallable = (...args: never[]) => void;

/**
 * Forward a non-blocking member to the host, on the host.
 *
 * `notify`, `setStatus`, `setWidget` and the rest are pass-through, but they
 * still have to be *called* on the host object. Returning the raw function let
 * `ctx.ui.notify(...)` run with the proxy as `this`, which throws outright on a
 * class-based host reading a private field — a host that worked before wrapping
 * existed.
 *
 * The declared `void` return is a type-level detail only: the arrow returns
 * whatever the host returned. Callers never see this signature, because the
 * proxy is typed as `ExtensionUIContext` and a `get` trap's return type does not
 * reach them — which is what lets this stay free of `any` and `unknown` and
 * still carry generic methods like `custom<T>` and the `setWidget` overloads
 * through untouched.
 */
function wrapHostMethod(host: ExtensionUIContext, original: UiCallable): UiCallable {
	return (...args: never[]) => Reflect.apply(original, host, args);
}

/** One member's forwarder, kept only while the host still returns the same function. */
interface CachedUiMember {
	original: UiCallable;
	wrapped: UiCallable;
}

const wrappedContexts = new WeakMap<ExtensionUIContext, ExtensionUIContext>();

/**
 * Return a block-minting view of `ui`.
 *
 * Memoized per underlying context so `ctx.ui === ctx.ui` holds, and per member
 * so `ctx.ui.select === ctx.ui.select` and `ctx.ui.notify === ctx.ui.notify`
 * hold too. A proxy rather than a copy, so the host's optional members stay
 * absent when the host omits them and `"member" in ctx.ui` still answers what it
 * did before.
 *
 * Every callable member is forwarded on the host object. Raw host-function
 * identity and a forced host receiver cannot both hold — a forwarder is by
 * definition not the function it forwards to — so this keeps the receiver,
 * which is what actually changes behavior, and keeps lookup stable within the
 * wrapped context.
 */
export function withUserBlocks(ui: ExtensionUIContext): ExtensionUIContext {
	const existing = wrappedContexts.get(ui);
	if (existing) return existing;

	const memberCache = new Map<PropertyKey, CachedUiMember>();
	const wrapped = new Proxy(ui, {
		// Reads resolve against the host object, not the proxy, so a getter on the
		// host sees its own `this` and cannot trip over a private field.
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const callable = value as UiCallable;
			const cached = memberCache.get(property);
			// A getter may hand back a different function later; only reuse the
			// forwarder while it still wraps the function the host just returned.
			if (cached && cached.original === callable) return cached.wrapped;
			const created = isBlockingUiMethod(property)
				? (wrapBlockingMethod(property, target, value as BlockingUiFunction<BlockingUiMethod>) as UiCallable)
				: wrapHostMethod(target, callable);
			memberCache.set(property, { original: callable, wrapped: created });
			return created;
		},
	});
	wrappedContexts.set(ui, wrapped);
	// A second `withUserBlocks(wrapped)` — for instance from a host that already
	// received a wrapped context — must not stack a second block per dialog.
	wrappedContexts.set(wrapped, wrapped);
	return wrapped;
}
