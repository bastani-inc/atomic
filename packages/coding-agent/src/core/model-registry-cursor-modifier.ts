import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai/compat";

function isExactCursorModel(model: Model<Api>): boolean {
	return model.provider === "cursor";
}

function cloneCursorModel(model: Model<Api>): Model<Api> {
	return structuredClone(model);
}

function deepFreeze<T extends object>(value: T, seen = new Set<object>()): T {
	if (seen.has(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const child = Reflect.get(value, key);
		if (child !== null && typeof child === "object") deepFreeze(child, seen);
	}
	return Object.freeze(value);
}

/**
 * Preserve the provider-published top-level identity while isolating every
 * nested value from objects that may be shared with unrelated providers.
 * Freezing then makes the canonical capability safe to expose by reference.
 */
export function publishImmutableCursorModel(model: Model<Api>): Model<Api> {
	if (Object.isFrozen(model)) return model;
	const isolated = structuredClone(model) as Model<Api>;
	const target = model as unknown as Record<PropertyKey, unknown>;
	for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key);
	Object.defineProperties(target, Object.getOwnPropertyDescriptors(isolated));
	return deepFreeze(model);
}

/**
 * OAuth model modifiers may transform ordinary providers, but exact lowercase
 * Cursor rows are authenticated registry capabilities. Give modifiers isolated
 * copies, discard every Cursor row they return, and restore the original
 * canonical objects in their original order/positions.
 */
export function applyModelModifierPreservingCursor(
	models: Model<Api>[],
	credentials: OAuthCredentials,
	modifyModels: (models: Model<Api>[], credentials: OAuthCredentials) => Model<Api>[],
): Model<Api>[] {
	const canonicalCursorRows = models
		.map((model, index) => ({ model, index }))
		.filter(({ model }) => isExactCursorModel(model));
	const modifierInput = models.map((model) => isExactCursorModel(model) ? cloneCursorModel(model) : model);
	const modified = modifyModels(modifierInput, credentials).filter((model) => !isExactCursorModel(model));
	for (const { model, index } of canonicalCursorRows) {
		modified.splice(Math.min(index, modified.length), 0, model);
	}
	return modified;
}
