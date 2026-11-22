import { Compile } from "@bastani/atomic-ai/utils/typebox/compile";
import { type Static, Type } from "@bastani/atomic-ai/utils/typebox/index";
import { createColorValueSchema, createThemeJsonSchema } from "./theme-schema-factory.ts";

export const ColorValueSchema = createColorValueSchema(Type);

export type ColorValue = Static<typeof ColorValueSchema>;

export const ThemeJsonSchema = createThemeJsonSchema(Type);

export type ThemeJson = Static<typeof ThemeJsonSchema>;

export const validateThemeJson = Compile(ThemeJsonSchema);
