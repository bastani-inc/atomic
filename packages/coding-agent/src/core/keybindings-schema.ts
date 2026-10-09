import { type TSchema, Type } from "typebox";
import { KeybindingValueSchema, keybindingValueSchema } from "./key-id-schema.ts";
import { KEYBINDINGS } from "./keybindings.ts";

export { KeybindingValueSchema } from "./key-id-schema.ts";

/** The schema is published once for every platform, so descriptions that vary by platform at runtime read generically. */
const PUBLISHED_DESCRIPTIONS: Readonly<Record<string, string>> = {
	"app.suspend": "Suspend to background; on Windows, open a PowerShell subshell",
};

const properties: Record<string, TSchema> = {
	$schema: Type.Optional(Type.String()),
};

for (const [id, definition] of Object.entries(KEYBINDINGS)) {
	properties[id] = Type.Optional(
		keybindingValueSchema({
			description: PUBLISHED_DESCRIPTIONS[id] ?? definition.description,
		}),
	);
}

export const KeybindingsSchema = Type.Object(properties, {
	additionalProperties: KeybindingValueSchema,
});
