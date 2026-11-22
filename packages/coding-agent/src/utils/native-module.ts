import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { APP_NAME, detectInstallChangeAsync, isBunBinary, NATIVES_VERSION } from "../config.js";
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
	/**
	 * For a native module of another release: the file this process loaded it from and the release it needs. When the
	 * package of that file on disk is of that release by now, it was reinstalled while this process ran: a restart
	 * loads it. The process keeps the one it loaded until then, as other parts of it already use that one.
	 */
	readonly refused?: { readonly file: string; readonly release: string };
}

/** The version of every package in a source checkout, which no native module is checked against. */
const SOURCE_CHECKOUT_VERSION = "0.0.0";

interface NativeBinding {
	/** The release the native module was built for; a native module of a release before it existed lacks it. */
	readonly nativeVersion?: () => string;
}

let loaded = false;

/**
 * Why the native module `binding` cannot run this release, or undefined when it can: it must be of the release of
 * `@bastani/atomic-natives` the package pins (`NATIVES_VERSION`), which is its own version but for a package that
 * republishes Atomic under another name and version. Only a release is checked: not a source checkout, not a package
 * that pins no exact release of the native module (an app that bundles the SDK), not a native module given with
 * `NAPI_RS_NATIVE_LIBRARY_PATH`, and not the standalone binary, which carries its own.
 */
function versionMismatch(binding: NativeBinding): string | undefined {
	const release = NATIVES_VERSION;
	if (
		release === undefined ||
		release === SOURCE_CHECKOUT_VERSION ||
		isBunBinary ||
		process.env.NAPI_RS_NATIVE_LIBRARY_PATH
	)
		return undefined;
	const nativeVersion = typeof binding.nativeVersion === "function" ? binding.nativeVersion() : undefined;
	if (nativeVersion === release) return undefined;
	return (
		`${APP_NAME}'s native module (@bastani/atomic-natives) is from ${nativeVersion ?? "an earlier release"}, not ${release}: ` +
		`its installation is broken. Reinstall ${APP_NAME}: npm install -g @bastani/atomic, pnpm add -g @bastani/atomic or ` +
		"bun add -g @bastani/atomic; in a project, run its install again."
	);
}

/** The native module file a `require` of the native module loaded: the one a platform package of it holds. */
function loadedNativeFile(require: NodeJS.Require): string | undefined {
	return Object.keys(require.cache ?? {})
		.filter((file) => /^atomic_natives\..+\.node$/.test(basename(file)))
		.at(-1);
}

/**
 * Whether the package of the native module file `file` (its own directory's package.json, or its parent's for one
 * beside the loader) is of `release` on disk now.
 */
async function reinstalledSince(file: string, release: string): Promise<boolean> {
	for (const directory of [dirname(file), dirname(dirname(file))]) {
		try {
			const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { version?: unknown };
			return manifest.version === release;
		} catch {
			// No package.json here: the next directory up.
		}
	}
	return false;
}

/**
 * Load Atomic's native module, and say why this process cannot run it: it did not load, or it is of another release.
 * Undefined when it can. Only a load that passed is kept: a later call tries again, so a module that could not load at
 * all can be used once it is installed. One of another release stays loaded, and refused, until the process restarts.
 */
export function nativeModuleProblem(): NativeModuleProblem | undefined {
	if (loaded) return undefined;
	let binding: NativeBinding;
	const require = createModuleRequire(import.meta.url);
	try {
		binding = require("@bastani/atomic-natives") as NativeBinding;
	} catch (error) {
		// The loader's own message is its first line: the rest is a resolution's require stack.
		const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
		return { message, loadFailed: true, cause: error };
	}
	const mismatch = versionMismatch(binding);
	if (mismatch !== undefined) {
		const file = loadedNativeFile(require);
		return {
			message: mismatch,
			loadFailed: false,
			...(file !== undefined && NATIVES_VERSION !== undefined
				? { refused: { file, release: NATIVES_VERSION } }
				: {}),
		};
	}
	loaded = true;
	return undefined;
}

/**
 * The {@link NativeModuleUnavailableError} of `problem`: when an update replaced or removed the installation since this
 * process started, or the native module this process refused was reinstalled in the right release since, it says to
 * restart (before the loader's message, for a module that could not load); otherwise it is the problem's own message.
 */
export async function nativeModuleUnavailable(problem: NativeModuleProblem): Promise<never> {
	const change = await detectInstallChangeAsync();
	const reinstalled =
		change === undefined &&
		problem.refused !== undefined &&
		(await reinstalledSince(problem.refused.file, problem.refused.release));
	const restart =
		change === undefined
			? reinstalled
				? `${APP_NAME}'s native module was reinstalled while this process was running; restart it.`
				: undefined
			: change.kind === "updated"
				? `${APP_NAME} was updated to ${change.version} while this process was running; restart it.`
				: `The ${APP_NAME} installation this process runs from was removed or replaced; restart it.`;
	const message =
		restart === undefined ? problem.message : problem.loadFailed ? `${restart}\n${problem.message}` : restart;
	throw new NativeModuleUnavailableError(message, problem.cause === undefined ? {} : { cause: problem.cause });
}
