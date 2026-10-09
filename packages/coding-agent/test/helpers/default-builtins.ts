import type { Extension } from "../../src/core/extensions/types.ts";
import { BUILTIN_PATH_PREFIX } from "../../src/core/source-info.ts";
import { defaultBuiltinExtensions } from "../../src/extensions/default-builtins.ts";

const defaultBuiltinPaths = new Set(
	defaultBuiltinExtensions.flatMap((input) =>
		typeof input === "function" ? [] : [`${BUILTIN_PATH_PREFIX}${input.name}`],
	),
);

export function withoutDefaultBuiltins(extensions: readonly Extension[]): Extension[] {
	return extensions.filter((extension) => !defaultBuiltinPaths.has(extension.path));
}
