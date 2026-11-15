import type { TSchema } from "typebox";
import { SettingsSchema } from "./settings-schema.ts";

/** A setting, or one of its list entries, removed from a loaded file because the schema does not accept its JSON type. */
export interface InvalidSettingValue {
	/** The top-level setting, such as `extensions`. */
	setting: string;
	/** The removed value: the setting itself, or a list entry such as `extensions[2]`. */
	key: string;
	/** The JSON types the schema accepts there, such as `array of string`. */
	expected: string;
	/** The JSON type that was found, such as `string`. */
	actual: string;
}

interface SchemaNode {
	type?: string | string[];
	const?: string | number | boolean | null;
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

/** Every JSON type the schema accepts. Every settings schema node is a union, a literal, or names its type. */
function acceptedTypes(schema: SchemaNode): string[] {
	if (schema.anyOf) return schema.anyOf.flatMap(acceptedTypes);
	if (schema.const !== undefined) return [jsonTypeOf(schema.const)];
	return [schema.type ?? []].flat();
}

/** Top-level settings and list entries never use `integer`; integer fields live inside objects, which are not checked. */
function hasType(schema: SchemaNode, value: JsonValue): boolean {
	return acceptedTypes(schema).includes(jsonTypeOf(value));
}

function describe(schema: SchemaNode): string {
	const types = [...new Set(acceptedTypes(schema))];
	return types.map((type) => (type === "array" ? `array of ${describe(arrayItems(schema))}` : type)).join(" or ");
}

function arrayItems(schema: SchemaNode): SchemaNode {
	return schema.items ?? schema.anyOf!.find((member) => member.type === "array")!.items!;
}

/**
 * A deprecated object form, such as the legacy `skills: { customDirectories }`, is migrated into current settings by
 * code that trusts its field types, so its declared fields must have the right types too.
 */
function hasWrongTypedLegacyFields(schema: SchemaNode, value: JsonValue): boolean {
	const legacy = schema.anyOf?.find((member) => member.deprecated)?.properties ?? {};
	const fields = jsonTypeOf(value) === "object" ? (value as { [key: string]: JsonValue }) : {};
	return Object.entries(legacy).some(([key, field]) => key in fields && !hasType(field, fields[key]!));
}

function collect(
	properties: Record<string, SchemaNode>,
	settings: { [key: string]: JsonValue },
	invalid: InvalidSettingValue[],
): void {
	for (const [setting, schema] of Object.entries(properties)) {
		if (!Object.hasOwn(settings, setting)) continue;
		const value = settings[setting]!;
		if (!hasType(schema, value) || hasWrongTypedLegacyFields(schema, value)) {
			invalid.push({ setting, key: setting, expected: describe(schema), actual: jsonTypeOf(value) });
			delete settings[setting];
			continue;
		}
		if (!Array.isArray(value)) continue;
		const items = arrayItems(schema);
		settings[setting] = value.filter((item, index) => {
			if (hasType(items, item)) return true;
			invalid.push({ setting, key: `${setting}[${index}]`, expected: describe(items), actual: jsonTypeOf(item) });
			return false;
		});
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
	collect((SettingsSchema as TSchema & SchemaNode).properties!, settings, invalid);
	return invalid;
}

export function invalidSettingMessage({ key, expected, actual }: InvalidSettingValue): string {
	return `"${key}" must be ${expected}, not ${actual}; ignoring it.`;
}
