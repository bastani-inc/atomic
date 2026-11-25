import * as fs from "node:fs";
import * as os from "node:os";
import { join, relative, resolve } from "node:path";
import { moduleDir } from "../helpers/runtime.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

export const repoRoot = resolve(moduleDir(import.meta.url), "../..");
export const packageDir = join(repoRoot, "packages", "coding-agent");
export const dist = join(packageDir, "dist");

// Copying the package and starting it in a terminal is structural work.
export const LAYOUT_TIMEOUT_MS = 120_000;
export const SESSION_TIMEOUT_MS = 120_000;

export interface InstalledLayout {
	readonly nodeModules: string;
	readonly atomic: string;
}

export interface InstalledLayoutScope {
	readonly installedLayout: (name?: string) => InstalledLayout;
	readonly layoutRoot: () => string | undefined;
	readonly cleanup: () => void;
}

/**
 * Copies a directory tree file by file, following links. Not `fs.cpSync`: on Windows Node 22 it aborts the process for
 * a destination below a path with a non-ASCII letter, which this test's install path has on purpose.
 */
export function copyTree(source: string, target: string, keep: (path: string) => boolean = () => true): void {
	fs.mkdirSync(target, { recursive: true });
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		if (!keep(from)) continue;
		if (fs.statSync(from).isDirectory()) copyTree(from, join(target, entry.name), keep);
		else fs.copyFileSync(from, join(target, entry.name));
	}
}

/**
 * Creates an isolated temporary install workspace per test file so split files do not share cleanup state.
 */
export function createInstalledLayoutScope(): InstalledLayoutScope {
	let root: string | undefined;

	const installedLayout = (name = "install"): InstalledLayout => {
		root ??= fs.mkdtempSync(join(os.tmpdir(), "atomic split café #% "));
		const nodeModules = join(root, name, "node_modules");
		const atomic = join(nodeModules, "@bastani", "atomic");
		if (fs.existsSync(atomic)) return { nodeModules, atomic };
		const linkType = process.platform === "win32" ? "junction" : "dir";
		const repoNodeModules = join(repoRoot, "node_modules");
		fs.mkdirSync(nodeModules, { recursive: true });
		for (const entry of fs.readdirSync(repoNodeModules)) {
			if (entry === ".bin" || entry === ".cache") continue;
			const source = join(repoNodeModules, entry);
			if (!fs.statSync(source).isDirectory()) continue;
			if (entry.startsWith("@")) {
				fs.mkdirSync(join(nodeModules, entry), { recursive: true });
				for (const scoped of fs.readdirSync(source)) {
					if (entry === "@bastani" && scoped === "atomic") continue;
					fs.symlinkSync(fs.realpathSync(join(source, scoped)), join(nodeModules, entry, scoped), linkType);
				}
				continue;
			}
			fs.symlinkSync(fs.realpathSync(source), join(nodeModules, entry), linkType);
		}
		fs.mkdirSync(atomic, { recursive: true });
		fs.copyFileSync(join(packageDir, "package.json"), join(atomic, "package.json"));
		copyTree(dist, join(atomic, "dist"));
		return { nodeModules, atomic };
	};

	const cleanup = (): void => {
		if (root) {
			removeTestDirectory(root, { retries: 20, retryDelayMs: 50 });
			root = undefined;
		}
	};

	return {
		installedLayout,
		layoutRoot: () => root,
		cleanup,
	};
}

/**
 * The package as `tsc` compiled it, before the split: the entries as compiled and the bundled modules' compiled files,
 * which the split saves in the package's build cache before overwriting or removing them, and every other compiled
 * file, which stays in `dist`.
 */
export function compiledPackage(target: string): void {
	fs.mkdirSync(target, { recursive: true });
	fs.copyFileSync(join(packageDir, "package.json"), join(target, "package.json"));
	fs.mkdirSync(join(target, "scripts"), { recursive: true });
	for (const script of [
		"split-dist.mjs",
		"split-dist-names.mjs",
		"in-place-update-gate.mjs",
		"code-string-literal.mjs",
	])
		fs.copyFileSync(join(packageDir, "scripts", script), join(target, "scripts", script));
	copyTree(join(packageDir, "in-place-update"), join(target, "in-place-update"));
	// The sources say which compiled files are this build's (`split-dist.mjs` keeps no file an earlier build left).
	fs.symlinkSync(join(packageDir, "src"), join(target, "src"), process.platform === "win32" ? "junction" : "dir");
	const state = join(packageDir, "node_modules", ".cache", "atomic-split-dist");
	const { entries, gateFiles, gatedImporters } = JSON.parse(fs.readFileSync(join(state, "state.json"), "utf8")) as {
		entries: Record<string, string>;
		gateFiles: Record<string, string>;
		gatedImporters: Record<string, string>;
	};
	// The split's own files go: its shared files and the files beside its gates (the gates are entries, below).
	const written = new Set(Object.keys(gateFiles).map((path) => join(dist, path)));
	copyTree(dist, join(target, "dist"), (source) => !source.includes(join("dist", "_shared")) && !written.has(source));
	// The compiled files whose imports the split pointed at gated modules' code, as compiled.
	for (const path of Object.keys(gatedImporters))
		fs.copyFileSync(join(state, "gated-importers", path), join(target, "dist", path));
	const bundled = Object.keys(entries);
	for (const entry of bundled)
		for (const suffix of [".js", ".js.map"])
			fs.copyFileSync(join(state, "compiled", `${entry}${suffix}`), join(target, "dist", `${entry}${suffix}`));
	const saved = join(state, "compiled");
	copyTree(saved, join(target, "dist"), (source) => {
		const path = join(target, "dist", relative(saved, source));
		return fs.statSync(source).isDirectory() || !fs.existsSync(path);
	});
}
