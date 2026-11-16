import type { WorkflowSerializableValue } from "./types.js";

type PayloadInput = object | string | number | boolean | bigint | symbol | undefined | null;

function boxedKind(value: object): "number" | "string" | "boolean" | "bigint" | undefined {
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype === Object.prototype || prototype === null || Array.isArray(value)) return undefined;
	} catch {
		return undefined;
	}
	try {
		Number.prototype.valueOf.call(value);
		return "number";
	} catch {}
	try {
		String.prototype.valueOf.call(value);
		return "string";
	} catch {}
	try {
		Boolean.prototype.valueOf.call(value);
		return "boolean";
	} catch {}
	try {
		BigInt.prototype.valueOf.call(value);
		return "bigint";
	} catch {}
	return undefined;
}

function cloneValue(source: PayloadInput, key: string, ancestors: Set<object>): WorkflowSerializableValue | undefined {
	let value = source;
	if ((value !== null && (typeof value === "object" || typeof value === "function")) || typeof value === "bigint") {
		const convert = (value as { toJSON?: (key: string) => PayloadInput }).toJSON;
		if (typeof convert === "function") value = convert.call(value, key);
	}
	if (value !== null && typeof value === "object") {
		const kind = boxedKind(value);
		if (kind === "number") value = Number(value);
		else if (kind === "string") value = String(value);
		else if (kind === "boolean") value = Boolean.prototype.valueOf.call(value);
		else if (kind === "bigint") throw new TypeError("BigInt cannot be serialized");
	}
	if (value === null) return null;
	const json = JSON as typeof JSON & { isRawJSON?: (value: object) => boolean };
	if (typeof value === "object" && json.isRawJSON?.(value) === true) {
		return JSON.parse((value as { rawJSON: string }).rawJSON) as WorkflowSerializableValue;
	}
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
		case "bigint":
			throw new TypeError("BigInt cannot be serialized");
		case "undefined":
		case "function":
		case "symbol":
			return undefined;
	}
	if (ancestors.has(value)) throw new TypeError("Circular snapshot value cannot be serialized");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return Array.from(
				{ length: value.length },
				(_, index) => cloneValue(value[index], String(index), ancestors) ?? null,
			);
		}
		const result: Record<string, WorkflowSerializableValue> = {};
		for (const name of Object.keys(value)) {
			const item = cloneValue((value as Record<string, PayloadInput>)[name], name, ancestors);
			if (item === undefined) continue;
			if (name === "__proto__")
				Object.defineProperty(result, name, { value: item, enumerable: true, configurable: true, writable: true });
			else result[name] = item;
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

export function cloneInspectionPayload<T extends object>(value: T): T {
	return cloneValue(value, "", new Set()) as T;
}
