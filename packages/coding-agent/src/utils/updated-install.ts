/**
 * A running process keeps every module it has loaded and loads the rest on demand from the installation on disk. An
 * in-place update (`npm install -g` or `bun add -g` of a new version over this one) replaces those files while the
 * process runs: a newer file that names an export the copy this process loaded lacks fails to link, and a file the
 * update removed is gone. Neither can succeed until the process restarts, so code loaded on demand reports them as such.
 * A module of anything else, such as a user's extension, that cannot load keeps its own error: a restart would not
 * change it.
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, detectInstallChangeAsync, getPackageDir, type InstallChange } from "../config.js";

/** A feature whose code could not load because the installation changed under this process. */
export class UpdatedInstallError extends Error {
	readonly feature: string;

	constructor(message: string, feature: string, cause: unknown) {
		super(message, { cause });
		this.name = "UpdatedInstallError";
		this.feature = feature;
	}
}

/** Node's and Bun's link errors: an import names an export its dependency lacks. */
const LINK_FAILURE =
	/does not provide an export named|Export named '[^']*' not found in module|Named export '[^']*' not found|^export '[^']*' not found in '/;
const LOAD_FAILURE_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);
/** Atomic's own packages, by name or installed (a package manager that hoists dependencies, Bun, puts them beside it). */
const OWN_PACKAGE =
	/^@bastani\/atomic(?:-(?:ai|tui|agent-core|codemode|schema|telemetry|natives))?(?:\/|$)|[\\/]node_modules[\\/]@bastani[\\/]atomic(?:-(?:ai|tui|agent-core|codemode|schema|telemetry|natives))?[\\/]/;

interface ModuleLoadError {
	readonly code?: unknown;
	readonly message?: unknown;
	readonly stack?: unknown;
	/** Node's ES module loader: the URL of the module file that is missing. */
	readonly url?: unknown;
	/** Node's CommonJS loader: the files that required the missing module, the nearest first. */
	readonly requireStack?: unknown;
	/** Bun: the file that imported the missing module, and what it asked for. */
	readonly referrer?: unknown;
	readonly specifier?: unknown;
}

/**
 * Whether `error` is the runtime failing to load a module: one that names an export its dependency lacks (Node and Bun
 * report a `SyntaxError` when they link it), or one that is not there (a removed file, package or package export).
 */
export function isModuleLoadFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, message } = error as ModuleLoadError;
	if (typeof code === "string" && LOAD_FAILURE_CODES.has(code)) return true;
	return error instanceof SyntaxError && typeof message === "string" && LINK_FAILURE.test(message);
}

/** The module `request` names when `importer` asks for it: a file path, or the package name of a bare request. */
function requested(request: string, importer: string | undefined): string {
	if (!request.startsWith(".") && !request.startsWith("/") && !request.startsWith("file:") && !isAbsolute(request)) {
		// A package: Atomic's own is part of it wherever it is installed; any other belongs to whoever asked for it.
		return OWN_PACKAGE.test(request) || importer === undefined ? request : importer;
	}
	if (request.startsWith("file:") || isAbsolute(request)) return request;
	if (importer === undefined) return request;
	const from = importer.startsWith("file:") ? fileURLToPath(importer) : importer;
	return resolve(dirname(from), request);
}

/**
 * Whose module could not load, as the error tells it: the missing file itself, the package a module asked for (or,
 * for a package that is not Atomic's own, the module that asked), or the module whose import fails to link (Bun names
 * the module that lacks the export instead). Undefined when the error does not say.
 */
function failedLoadLocation(error: ModuleLoadError): string | undefined {
	const message = typeof error.message === "string" ? error.message : "";
	if (typeof error.url === "string") return error.url;
	if (typeof error.referrer === "string" && typeof error.specifier === "string")
		return requested(error.specifier, error.referrer);
	if (Array.isArray(error.requireStack)) {
		const request = /Cannot find module '([^']+)'/.exec(message)?.[1];
		const importer = typeof error.requireStack[0] === "string" ? error.requireStack[0] : undefined;
		return request === undefined ? importer : requested(request, importer);
	}
	const exportsMap = / is not defined by "exports" in (.+?package\.json)/.exec(message)?.[1];
	if (exportsMap !== undefined) return exportsMap;
	const missing = /Cannot find (?:module|package) '([^']+)' imported from (.+)$/m.exec(message);
	if (missing) return requested(missing[1]!, missing[2]);
	// Node's link error: the stack opens with the importing module's URL and line.
	const linking = typeof error.stack === "string" ? /^(file:\/\/\S+?):\d+$/m.exec(error.stack)?.[1] : undefined;
	if (linking !== undefined) return linking;
	return /not found in module '([^']+)'|^export '[^']*' not found in '([^']+)'/.exec(message)?.slice(1).find(Boolean);
}

/** Whether `location`, a path, a file URL or a package name, is part of the installation this process runs from. */
function partOfInstallation(location: string): boolean {
	if (OWN_PACKAGE.test(location)) return true;
	let path: string;
	try {
		path = location.startsWith("file:") ? fileURLToPath(location) : location;
	} catch {
		return false;
	}
	if (!isAbsolute(path)) return false;
	const inside = relative(getPackageDir(), resolve(path));
	return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

/** Whether `error` is a module of the installation that could not load (see {@link isModuleLoadFailure}). */
function isInstallationLoadFailure(error: unknown): boolean {
	if (!isModuleLoadFailure(error)) return false;
	const location = failedLoadLocation(error as ModuleLoadError);
	return location !== undefined && partOfInstallation(location);
}

/**
 * What a failed on-demand load of `feature` says when `change` happened to the installation since this process
 * started: that it needs a restart, then the runtime's error. Undefined when the failure is not a module of the
 * installation that could not load, or the installation did not change.
 */
export function updatedInstallMessage(
	error: unknown,
	feature: string,
	change: InstallChange | undefined,
): string | undefined {
	if (change === undefined || !isInstallationLoadFailure(error)) return undefined;
	const restart =
		change.kind === "updated"
			? `${APP_NAME} was updated to ${change.version} while this session was running; restart it to keep using ${feature}.`
			: `The ${APP_NAME} installation this session runs from was removed or replaced; restart it to keep using ${feature}.`;
	// The runtime's own error follows, so nothing it said is lost.
	const { message } = error as ModuleLoadError;
	return typeof message === "string" && message !== "" ? `${restart}\n${message}` : restart;
}

/**
 * The {@link UpdatedInstallError} a failed on-demand load of `feature` becomes when it failed because an update replaced
 * the installation under this process; undefined when it failed for any other reason.
 */
export async function updatedInstallError(error: unknown, feature: string): Promise<UpdatedInstallError | undefined> {
	if (error instanceof UpdatedInstallError) return error;
	if (!isInstallationLoadFailure(error)) return undefined;
	const message = updatedInstallMessage(error, feature, await detectInstallChangeAsync());
	return message === undefined ? undefined : new UpdatedInstallError(message, feature, error);
}

/**
 * Run `load`, which loads code of `feature` on demand (directly or anywhere inside it). A module of the installation
 * that cannot load because an update replaced the installation while this process runs rejects with an
 * {@link UpdatedInstallError} naming `feature`; every other outcome is `load`'s own.
 */
export async function loadOnDemand<T>(feature: string, load: () => Promise<T>): Promise<T> {
	try {
		return await load();
	} catch (error) {
		throw (await updatedInstallError(error, feature)) ?? error;
	}
}
