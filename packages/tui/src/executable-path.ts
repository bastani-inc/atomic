/**
 * Where a helper program Atomic starts by name lives: the first match in the absolute directories of PATH, never in the
 * working directory.
 *
 * Starting a program by its bare name searches more than PATH. On Windows the search looks in the working directory
 * first, and on every platform an empty or relative PATH entry names the working directory, which may be a project
 * nobody has trusted yet. Atomic therefore resolves the programs it starts for its own work to an absolute path first,
 * and starts that path. A program found only where these searches differ is not found.
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, sep, win32 } from "node:path";

export interface HelperExecutableOptions {
	/** The environment of the process that starts the helper: its PATH, and PATHEXT on Windows. Default `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * The working directory the helper starts in, when it is not this process's: never searched, as this process's own
	 * working directory never is.
	 */
	readonly cwd?: string;
	/**
	 * Windows: also files run through a shell, such as `.cmd` and `.bat`, in PATHEXT's order. Without it only the files
	 * Windows starts directly, `.com` and `.exe`, as starting a program without a shell does.
	 */
	readonly shellScripts?: boolean;
	/** Whose rules to search by; by default this operating system's. */
	readonly platform?: NodeJS.Platform;
}

/** Windows' default PATHEXT, used when the environment has none. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** What Windows starts without a shell. */
const DIRECT_EXTENSIONS = new Set([".com", ".exe"]);

function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
	if (!windows) return env[name];
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key === undefined ? undefined : env[key];
}

interface Search {
	readonly directories: readonly string[];
	readonly names: readonly string[];
	readonly windows: boolean;
}

/** The directories to search, in order, and the file names to try in each; undefined for a name that is a path. */
function searchFor(name: string, options: HelperExecutableOptions): Search | undefined {
	// How this operating system starts programs, which is what the search must match: `sep` is set when Node starts.
	const windows = options.platform === undefined ? sep === "\\" : options.platform === "win32";
	const path = windows ? win32 : posix;
	// A name with a separator in either style is a path its caller chose, whichever platform reads it.
	if (name === "" || /[\\/]/.test(name) || (windows && name.includes(":"))) return undefined;
	const env = options.env ?? process.env;
	const workingDirectories = [process.cwd(), ...(options.cwd === undefined ? [] : [options.cwd])].map((directory) =>
		path.resolve(directory),
	);
	const sameDirectory = (directory: string) =>
		workingDirectories.some((cwd) => (windows ? directory.toLowerCase() === cwd.toLowerCase() : directory === cwd));
	const directories: string[] = [];
	for (const raw of (envValue(env, "PATH", windows) ?? "").split(path.delimiter)) {
		const entry = windows ? raw.replace(/^"(.*)"$/, "$1") : raw;
		// Empty and relative entries name the working directory, or a directory under it.
		if (entry === "" || !path.isAbsolute(entry)) continue;
		const directory = path.resolve(entry);
		if (sameDirectory(directory) || directories.includes(directory)) continue;
		directories.push(directory);
	}
	if (!windows) return { directories, names: [name], windows };
	const extensions = (envValue(env, "PATHEXT", true) || DEFAULT_PATHEXT)
		.split(";")
		.map((extension) => extension.trim().toLowerCase())
		.filter((extension) => extension.startsWith(".") && (options.shellScripts || DIRECT_EXTENSIONS.has(extension)));
	const names = [
		...(win32.extname(name) !== "" ? [name] : []),
		...extensions.map((extension) => `${name}${extension}`),
	];
	return { directories, names, windows };
}

/** Windows: a file, or an app execution alias, which only `access` sees. Elsewhere: an executable file. */
function isProgram(candidate: string, windows: boolean): boolean {
	try {
		if (windows) {
			accessSync(candidate, constants.F_OK);
			const entry = lstatSync(candidate);
			return !entry.isDirectory() && !(entry.isSymbolicLink() && statSync(candidate).isDirectory());
		}
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isProgramAsync(candidate: string, windows: boolean): Promise<boolean> {
	try {
		if (windows) {
			await access(candidate, constants.F_OK);
			const entry = await lstat(candidate);
			return !entry.isDirectory() && !(entry.isSymbolicLink() && (await stat(candidate)).isDirectory());
		}
		if (!(await stat(candidate)).isFile()) return false;
		await access(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The absolute path of helper program `name`, or undefined when no absolute PATH directory other than the working
 * directory holds it. A name that is already a path comes back as it is.
 */
export function findHelperExecutable(name: string, options: HelperExecutableOptions = {}): string | undefined {
	const search = searchFor(name, options);
	if (search === undefined) return name;
	const path = search.windows ? win32 : posix;
	for (const directory of search.directories) {
		for (const file of search.names) {
			const candidate = path.join(directory, file);
			if (isProgram(candidate, search.windows)) return candidate;
		}
	}
	return undefined;
}

/** {@link findHelperExecutable} without blocking the event loop. */
export async function findHelperExecutableAsync(
	name: string,
	options: HelperExecutableOptions = {},
): Promise<string | undefined> {
	const search = searchFor(name, options);
	if (search === undefined) return name;
	const path = search.windows ? win32 : posix;
	for (const directory of search.directories) {
		for (const file of search.names) {
			const candidate = path.join(directory, file);
			if (await isProgramAsync(candidate, search.windows)) return candidate;
		}
	}
	return undefined;
}

/** What to pass `spawn`, `execFile` and their sync forms to start a helper. */
export interface HelperLaunch {
	/** The helper's absolute path, or its name when no allowed directory holds it. */
	readonly file: string;
	/**
	 * Only for a helper that was not found: options under which starting `file` fails as starting a program that is not
	 * installed does (`ENOENT`, "spawn <name> ENOENT"), without looking in any directory.
	 */
	readonly missing?: { readonly cwd: string; readonly env: NodeJS.ProcessEnv };
}

/** A directory that does not exist, so a start from it fails before any program is looked up. */
function nowhere(): string {
	return join(tmpdir(), `atomic-helper-not-found-${randomUUID()}`);
}

function launchFor(name: string, found: string | undefined, env: NodeJS.ProcessEnv | undefined): HelperLaunch {
	if (found !== undefined) return { file: found };
	const missingEnv: NodeJS.ProcessEnv = { ...(env ?? process.env) };
	for (const key of Object.keys(missingEnv)) if (key.toUpperCase() === "PATH") delete missingEnv[key];
	missingEnv.PATH = "";
	return { file: name, missing: { cwd: nowhere(), env: missingEnv } };
}

/** How to start helper `name` (see {@link HelperLaunch}). */
export function helperLaunch(name: string, options: HelperExecutableOptions = {}): HelperLaunch {
	return launchFor(name, findHelperExecutable(name, options), options.env);
}

/** {@link helperLaunch} without blocking the event loop. */
export async function helperLaunchAsync(name: string, options: HelperExecutableOptions = {}): Promise<HelperLaunch> {
	return launchFor(name, await findHelperExecutableAsync(name, options), options.env);
}

/**
 * The options to spread last into the `spawn` or `execFile` options of `launch`: none for a helper that was found, and
 * for one that was not, the ones under which its start fails as a missing program's does.
 */
export function missingHelperOptions(launch: HelperLaunch): { cwd?: string; env?: NodeJS.ProcessEnv } {
	return launch.missing === undefined ? {} : { cwd: launch.missing.cwd, env: launch.missing.env };
}
