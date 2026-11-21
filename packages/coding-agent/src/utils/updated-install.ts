/**
 * A running process keeps every module it has loaded and loads the rest on demand from the installation on disk. An
 * in-place update (`npm install -g` or `bun add -g` of a new version over this one) replaces those files while the
 * process runs: a newer file that names an export the copy this process loaded lacks fails to link, and a file the
 * update removed is gone. Neither can succeed until the process restarts, so code loaded on demand reports them as such.
 */
import { APP_NAME, detectInstallChangeAsync, type InstallChange } from "../config.js";

/** A feature whose code could not load because the installation changed under this process. */
export class UpdatedInstallError extends Error {
	readonly feature: string;

	constructor(message: string, feature: string, cause: unknown) {
		super(message, { cause });
		this.name = "UpdatedInstallError";
		this.feature = feature;
	}
}

const LINK_FAILURE =
	/does not provide an export named|Export named '[^']*' not found in module|Named export '[^']*' not found/;
const LOAD_FAILURE_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);

/**
 * Whether `error` is the runtime failing to load a module: one that names an export its dependency lacks (Node and Bun
 * report a `SyntaxError` when they link it), or one that is not there (a removed file, package or package export).
 */
export function isModuleLoadFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code === "string" && LOAD_FAILURE_CODES.has(code)) return true;
	return error instanceof SyntaxError && typeof message === "string" && LINK_FAILURE.test(message);
}

/**
 * What a failed on-demand load of `feature` says when `change` happened to the installation since this process
 * started: undefined when the failure is not a module that could not load, or the installation did not change.
 */
export function updatedInstallMessage(
	error: unknown,
	feature: string,
	change: InstallChange | undefined,
): string | undefined {
	if (change === undefined || !isModuleLoadFailure(error)) return undefined;
	return change.kind === "updated"
		? `${APP_NAME} was updated to ${change.version} while this session was running; restart it to keep using ${feature}.`
		: `The ${APP_NAME} installation this session runs from was removed or replaced; restart it to keep using ${feature}.`;
}

/**
 * The {@link UpdatedInstallError} a failed on-demand load of `feature` becomes when it failed because an update replaced
 * the installation under this process; undefined when it failed for any other reason.
 */
export async function updatedInstallError(error: unknown, feature: string): Promise<UpdatedInstallError | undefined> {
	if (error instanceof UpdatedInstallError) return error;
	if (!isModuleLoadFailure(error)) return undefined;
	const message = updatedInstallMessage(error, feature, await detectInstallChangeAsync());
	return message === undefined ? undefined : new UpdatedInstallError(message, feature, error);
}

/**
 * Run `load`, which loads code of `feature` on demand (directly or anywhere inside it). A module that cannot load
 * because an update replaced the installation while this process runs rejects with an {@link UpdatedInstallError}
 * naming `feature`; every other outcome is `load`'s own.
 */
export async function loadOnDemand<T>(feature: string, load: () => Promise<T>): Promise<T> {
	try {
		return await load();
	} catch (error) {
		throw (await updatedInstallError(error, feature)) ?? error;
	}
}
