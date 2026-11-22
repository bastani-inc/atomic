import { Compile } from "@bastani/atomic-ai/utils/typebox/compile";
import { Type } from "@bastani/atomic-ai/utils/typebox/index";
import { registerThemeValidatorLoader } from "../modes/interactive/theme/theme-parse.ts";
import { createThemeJsonSchema } from "../modes/interactive/theme/theme-schema-factory.ts";

registerThemeValidatorLoader(() => Compile(createThemeJsonSchema(Type)));
