export const BUILTIN_PACKAGE_DIR_NAMES = [
	"workflows",
	"subagents",
	"mcp",
	"web-access",
	"intercom",
	"feedback",
] as const;

export type BuiltinPackageDirName = (typeof BUILTIN_PACKAGE_DIR_NAMES)[number];

/** Source-checkout extension entries. Discovery still loads these in a git tree. */
export const SOURCE_EXTENSION_ENTRIES = {
	workflows: "src/extension/index.ts",
	subagents: "src/extension/index.ts",
	mcp: "index.ts",
	"web-access": "index.ts",
	intercom: "index.ts",
	feedback: "index.ts",
} as const satisfies Record<BuiltinPackageDirName, string>;

/** Installed/npm extension entries after copy-builtin-packages prebundles them. */
export const INSTALLED_EXTENSION_ENTRIES = {
	workflows: "src/extension/index.bundle.mjs",
	subagents: "src/extension/index.bundle.mjs",
	mcp: "index.bundle.mjs",
	"web-access": "index.bundle.mjs",
	intercom: "index.bundle.mjs",
	feedback: "index.bundle.mjs",
} as const satisfies Record<BuiltinPackageDirName, string>;

export const WORKFLOWS_SDK_BUNDLE_ENTRY = "src/index.js";
export const INTERCOM_BROKER_BUNDLE_ENTRY = "broker/broker.bundle.mjs";

export function requiredEntriesForBuiltin(dirName: BuiltinPackageDirName): readonly string[] {
	return [INSTALLED_EXTENSION_ENTRIES[dirName], SOURCE_EXTENSION_ENTRIES[dirName]];
}
