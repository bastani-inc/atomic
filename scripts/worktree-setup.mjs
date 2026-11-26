// Prepares a linked Git worktree of this repository for builds and tests.
//
// Usage, from inside the worktree: `node scripts/worktree-setup.mjs [--source <checkout>] [--no-build]`
//
// When the worktree's package-lock.json matches the source checkout's (the main worktree by default), the
// worktree reuses the source's installed packages through links instead of a second 500 MB install:
//
// - `node_modules` is a real directory. Each installed package is an absolute link to the source's copy, so
//   the links work at any depth.
// - Workspace links (`@bastani/*`) and `.bin` entries are recreated with their relative targets, so they lead
//   to this worktree's packages and builds. Linking the whole `node_modules` directory would send them to the
//   source checkout's packages instead: child-process tests would then load the source checkout's build.
// - Vitest is copied, not linked. Vitest 4 assumes its own files sit under the project root: with Vitest's real
//   path in another checkout, it treats bare imports that start with a leftover piece of its own path (such as
//   `string_decoder` or `stream`, depending on the length of the worktree path) as its own files, and the test
//   fails with "Cannot find module '<worktree>/string_decoder'".
// - Caches (`.cache`, `.vite`, `.vite-temp`) stay per worktree, so build stamps and transpile caches of
//   different branches never mix.
// - `packages/*/node_modules` follow the same rules.
//
// When the lockfiles differ, the worktree gets its own `npm ci --ignore-scripts` instead. Either way the
// script finishes with `npm run build` unless `--no-build` is given.
import { spawnSync } from "node:child_process";
import {
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory entries that stay private to each checkout. */
const PER_CHECKOUT_ENTRIES = new Set([".cache", ".vite", ".vite-temp"]);

/** Packages copied instead of linked, because they misbehave when their real path is outside the project root. */
const COPIED_PACKAGES = new Set(["vitest"]);

/** Marks a node_modules directory this script built, so a rerun may replace its links. */
export const MARKER = ".atomic-worktree-source";

/** Whether `path` is a symbolic link, without following it. */
function isLink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Whether `directory` holds a symbolic link as a direct entry. */
function holdsLinks(directory) {
	return readdirSync(directory).some((entry) => isLink(join(directory, entry)));
}

/**
 * Mirrors one installed `node_modules` directory into `target`.
 *
 * Symbolic links are recreated with their original targets, `.bin` and scope directories that hold links are
 * mirrored entry by entry, copied packages are cloned, per-checkout caches are left out, and everything else
 * becomes an absolute link to the source's entry.
 */
function mirror(source, target, topLevel) {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source)) {
		if (PER_CHECKOUT_ENTRIES.has(entry) || entry === MARKER) continue;
		const from = join(source, entry);
		const to = join(target, entry);
		if (isLink(from)) {
			symlinkSync(readlinkSync(from), to);
		} else if ((entry === ".bin" || entry.startsWith("@")) && holdsLinks(from)) {
			mirror(from, to, false);
		} else if (topLevel && COPIED_PACKAGES.has(entry)) {
			cpSync(from, to, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
		} else {
			symlinkSync(from, to);
		}
	}
}

/**
 * Empties a `node_modules` directory this script built earlier, keeping its per-checkout caches.
 * A link to a whole directory is removed; a directory installed some other way is left alone.
 *
 * @returns {boolean} whether `directory` may now be mirrored into
 */
function clear(directory) {
	if (isLink(directory)) {
		rmSync(directory);
		return true;
	}
	if (!existsSync(directory)) return true;
	if (!existsSync(join(directory, MARKER))) return false;
	for (const entry of readdirSync(directory)) {
		if (!PER_CHECKOUT_ENTRIES.has(entry)) rmSync(join(directory, entry), { recursive: true, force: true });
	}
	return true;
}

/**
 * Links the installed packages of the checkout at `source` into the worktree at `target`: the root
 * `node_modules` and every `packages/<name>/node_modules`.
 *
 * @param {{ source: string, target: string }} roots
 * @returns {string[]} the `node_modules` directories that were left alone because they hold a real install
 */
export function linkInstalledPackages({ source, target }) {
	const skipped = [];
	const directories = ["node_modules"];
	const packagesDir = join(target, "packages");
	if (existsSync(packagesDir)) {
		for (const name of readdirSync(packagesDir)) directories.push(join("packages", name, "node_modules"));
	}
	for (const relative of directories) {
		const from = join(source, relative);
		const to = join(target, relative);
		if (!clear(to)) {
			skipped.push(to);
			continue;
		}
		if (!existsSync(from)) continue;
		mirror(from, to, relative === "node_modules");
		writeFileSync(join(to, MARKER), `${source}\n`);
	}
	return skipped;
}

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/** The main worktree of the repository that holds `cwd`. */
function mainWorktree(cwd) {
	const first = git(cwd, "worktree", "list", "--porcelain")
		.split("\n")
		.find((line) => line.startsWith("worktree "));
	if (!first) throw new Error("git worktree list printed no worktree");
	return first.slice("worktree ".length);
}

function run(cwd, command, args) {
	console.log(`[worktree-setup] ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function main(argv) {
	const sourceIndex = argv.indexOf("--source");
	const target = git(process.cwd(), "rev-parse", "--show-toplevel");
	const source = resolve(sourceIndex === -1 ? mainWorktree(target) : argv[sourceIndex + 1]);
	if (resolve(source) === resolve(target)) {
		console.error("[worktree-setup] This is the source checkout itself; run `npm ci --ignore-scripts` here instead.");
		process.exit(1);
	}
	const lockfile = (root) => {
		const path = join(root, "package-lock.json");
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	};
	const shareable =
		process.platform !== "win32" &&
		existsSync(join(source, "node_modules")) &&
		lockfile(source) !== undefined &&
		lockfile(source) === lockfile(target);
	if (shareable) {
		console.log(`[worktree-setup] Linking the installed packages of ${source}`);
		for (const skipped of linkInstalledPackages({ source, target })) {
			console.log(`[worktree-setup] Left ${skipped} alone: it holds its own install.`);
		}
	} else {
		console.log(
			"[worktree-setup] The lockfile differs from the source checkout's (or links are unavailable), so this worktree gets its own install.",
		);
		for (const relative of [
			"node_modules",
			...readdirSync(join(target, "packages")).map((name) => join("packages", name, "node_modules")),
		]) {
			if (isLink(join(target, relative)) || existsSync(join(target, relative, MARKER))) {
				rmSync(join(target, relative), { recursive: true, force: true });
			}
		}
		run(target, "npm", ["ci", "--ignore-scripts"]);
	}
	if (!argv.includes("--no-build")) run(target, "npm", ["run", "build"]);
}

if (isAbsolute(process.argv[1] ?? "") && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
