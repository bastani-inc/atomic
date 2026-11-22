import { APP_NAME, detectInstallChangeAsync, isBunBinary, VERSION } from "../config.js";
import { createModuleRequire } from "./module-require.js";

/**
 * Atomic cannot run a session without its native module (`@bastani/atomic-natives`): its subagents, for one, are built
 * on it. The message says why the module did not load, as its loader words it: for a platform package an install left
 * out, which package and how to reinstall Atomic with it. A native module of another release is refused too: when an
 * update replaced the installation under this process, with how to restart, and otherwise, the installation being
 * broken, with how to reinstall it.
 */
export class NativeModuleUnavailableError extends Error {
	readonly code = "NativeModuleUnavailable";

	constructor(message: string, options: { cause?: unknown } = {}) {
		super(message, options);
		this.name = "NativeModuleUnavailableError";
	}
}

/** Why this process cannot run its native module, before the message says whether the installation changed. */
export interface NativeModuleProblem {
	/** The loader's own message, or why the native module it loaded cannot run this release. */
	readonly message: string;
	/** Whether it could not load at all; the restart advice then comes before the loader's message. */
	readonly loadFailed: boolean;
	readonly cause?: unknown;
}

/** The version of every package in a source checkout, which no native module is checked against. */
const SOURCE_CHECKOUT_VERSION = "0.0.0";

interface NativeBinding {
	/** The release the native module was built for; a native module of a release before it existed lacks it. */
	readonly nativeVersion?: () => string;
}

let loaded = false;

/**
 * Why the native module `binding` cannot run this release, or undefined when it can. Only a release is checked: not a
 * source checkout, not a native module given with `NAPI_RS_NATIVE_LIBRARY_PATH`, and not the standalone binary, which
 * carries its own.
 */
function versionMismatch(binding: NativeBinding): string | undefined {
	if (VERSION === SOURCE_CHECKOUT_VERSION || isBunBinary || process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return undefined;
	const nativeVersion = typeof binding.nativeVersion === "function" ? binding.nativeVersion() : undefined;
	if (nativeVersion === VERSION) return undefined;
	return (
		`${APP_NAME}'s native module (@bastani/atomic-natives) is from ${nativeVersion ?? "an earlier release"}, not ${VERSION}: ` +
		`its installation is broken. Reinstall ${APP_NAME}: npm install -g @bastani/atomic, pnpm add -g @bastani/atomic or ` +
		"bun add -g @bastani/atomic; in a project, run its install again."
	);
}

/**
 * Load Atomic's native module, and say why this process cannot run it: it did not load, or it is of another release.
 * Undefined when it can. Only a load that passed is kept: a later call tries again, so a process that outlives a
 * reinstall can use the module then.
 */
export function nativeModuleProblem(): NativeModuleProblem | undefined {
	if (loaded) return undefined;
	let binding: NativeBinding;
	try {
		binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as NativeBinding;
	} catch (error) {
		// The loader's own message is its first line: the rest is a resolution's require stack.
		const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
		return { message, loadFailed: true, cause: error };
	}
	const mismatch = versionMismatch(binding);
	if (mismatch !== undefined) return { message: mismatch, loadFailed: false };
	loaded = true;
	return undefined;
}

/**
 * The {@link NativeModuleUnavailableError} of `problem`: when an update replaced or removed the installation since this
 * process started, it says to restart (before the loader's message, for a module that could not load); otherwise it is
 * the problem's own message.
 */
export async function nativeModuleUnavailable(problem: NativeModuleProblem): Promise<never> {
	const change = await detectInstallChangeAsync();
	const restart =
		change === undefined
			? undefined
			: change.kind === "updated"
				? `${APP_NAME} was updated to ${change.version} while this process was running; restart it.`
				: `The ${APP_NAME} installation this process runs from was removed or replaced; restart it.`;
	const message =
		restart === undefined ? problem.message : problem.loadFailed ? `${restart}\n${problem.message}` : restart;
	throw new NativeModuleUnavailableError(message, problem.cause === undefined ? {} : { cause: problem.cause });
}
