/**
 * What a WebSocket's own connection failed with before it opened, which Node.js's WebSocket (undici's) keeps off its
 * `error` event: a refused certificate there reads as an empty error (#6114).
 */

/** Where undici 6 and 7 keep the global dispatcher, and where undici 8 keeps a wrapper of its own for them. */
const LEGACY_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
/** Where undici 8 keeps the global dispatcher. */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.2");

/** An undici dispatcher, as a WebSocket's fetch uses one. */
interface Dispatcher {
	dispatch(options: object, handler: DispatchHandler): boolean;
	readonly isMockActive?: boolean;
	readonly webSocketOptions?: object;
}

/** The callbacks of a dispatched request, in undici 8's form (`onRequestStart`, ...) or the earlier one (`onConnect`, ...). */
type DispatchHandler = { readonly [callback: string]: ((...args: never[]) => unknown) | undefined };

/** The callbacks that report an error, with the error as their last argument, in either form. */
const ERROR_CALLBACKS: ReadonlySet<PropertyKey> = new Set(["onError", "onResponseError"]);
/** The callbacks that report a response, in either form: an error after one is not the connection's. */
const RESPONSE_CALLBACKS: ReadonlySet<PropertyKey> = new Set([
	"onHeaders",
	"onUpgrade",
	"onResponseStart",
	"onRequestUpgrade",
]);

export interface WebSocketTransport {
	/** The dispatcher to give the WebSocket as its `dispatcher` option. */
	readonly dispatcher: object;
	/** The error the connection's last dispatch failed with before any response; undefined when there is none. */
	failure(): unknown;
}

/**
 * A dispatcher for one WebSocket connection, given as its `dispatcher` option, that dispatches on the dispatcher the
 * WebSocket would use anyway and keeps what the connection failed with. Called just before the WebSocket is
 * constructed, which is when undici reads its default: undici 8 dispatches with `onRequestStart` callbacks on the
 * global dispatcher it keeps under `undici.globalDispatcher.2`, undici 6 and 7 with the earlier callbacks on the one
 * under `undici.globalDispatcher.1`. Each dispatcher and handler method is called on its own object. Undefined when no
 * undici has set a global dispatcher, so the WebSocket is constructed as before.
 */
export function observeWebSocketTransport(): WebSocketTransport | undefined {
	const globals = globalThis as { [key: symbol]: Dispatcher | undefined };
	const legacy = globals[LEGACY_GLOBAL_DISPATCHER];
	const current = globals[GLOBAL_DISPATCHER];
	const either = legacy ?? current;
	if (either === undefined) return undefined;
	let chosen: Dispatcher | undefined;
	let failed: unknown;
	const observe = (handler: DispatchHandler): DispatchHandler => {
		let answered = false;
		return new Proxy(handler, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (ERROR_CALLBACKS.has(key))
					return (...args: never[]) => {
						if (!answered) failed = args.at(-1);
						return Reflect.apply(value, target, args);
					};
				if (RESPONSE_CALLBACKS.has(key))
					return (...args: never[]) => {
						answered = true;
						failed = undefined;
						return Reflect.apply(value, target, args);
					};
				return value.bind(target);
			},
		});
	};
	const dispatcher = {
		dispatch(options: object, handler: DispatchHandler): boolean {
			chosen = (typeof handler.onRequestStart === "function" ? current : legacy) ?? either;
			failed = undefined;
			return chosen.dispatch(options, observe(handler));
		},
		// fetch reads it for the request's body, which an upgrade request has none of.
		get isMockActive(): boolean | undefined {
			return (chosen ?? current ?? legacy)?.isMockActive;
		},
		// The WebSocket reads its message limits here once it opened, after the dispatch.
		get webSocketOptions(): object | undefined {
			return chosen?.webSocketOptions;
		},
	};
	return { dispatcher, failure: () => failed };
}
