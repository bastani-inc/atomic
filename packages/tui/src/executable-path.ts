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
	/**
	 * The asynchronous search rejects with the signal's reason as soon as it aborts, whatever file access it waits for,
	 * so a caller's cancellation and deadline hold while it looks.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Windows: a directory searched before PATH, as Windows searches a program's working directory first, for a working
	 * directory the user configured. It is skipped like PATH's entries when it is a working directory above.
	 */
	readonly searchFirst?: string;
	/** Windows: a name with an extension is tried only as it is, as a shell's lookup of such a name does. */
	readonly exact?: boolean;
}

/** Windows' default PATHEXT, used when the environment has none. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** Where a start by name looks without PATH outside Windows (`_PATH_DEFPATH`). */
const DEFAULT_POSIX_PATH = "/usr/bin:/bin";
/** What Windows starts without a shell. */
const DIRECT_EXTENSIONS = new Set([".com", ".exe"]);

/**
 * The value of variable `name` a program started with `env` gets. Windows reads names in any letter case, and of several
 * spellings of one name Node passes the first in sorted order.
 */
function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
	if (!windows) return env[name];
	const key = Object.keys(env)
		.filter((candidate) => candidate.toUpperCase() === name)
		.sort()[0];
	return key === undefined ? undefined : env[key];
}

interface Search {
	readonly directories: readonly string[];
	readonly names: readonly string[];
	readonly windows: boolean;
	/** The working directories, which no directory may be, however PATH spells it. */
	readonly working: readonly string[];
}

const currentDirectory = (): string => process.cwd();

/** The directories to search, in order, and the file names to try in each; undefined for a name that is a path. */
function searchFor(name: string, options: HelperExecutableOptions): Search | undefined {
	// How this operating system starts programs, which is what the search must match: `sep` is set when Node starts.
	const windows = options.platform === undefined ? sep === "\\" : options.platform === "win32";
	const path = windows ? win32 : posix;
	// A name with a separator in either style is a path its caller chose, whichever platform reads it.
	if (name === "" || /[\\/]/.test(name) || (windows && name.includes(":"))) return undefined;
	const env = options.env ?? process.env;
	const workingDirectories: string[] = [];
	for (const directory of [currentDirectory, () => options.cwd]) {
		// A working directory that was removed cannot be read, and holds nothing to exclude.
		try {
			const named = directory();
			if (named !== undefined) workingDirectories.push(path.resolve(named));
		} catch {}
	}
	const sameDirectory = (directory: string) =>
		workingDirectories.some((cwd) => (windows ? directory.toLowerCase() === cwd.toLowerCase() : directory === cwd));
	const directories: string[] = [];
	if (windows && options.searchFirst !== undefined && path.isAbsolute(options.searchFirst)) {
		const first = path.resolve(options.searchFirst);
		if (!sameDirectory(first)) directories.push(first);
	}
	// Without PATH, a start by name searches the system's default directories, and on Windows this process's PATH,
	// which the start gives the program.
	const searched =
		envValue(env, "PATH", windows) ?? (windows ? (envValue(process.env, "PATH", true) ?? "") : DEFAULT_POSIX_PATH);
	for (const raw of searched.split(path.delimiter)) {
		const entry = windows ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
		// Empty and relative entries name the working directory, or a directory under it.
		if (entry === "" || !path.isAbsolute(entry)) continue;
		const directory = path.resolve(entry);
		if (sameDirectory(directory) || directories.includes(directory)) continue;
		directories.push(directory);
	}
	if (!windows) return { directories, names: [name], windows, working: workingDirectories };
	const extensions = (envValue(env, "PATHEXT", true) || DEFAULT_PATHEXT)
		.split(";")
		.map((extension) => extension.trim().toLowerCase())
		.filter((extension) => extension.startsWith(".") && (options.shellScripts || DIRECT_EXTENSIONS.has(extension)));
	const hasExtension = win32.extname(name) !== "";
	const names =
		hasExtension && options.exact
			? [name]
			: [...(hasExtension ? [name] : []), ...extensions.map((extension) => `${name}${extension}`)];
	return { directories, names, windows, working: workingDirectories };
}

/** A directory's identity on its file system, so another spelling of it (a link, a short name) is told apart. */
function identity(directory: string): string | undefined {
	try {
		const stats = statSync(directory, { bigint: true });
		return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : undefined;
	} catch {
		return undefined;
	}
}

async function identityAsync(directory: string): Promise<string | undefined> {
	try {
		const stats = await stat(directory, { bigint: true });
		return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * What a file is to the search. Windows: a program when it is a file, or an app execution alias, which only `access`
 * sees. Elsewhere: a program when it is an executable file; `denied` when it is a file without execute permission,
 * which execvp reports as EACCES when nothing later in PATH can run.
 */
type Candidate = "program" | "denied" | "none";

function candidateKind(candidate: string, windows: boolean): Candidate {
	try {
		if (windows) {
			accessSync(candidate, constants.F_OK);
			// An app execution alias is seen by `access` alone: what cannot be told to be a directory is a program.
			try {
				const entry = lstatSync(candidate);
				const directory = entry.isDirectory() || (entry.isSymbolicLink() && statSync(candidate).isDirectory());
				return directory ? "none" : "program";
			} catch {
				return "program";
			}
		}
		if (!statSync(candidate).isFile()) return "none";
	} catch {
		return "none";
	}
	try {
		accessSync(candidate, constants.X_OK);
		return "program";
	} catch {
		return "denied";
	}
}

async function candidateKindAsync(candidate: string, windows: boolean): Promise<Candidate> {
	try {
		if (windows) {
			await access(candidate, constants.F_OK);
			try {
				const entry = await lstat(candidate);
				const directory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(candidate)).isDirectory());
				return directory ? "none" : "program";
			} catch {
				return "program";
			}
		}
		if (!(await stat(candidate)).isFile()) return "none";
	} catch {
		return "none";
	}
	try {
		await access(candidate, constants.X_OK);
		return "program";
	} catch {
		return "denied";
	}
}

/** What the search found: the program to start, or the first file it may not run. */
interface Found {
	readonly program?: string;
	readonly denied?: string;
}

function searchSync(name: string, options: HelperExecutableOptions): Found {
	const search = searchFor(name, options);
	if (search === undefined) return { program: name };
	const path = search.windows ? win32 : posix;
	const working = new Set(search.working.map(identity).filter((id) => id !== undefined));
	let denied: string | undefined;
	for (const directory of search.directories) {
		const id = identity(directory);
		// A directory that is a working directory, however it is spelled, is never searched.
		if (id !== undefined && working.has(id)) continue;
		for (const file of search.names) {
			const candidate = path.join(directory, file);
			const kind = candidateKind(candidate, search.windows);
			if (kind === "program") return { program: candidate };
			if (kind === "denied") denied ??= candidate;
		}
	}
	return { denied };
}

async function searchAsync(name: string, options: HelperExecutableOptions, signal?: AbortSignal): Promise<Found> {
	const search = searchFor(name, options);
	if (search === undefined) return { program: name };
	const path = search.windows ? win32 : posix;
	const working = new Set((await Promise.all(search.working.map(identityAsync))).filter((id) => id !== undefined));
	let denied: string | undefined;
	for (const directory of search.directories) {
		if (signal?.aborted) return {};
		const id = await identityAsync(directory);
		if (id !== undefined && working.has(id)) continue;
		for (const file of search.names) {
			if (signal?.aborted) return {};
			const candidate = path.join(directory, file);
			const kind = await candidateKindAsync(candidate, search.windows);
			if (kind === "program") return { program: candidate };
			if (kind === "denied") denied ??= candidate;
		}
	}
	return { denied };
}

/** {@link searchAsync} that rejects with `options.signal`'s reason as soon as it aborts. */
function searchUntilAborted(name: string, options: HelperExecutableOptions): Promise<Found> {
	const { signal } = options;
	if (signal === undefined) return searchAsync(name, options);
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		searchAsync(name, options, signal).then(
			(found) => {
				signal.removeEventListener("abort", onAbort);
				resolve(found);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * The absolute path of helper program `name`, or undefined when no absolute PATH directory other than the working
 * directory holds it as a program this process may run. A name that is already a path comes back as it is.
 */
export function findHelperExecutable(name: string, options: HelperExecutableOptions = {}): string | undefined {
	return searchSync(name, options).program;
}

/** {@link findHelperExecutable} without blocking the event loop. */
export async function findHelperExecutableAsync(
	name: string,
	options: HelperExecutableOptions = {},
): Promise<string | undefined> {
	return (await searchUntilAborted(name, options)).program;
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

function launchFor(name: string, found: Found, env: NodeJS.ProcessEnv | undefined): HelperLaunch {
	// A file it may not run is started anyway, so the start fails with EACCES, as a search by name reports it.
	const file = found.program ?? found.denied;
	if (file !== undefined) return { file };
	const missingEnv: NodeJS.ProcessEnv = { ...(env ?? process.env) };
	for (const key of Object.keys(missingEnv)) if (key.toUpperCase() === "PATH") delete missingEnv[key];
	missingEnv.PATH = "";
	return { file: name, missing: { cwd: nowhere(), env: missingEnv } };
}

/** How to start helper `name` (see {@link HelperLaunch}). */
export function helperLaunch(name: string, options: HelperExecutableOptions = {}): HelperLaunch {
	return launchFor(name, searchSync(name, options), options.env);
}

/** {@link helperLaunch} without blocking the event loop. */
export async function helperLaunchAsync(name: string, options: HelperExecutableOptions = {}): Promise<HelperLaunch> {
	return launchFor(name, await searchUntilAborted(name, options), options.env);
}

/**
 * The options to spread last into the `spawn` or `execFile` options of `launch`: none for a helper that was found, and
 * for one that was not, the ones under which its start fails as a missing program's does.
 */
export function missingHelperOptions(launch: HelperLaunch): { cwd?: string; env?: NodeJS.ProcessEnv } {
	return launch.missing === undefined ? {} : { cwd: launch.missing.cwd, env: launch.missing.env };
}
