import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isBunBinary } from "../config.ts";

/**
 * createRequire anchored so bare-specifier resolution works in every runtime.
 *
 * In the compiled binary the bundle is CJS (bytecode), where import.meta.url
 * is rewritten to the original build-machine source path; requiring through it
 * would resolve node_modules against paths that do not exist on user machines.
 * Anchor to the executable instead so resolution walks from the node_modules
 * shipped next to the binary.
 */
export function createModuleRequire(moduleUrl: string): NodeJS.Require {
	return createRequire(isBunBinary ? pathToFileURL(process.execPath).href : moduleUrl);
}
