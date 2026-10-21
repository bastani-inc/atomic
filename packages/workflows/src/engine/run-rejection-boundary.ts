import { inspect } from "node:util";

export type RejectionContainment = (error: object) => void;

const BOUNDARY_KEY = Symbol.for("atomic-workflows/run-rejection-boundary@1");
const MAX_CAUSE_DEPTH = 8;

interface RejectionBoundary {
	readonly version: 1;
	readonly owners: WeakMap<object, Set<RejectionContainment>>;
	installed: boolean;
}

function boundaryBag(): Record<symbol, RejectionBoundary | undefined> {
	return globalThis as typeof globalThis & Record<symbol, RejectionBoundary | undefined>;
}

function sharedBoundary(): RejectionBoundary {
	const bag = boundaryBag();
	const existing = bag[BOUNDARY_KEY];
	if (existing !== undefined && existing.version === 1) return existing;
	const created: RejectionBoundary = { version: 1, owners: new WeakMap(), installed: false };
	bag[BOUNDARY_KEY] = created;
	return created;
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function safeField(value: object, key: "cause" | "errors"): unknown {
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

function containmentsFor(boundary: RejectionBoundary, reason: unknown): Set<RejectionContainment> {
	const found = new Set<RejectionContainment>();
	const seen = new Set<object>();
	const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: reason, depth: 0 }];
	while (pending.length > 0) {
		const { value, depth } = pending.pop()!;
		if (!isObject(value) || seen.has(value) || depth > MAX_CAUSE_DEPTH) continue;
		seen.add(value);
		for (const containment of boundary.owners.get(value) ?? []) found.add(containment);
		pending.push({ value: safeField(value, "cause"), depth: depth + 1 });
		const errors = safeField(value, "errors");
		if (Array.isArray(errors)) for (const entry of errors) pending.push({ value: entry, depth: depth + 1 });
	}
	return found;
}

function unhandledRejectionError(reason: unknown): Error {
	return Object.assign(
		new Error(
			"This error originated either by throwing inside of an async function without a catch block, " +
				`or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${inspect(reason)}".`,
		),
		{ code: "ERR_UNHANDLED_REJECTION" },
	);
}

function onUnhandledRejection(reason: unknown): void {
	const containments = containmentsFor(sharedBoundary(), reason);
	if (containments.size > 0) {
		for (const contain of containments) {
			try {
				contain(isObject(reason) ? reason : unhandledRejectionError(reason));
			} catch {}
		}
		return;
	}
	if (process.listenerCount("unhandledRejection") > 1) return;
	throw reason instanceof Error ? reason : unhandledRejectionError(reason);
}

function ensureInstalled(boundary: RejectionBoundary): void {
	if (boundary.installed) return;
	boundary.installed = true;
	process.on("unhandledRejection", onUnhandledRejection);
}

export function containRejectionsOf<T>(promise: Promise<T>, contain: RejectionContainment): Promise<T> {
	void promise.catch((error: unknown) => {
		if (!isObject(error)) return;
		const boundary = sharedBoundary();
		ensureInstalled(boundary);
		const owners = boundary.owners.get(error);
		if (owners === undefined) boundary.owners.set(error, new Set([contain]));
		else owners.add(contain);
	});
	return promise;
}
