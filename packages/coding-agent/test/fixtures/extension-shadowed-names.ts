import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Names an extension module may declare at its top level that the code the loader adds, or jiti's transform, also
 * reads: globals and the parameters of jiti's module wrapper. `globalThis` is not one of them: a module cannot declare
 * its own and still be loaded.
 */
export const SHADOWED_NAMES = [
	"URL",
	"Error",
	"process",
	"Symbol",
	"Promise",
	"Object",
	"WeakMap",
	"Reflect",
	"require",
	"module",
	"exports",
	"__filename",
	"__dirname",
	"jitiImport",
	"jitiESMResolve",
	"_importMeta",
	"__atomicImportMeta",
	"__atomicReloadable",
] as const;

/**
 * Writes an extension under `root` with one module per name, each declaring that name at its top level and then using
 * `import.meta`, `__dirname`, a namespace import and `import()`; its factory emits `shadowed-names` with what each saw.
 */
export function writeShadowedNamesExtension(root: string): string {
	fs.writeFileSync(path.join(root, "helper.ts"), 'export const value = "helper";\nexport default 1;\n');
	for (const name of SHADOWED_NAMES) {
		fs.writeFileSync(
			path.join(root, `shadow-${name}.ts`),
			`import * as nodePath from "node:path";
export * from "./helper.ts";
const ${name} = "mine";
export const probe = async () => [
	${name},
	import.meta.url,
	import.meta.resolve("./not-yet-created.json"),
	typeof __dirname,
	typeof nodePath.join,
	(await import("./helper.ts")).value,
];
`,
		);
	}
	const entry = path.join(root, "extension.ts");
	fs.writeFileSync(
		entry,
		`${SHADOWED_NAMES.map((name) => `import { probe as ${name.replace(/^_+/, "u_")}Probe } from "./shadow-${name}.ts";`).join("\n")}
export default async function (pi) {
	pi.events.emit("shadowed-names", {
${SHADOWED_NAMES.map((name) => `		${JSON.stringify(name)}: await ${name.replace(/^_+/, "u_")}Probe(),`).join("\n")}
	});
}
`,
	);
	return entry;
}

/** What each module of {@link writeShadowedNamesExtension} sees, as when it is imported natively. */
export function expectedShadowedNames(root: string): Record<string, unknown[]> {
	return Object.fromEntries(
		SHADOWED_NAMES.map((name) => [
			name,
			[
				"mine",
				pathToFileURL(path.join(root, `shadow-${name}.ts`)).href,
				pathToFileURL(path.join(root, "not-yet-created.json")).href,
				"string",
				"function",
				"helper",
			],
		]),
	);
}
