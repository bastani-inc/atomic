import { AsyncLocalStorage } from "node:async_hooks";
import type { Extension, ExtensionRuntime } from "./types.ts";

type Callback = (...args: never[]) => unknown;

// Source and built loaders can wrap one another's registrations. Keep the weak identity tables shared across that boundary.
const registrationsKey = Symbol.for("atomic.extension-registration-identities.v2");
type RegistrationIdentities = {
	originals: WeakMap<Callback, Callback>;
	startup: WeakMap<Callback, string>;
	sourceIds: WeakMap<object, number>;
	nextId: number;
};
const registrationsHost = globalThis as typeof globalThis & { [registrationsKey]?: RegistrationIdentities };
registrationsHost[registrationsKey] ??= {
	originals: new WeakMap(),
	startup: new WeakMap(),
	sourceIds: new WeakMap(),
	nextId: 0,
};
const identities = registrationsHost[registrationsKey];
const originalCallbacks = identities.originals;

function objectId(source: object): number {
	let id = identities.sourceIds.get(source);
	if (id === undefined) {
		id = identities.nextId++;
		identities.sourceIds.set(source, id);
	}
	return id;
}

/** The construction recipe survives the supported built/source loader boundary and a loader override's shallow copy. */
export const extensionSource = Symbol.for("atomic.extension-source.v1");

/** A factory object (SDK) or canonical module path (file), never its display name. */
export function startupSourceId(source: object | string): string {
	return typeof source === "string" ? `file:${source}` : `object:${objectId(source)}`;
}

export function registerFactoryStartupHandler(handler: Callback, owner: string, event: string, ordinal: number): void {
	identities.startup.set(originalRegistrationCallback(handler), JSON.stringify([owner, event, ordinal]));
}

/** Identify the registrations in a dispatch snapshot. Neighbouring handlers and their ordering are not part of a token. */
export function startupRegistrationTokens(
	extension: Extension,
	handlers: readonly Callback[],
	copies: Map<string, number>,
): string[] {
	const recipe = (
		extension as Extension & { [extensionSource]?: { registrationSource: object | string; factory: Callback } }
	)[extensionSource];
	const owner = recipe ? startupSourceId(recipe.registrationSource ?? recipe.factory) : "raw";
	return handlers.map((handler) => {
		const original = originalRegistrationCallback(handler);
		const registration = identities.startup.get(original) ?? `raw:${objectId(original)}`;
		const token = JSON.stringify([owner, registration]);
		// A loader can deliberately install the very same callable twice. Count its copies, not its list indices.
		const copy = copies.get(token) ?? 0;
		copies.set(token, copy + 1);
		return `${token}:${copy}`;
	});
}

function retainCallbackIdentity(wrapped: Callback, original: Callback): Callback {
	originalCallbacks.set(wrapped, originalCallbacks.get(original) ?? original);
	return wrapped;
}

/** Inspection returns the authored callback; hosts invoke its owned registration separately. */
export function originalRegistrationCallback<T extends Callback>(callback: T): T {
	return (originalCallbacks.get(callback) ?? callback) as T;
}

interface Invocation {
	runtimes: Map<ExtensionRuntime, ExtensionRuntime>;
	extensions: Map<Extension, Extension>;
	callbacks: Map<Callback, Callback>;
}
// Built/source loaders can coexist. This is invocation context, not a session cache.
const key = Symbol.for("atomic.extension-invocation.v1");
const host = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<Invocation> };
host[key] ??= new AsyncLocalStorage<Invocation>();
const invocation = host[key];

export function resolveInvocationRuntime(runtime: ExtensionRuntime): ExtensionRuntime {
	return invocation.getStore()?.runtimes.get(runtime) ?? runtime;
}

export function invocationRuntime(runtime: ExtensionRuntime): ExtensionRuntime {
	return new Proxy(runtime, {
		get(target, key) {
			return Reflect.get(invocation.getStore()?.runtimes.get(target) ?? target, key);
		},
		set(target, key, value) {
			return Reflect.set(invocation.getStore()?.runtimes.get(target) ?? target, key, value);
		},
	});
}

export function invocationExtension(extension: Extension): Extension {
	return new Proxy(extension, {
		get(target, key) {
			return Reflect.get(invocation.getStore()?.extensions.get(target) ?? target, key);
		},
		set(target, key, value) {
			return Reflect.set(invocation.getStore()?.extensions.get(target) ?? target, key, value);
		},
	});
}

/** Rebuild a plain object, keeping each own key's enumerability (TypeBox hides `~kind` from JSON this way). */
function mapOwnProperties(source: object, map: (key: string | symbol) => unknown): object {
	const target = {};
	for (const key of Reflect.ownKeys(source)) {
		const { enumerable } = Reflect.getOwnPropertyDescriptor(source, key)!;
		Object.defineProperty(target, key, { value: map(key), enumerable, writable: true, configurable: true });
	}
	return target;
}

/** Snapshot registration containers, retaining opaque values and function identities. */
export function copyRegistrations<T>(value: T, functions?: (fn: Callback) => Callback): T {
	if (typeof value === "function") return (functions ? functions(value as Callback) : value) as T;
	if (value instanceof Map)
		return new Map([...value].map(([key, item]) => [key, copyRegistrations(item, functions)])) as T;
	if (Array.isArray(value)) return value.map((item) => copyRegistrations(item, functions)) as T;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return mapOwnProperties(value, (key) => copyRegistrations(Reflect.get(value, key), functions)) as T;
	}
	return value;
}

export const registrationFields = [
	"handlers",
	"tools",
	"commands",
	"flags",
	"shortcuts",
	"messageRenderers",
	"toolRenderers",
	"entryRenderers",
	"markdownTransformer",
] as const;

export function prepareRegistrationCallbacks(extension: Extension): void {
	for (const key of registrationFields) {
		Reflect.set(
			extension,
			key,
			copyRegistrations(extension[key], (fn) => {
				const wrapped = function (this: unknown, ...args: unknown[]) {
					const replacement = invocation.getStore()?.callbacks.get(wrapped);
					return Reflect.apply(replacement ?? fn, this, args);
				};
				return retainCallbackIdentity(wrapped, fn);
			}),
		);
	}
}

export function createInvocationBindings(sourceRuntime: ExtensionRuntime, runtime: ExtensionRuntime): Invocation {
	return { runtimes: new Map([[sourceRuntime, runtime]]), extensions: new Map(), callbacks: new Map() };
}

/** Three-way registration merge: replay unchanged factory state, preserve every caller edit. */
export function reconcileRegistration(
	source: unknown,
	baseline: unknown,
	fresh: unknown,
	bindings: Invocation,
): unknown {
	if (typeof baseline === "function" && typeof fresh === "function")
		bindings.callbacks.set(baseline as Callback, fresh as Callback);
	if (source === baseline) return fresh;
	if (source instanceof Map && baseline instanceof Map && fresh instanceof Map) {
		return new Map(
			[...source].map(([key, value]) => [
				key,
				baseline.has(key) ? reconcileRegistration(value, baseline.get(key), fresh.get(key), bindings) : value,
			]),
		);
	}
	if (Array.isArray(source) && Array.isArray(baseline) && Array.isArray(fresh)) {
		return source.map((value, index) => {
			const originalIndex = baseline.indexOf(value);
			const slot = originalIndex < 0 ? index : originalIndex;
			return reconcileRegistration(value, baseline[slot], fresh[slot], bindings);
		});
	}
	if (
		source &&
		baseline &&
		fresh &&
		typeof source === "object" &&
		typeof baseline === "object" &&
		typeof fresh === "object" &&
		Object.getPrototypeOf(source) === Object.prototype &&
		Object.getPrototypeOf(baseline) === Object.prototype
	) {
		return mapOwnProperties(source, (key) =>
			Object.hasOwn(baseline, key)
				? reconcileRegistration(
						Reflect.get(source, key),
						Reflect.get(baseline, key),
						Reflect.get(fresh, key),
						bindings,
					)
				: Reflect.get(source, key),
		);
	}
	return source;
}

export function bindRegistrationCallbacks(extension: Extension, bindings: Invocation): void {
	for (const key of registrationFields) {
		Reflect.set(
			extension,
			key,
			copyRegistrations(extension[key], (fn) =>
				retainCallbackIdentity(function (this: unknown, ...args: unknown[]) {
					return invocation.run(bindings, () => Reflect.apply(fn, this, args));
				}, fn),
			),
		);
	}
}

/** Registrations made by copied APIs retain the registering invocation after it returns. */
export function captureRegistrationInvocation<T>(value: T, sourceRuntime: ExtensionRuntime): T {
	const bindings = invocation.getStore();
	if (!bindings?.runtimes.has(sourceRuntime)) return value;
	return copyRegistrations(value, (fn) =>
		retainCallbackIdentity(function (this: unknown, ...args: unknown[]) {
			return invocation.run(bindings, () => Reflect.apply(fn, this, args));
		}, fn),
	);
}
