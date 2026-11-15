import type { TSchema } from "typebox";
import { SettingsSchema } from "./settings-schema.ts";

/** A setting removed from a loaded file because its JSON type is not one the schema accepts. */
export interface InvalidSettingValue {
	/** The dropped setting, such as `extensions`, or list entry, such as `extensions[2]`. */
	key: string;
	/** The JSON types the schema accepts there, such as `array of string`. */
	expected: string;
}

interface SchemaNode {
	type?: string | string[];
	const?: string | number | boolean | null;
	enum?: (string | number | boolean | null)[];
	anyOf?: SchemaNode[];
	items?: SchemaNode;
	properties?: Record<string, SchemaNode>;
	deprecated?: boolean;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function jsonTypeOf(value: JsonValue): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Every JSON type the schema accepts, or `undefined` when it accepts any value. */
function acceptedTypes(schema: SchemaNode): Set<string> | undefined {
	if (schema.anyOf) {
		const types = new Set<string>();
		for (const member of schema.anyOf) {
			const memberTypes = acceptedTypes(member);
			if (!memberTypes) return undefined;
			for (const type of memberTypes) types.add(type);
		}
		return types;
	}
	if (schema.const !== undefined) return new Set([jsonTypeOf(schema.const)]);
	if (schema.enum) return new Set(schema.enum.map(jsonTypeOf));
	if (schema.type === undefined) return undefined;
	return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
}

function hasType(schema: SchemaNode, value: JsonValue): boolean {
	const types = acceptedTypes(schema);
	if (!types) return true;
	const type = jsonTypeOf(value);
	if (types.has(type)) return true;
	return type === "number" && types.has("integer") && Number.isInteger(value);
}

function describe(schema: SchemaNode): string {
	const types = acceptedTypes(schema);
	if (!types) return "any value";
	return [...types]
		.map((type) => (type === "array" && schema.items ? `array of ${describe(schema.items)}` : type))
		.join(" or ");
}

/**
 * A deprecated object form, such as the legacy `skills: { customDirectories }`, is migrated into current settings by
 * code that trusts its field types, so its declared fields must have the right types too.
 */
function hasWrongTypedLegacyFields(schema: SchemaNode, value: { [key: string]: JsonValue }): boolean {
	const legacy = schema.anyOf?.find((member) => member.deprecated && member.properties);
	return Object.entries(legacy?.properties ?? {}).some(
		([key, field]) => Object.hasOwn(value, key) && !hasType(field, value[key]!),
	);
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayItems(schema: SchemaNode): SchemaNode | undefined {
	return schema.items ?? schema.anyOf?.find((member) => member.type === "array")?.items;
}

function collect(
	properties: Record<string, SchemaNode>,
	settings: { [key: string]: JsonValue },
	invalid: InvalidSettingValue[],
): void {
	for (const [key, schema] of Object.entries(properties)) {
		if (!Object.hasOwn(settings, key)) continue;
		const value = settings[key]!;
		if (!hasType(schema, value) || (isObject(value) && hasWrongTypedLegacyFields(schema, value))) {
			invalid.push({ key, expected: describe(schema) });
			delete settings[key];
			continue;
		}
		const items = Array.isArray(value) ? arrayItems(schema) : undefined;
		if (!Array.isArray(value) || !items) continue;
		const kept = value.filter((item, index) => {
			if (hasType(items, item)) return true;
			invalid.push({ key: `${key}[${index}]`, expected: describe(items) });
			return false;
		});
		if (kept.length !== value.length) settings[key] = kept;
	}
}

/**
 * Remove every top-level setting, and every list entry, whose JSON type the settings schema does not accept. A removed
 * setting reads as unset, so the next settings layer or the default applies. Values of the right type that break a
 * narrower rule (a range, a pattern, an allowed word, a field inside an object) are kept for the accessor that owns
 * that rule. Mutates `settings` and returns what was removed.
 */
export function dropWrongTypedSettings(settings: Record<string, JsonValue>): InvalidSettingValue[] {
	const invalid: InvalidSettingValue[] = [];
	collect((SettingsSchema as TSchema & SchemaNode).properties ?? {}, settings, invalid);
	return invalid;
}

export function invalidSettingMessage({ key, expected }: InvalidSettingValue): string {
	return `"${key}" must be ${expected}; ignoring it.`;
}
