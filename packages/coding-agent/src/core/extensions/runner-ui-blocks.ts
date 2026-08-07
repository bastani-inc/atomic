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

import type { UserBlock } from "./block-types.js";
import type { ExtensionUIContext } from "./ui-types.ts";
import { openUserBlock } from "./user-blocks.js";

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
 * The caller's title is used exactly as given, empty string included. Nothing
 * asks for a non-empty label — Herdr's own schema types `message` as nullable
 * string — and substituting the method name for `ui.select("", ...)` would
 * invent text the caller did not write.
 *
 * `custom()` is the one exception, because it takes a component factory and has
 * no title argument at all. The method-name fallback remains only for the
 * impossible case of a titled method called without a string title.
 */
function blockLabel<M extends BlockingUiMethod>(method: M, args: BlockingUiArgs<M>): string {
	if (method === "custom") return "Custom dialog";
	const title = args[0];
	return typeof title === "string" ? title : method;
}

/** Whether a value settles later, across realms and for plain thenables alike. */
function isThenable(value: BlockingUiResult<BlockingUiMethod>): boolean {
	if (value === null) return false;
	if (typeof value !== "object" && typeof value !== "function") return false;
	return typeof Reflect.get(value, "then") === "function";
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

		// `instanceof Promise` is the wrong question. A dialog implemented in
		// another realm — a `vm` context, an isolated host bridge — returns a
		// promise that fails that check, and so does an ordinary thenable, and
		// either one released the block before the user had answered. Ask
		// structurally instead, and keep the synchronous path for a genuine
		// synchronous return so a test double still behaves as before.
		//
		// Reading `then` can itself throw, because it may be a getter. That is
		// inside the guard too: an error here used to reach the caller with the
		// block still open, stranding the pane in `blocked` forever.
		let settlesLater: boolean;
		try {
			settlesLater = isThenable(result);
		} catch (error) {
			block.release();
			throw error;
		}
		if (!settlesLater) {
			block.release();
			return result;
		}
		return Promise.resolve(result).finally(() => block.release()) as BlockingUiResult<M>;
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
 * absent when the host omits them, `"member" in ctx.ui` still answers what it
 * did before, and a member added to the host later is still visible.
 *
 * Every callable member is forwarded on the host object. Raw host-function
 * identity and a forced host receiver cannot both hold — a forwarder is by
 * definition not the function it forwards to — so this keeps the receiver,
 * which is what actually changes behavior, and keeps lookup stable within the
 * wrapped context.
 *
 * The proxy target is a fresh empty surrogate rather than the host itself. A
 * proxy may not return anything but the exact stored value for a
 * non-configurable, non-writable data property on its target, so proxying the
 * host directly makes `withUserBlocks(Object.freeze(host)).select(...)` throw a
 * `TypeError` — and a frozen or individually sealed `ExtensionUIContext` is a
 * perfectly valid one to hand to `AgentSession.bindExtensions`. An extensible
 * surrogate carries no such invariant, so every trap can answer from the host
 * while still substituting the forwarder.
 *
 * Two meta-object operations are refused rather than forwarded, because a proxy
 * cannot both keep an empty extensible target and satisfy them: defining a
 * *non-configurable* property, and sealing the wrapper with
 * `Object.preventExtensions` or `Object.freeze`. Both now fail immediately and
 * leave the host and the wrapper exactly as they were; the alternative was
 * mutating the host and then throwing, or silently breaking every later
 * `Object.keys` on the wrapper. Freeze or seal the host *before* wrapping it —
 * that is supported, and tested.
 */
export function withUserBlocks(ui: ExtensionUIContext): ExtensionUIContext {
	const existing = wrappedContexts.get(ui);
	if (existing) return existing;

	const memberCache = new Map<PropertyKey, CachedUiMember>();
	const surrogate = Object.create(Object.getPrototypeOf(ui) as object | null) as ExtensionUIContext;
	const wrapped = new Proxy(surrogate, {
		// Reads resolve against the host object, not the proxy, so a getter on the
		// host sees its own `this` and cannot trip over a private field.
		get(_surrogate, property) {
			const value = Reflect.get(ui, property, ui);
			if (typeof value !== "function") return value;
			const callable = value as UiCallable;
			const cached = memberCache.get(property);
			// A getter may hand back a different function later; only reuse the
			// forwarder while it still wraps the function the host just returned.
			if (cached && cached.original === callable) return cached.wrapped;
			const created = isBlockingUiMethod(property)
				? (wrapBlockingMethod(property, ui, value as BlockingUiFunction<BlockingUiMethod>) as UiCallable)
				: wrapHostMethod(ui, callable);
			memberCache.set(property, { original: callable, wrapped: created });
			return created;
		},
		has(_surrogate, property) {
			return Reflect.has(ui, property);
		},
		ownKeys() {
			return Reflect.ownKeys(ui);
		},
		getOwnPropertyDescriptor(_surrogate, property) {
			const descriptor = Reflect.getOwnPropertyDescriptor(ui, property);
			if (!descriptor) return undefined;
			// The surrogate holds no own properties, so a reported descriptor must
			// be configurable for the proxy invariants to accept it. This is what
			// keeps `Object.keys`, spread, and `JSON.stringify` seeing the host.
			return { ...descriptor, configurable: true };
		},
		// Writes must reach the host too. Without these the surrogate quietly
		// absorbed every assignment: the host never saw it, and the surrogate
		// gained an own property that then contradicted the descriptor this proxy
		// reports, so the very next read or `Object.keys` threw. The receiver is
		// the host, not the proxy, so a host setter sees its own object.
		set(_surrogate, property, value) {
			return Reflect.set(ui, property, value, ui);
		},
		defineProperty(_surrogate, property, descriptor) {
			// Refused before the host is touched. A proxy may only report a
			// non-configurable definition as succeeding if its own target carries a
			// matching property, and the surrogate deliberately carries none — so
			// forwarding first mutated the host and *then* threw, leaving the caller
			// with an error and the host already changed. Failing up front keeps the
			// two consistent: `Object.defineProperty` throws, and the host is exactly
			// as it was.
			if (descriptor.configurable === false) return false;
			return Reflect.defineProperty(ui, property, descriptor);
		},
		deleteProperty(_surrogate, property) {
			return Reflect.deleteProperty(ui, property);
		},
		/**
		 * Refuse to seal the wrapper.
		 *
		 * Without this the default trap sealed the *surrogate*, and an empty
		 * non-extensible target cannot report the host's keys — so `Object.keys`,
		 * spread, and `JSON.stringify` all began throwing on a context that had
		 * merely been passed to `Object.freeze`. Refusing makes the freeze fail
		 * loudly and immediately while leaving the wrapper fully usable.
		 *
		 * Sealing a wrapped context is not something Phase 1 defines, and making it
		 * succeed through to the host needs a mirrored shadow target rather than an
		 * empty surrogate — a redesign that would give up the frozen-host and
		 * host-receiver behavior this wrapper exists to preserve. Freeze the host
		 * before wrapping it instead; that is supported and tested.
		 */
		preventExtensions() {
			return false;
		},
	});
	wrappedContexts.set(ui, wrapped);
	// A second `withUserBlocks(wrapped)` — for instance from a host that already
	// received a wrapped context — must not stack a second block per dialog.
	wrappedContexts.set(wrapped, wrapped);
	return wrapped;
}
