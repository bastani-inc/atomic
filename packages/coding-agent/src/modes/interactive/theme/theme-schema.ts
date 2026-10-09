import { type Static, type TProperties, Type } from "typebox";
import { Compile } from "typebox/compile";
import { THEME_TOKENS, type ThemeColorValues, type ThemeTokenDescriptors } from "./theme-tokens.ts";

function colorValue(description?: string) {
	return Type.Union(
		[
			Type.String({
				description:
					"Hex color (#RRGGBB), OKHSL color (okhsl(H S L)), variable reference, or empty string for terminal default",
			}),
			Type.Integer({
				minimum: 0,
				maximum: 255,
				description: "256-color palette index (0-255)",
			}),
		],
		description ? { description } : {},
	);
}

export const ColorValueSchema = colorValue();

export type ColorValue = Static<typeof ColorValueSchema>;

function themeTokenProperties(tokens: ThemeTokenDescriptors): TProperties {
	const properties: TProperties = {};
	for (const [name, descriptor] of Object.entries(tokens)) {
		const schema = colorValue(descriptor.description);
		properties[name] = descriptor.fallback === undefined ? schema : Type.Optional(schema);
	}
	return properties;
}

const ThemeColorsSchema = Type.Unsafe<ThemeColorValues<ColorValue>>(
	Type.Object(themeTokenProperties(THEME_TOKENS), {
		description:
			"Theme color definitions (scrollbarThumb and the search highlight colors are optional and fall back to compatible colors)",
		additionalProperties: false,
	}),
);

export const ThemeJsonSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON schema reference" })),
		name: Type.String({
			pattern: "^[^/]+$",
			description:
				"Theme name. Must not contain '/' because it is reserved for automatic light/dark theme settings.",
		}),
		vars: Type.Optional(
			Type.Record(Type.String(), ColorValueSchema, {
				description: "Reusable color variables",
			}),
		),
		colors: ThemeColorsSchema,
		workingIndicator: Type.Optional(
			Type.Object(
				{
					dark: Type.Optional(ColorValueSchema),
					lift: Type.Optional(ColorValueSchema),
					muted: Type.Optional(ColorValueSchema),
					accent: Type.Optional(ColorValueSchema),
					bright: Type.Optional(ColorValueSchema),
					peak: Type.Optional(ColorValueSchema),
				},
				{
					description: "Optional partial six-tone palette for Atomic's ordinary working identity",
					additionalProperties: false,
				},
			),
		),
		export: Type.Optional(
			Type.Object(
				{
					pageBg: Type.Optional(colorValue("Page background color")),
					cardBg: Type.Optional(colorValue("Card/container background color")),
					infoBg: Type.Optional(colorValue("Info sections background (system prompt, notices)")),
				},
				{
					description: "Optional colors for HTML export (defaults derived from userMessageBg if not specified)",
					additionalProperties: false,
				},
			),
		),
	},
	{
		title: "Atomic Coding Agent Theme",
		description: "Theme schema for the Atomic coding agent",
		additionalProperties: false,
	},
);

export type ThemeJson = Static<typeof ThemeJsonSchema>;

export const validateThemeJson = Compile(ThemeJsonSchema);
