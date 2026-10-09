import type { Extension } from "../../src/core/extensions/types.js";
import { BUILTIN_PATH_PREFIX } from "../../src/core/source-info.js";
import { defaultBuiltinExtensions } from "../../src/extensions/default-builtins.js";

const defaultBuiltinPaths = new Set(
	defaultBuiltinExtensions.flatMap((input) =>
		typeof input === "function" ? [] : [`${BUILTIN_PATH_PREFIX}${input.name}`],
	),
);

export function withoutDefaultBuiltins(extensions: readonly Extension[]): Extension[] {
	return extensions.filter((extension) => !defaultBuiltinPaths.has(extension.path));
}
