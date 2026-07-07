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
	return createRequire(resolutionBaseUrl(moduleUrl));
}

/**
 * A resolution base URL safe for the current runtime.
 *
 * In compiled binaries (monolithic bun or the Atomic split launcher) the
 * bundled `import.meta.url` is the build machine's source URL — a foreign-OS
 * `file://` URL that `fileURLToPath` rejects on other platforms (notably a
 * macOS `file:///Users/...` URL on Windows). Any API that decodes the base
 * (`createRequire`, jiti's `createJiti`) then throws `ERR_INVALID_FILE_URL_PATH`.
 * Anchor to the executable instead, which is always a valid local file URL.
 */
export function resolutionBaseUrl(moduleUrl: string): string {
	return isBunBinary ? pathToFileURL(process.execPath).href : moduleUrl;
}
