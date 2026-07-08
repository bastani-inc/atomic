import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, PACKAGE_NAME } from "@bastani/atomic";

export const CODING_AGENT_PACKAGE = PACKAGE_NAME;
export const PI_CODING_AGENT_PACKAGE = CODING_AGENT_PACKAGE;

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
			if (pkg.name === CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(CODING_AGENT_PACKAGE)));
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	piPackageRoot?: string;
	statSync?: (filePath: string) => fs.Stats;
}

export type PiSpawnCwdValidationResult = { ok: true } | { ok: false; error: string };

export function validatePiSpawnCwd(cwd: string, deps: PiSpawnDeps = {}): PiSpawnCwdValidationResult {
	const statSync = deps.statSync ?? fs.statSync;
	try {
		const cwdStats = statSync(cwd);
		if (!cwdStats.isDirectory()) return { ok: false, error: `cwd is not a directory: ${cwd}` };
		return { ok: true };
	} catch (error) {
		const fsError = error as NodeJS.ErrnoException;
		if (fsError.code === "ENOENT") return { ok: false, error: `cwd does not exist: ${cwd}` };
		if (fsError.code === "ENOTDIR") return { ok: false, error: `cwd path contains a non-directory component: ${cwd}` };
		const details = fsError.message ? ` (${fsError.message})` : "";
		return { ok: false, error: `cwd is not accessible: ${cwd}${details}` };
	}
}

export function formatPiSpawnError(error: Error, spawnSpec: PiSpawnCommand, cwd: string): string {
	const spawnError = error as NodeJS.ErrnoException;
	const message = error.message || String(error);
	if (spawnError.code === "ENOENT") {
		return `failed to spawn subagent runtime '${spawnSpec.command}' from cwd '${cwd}': runtime executable was not found or could not be launched (${message})`;
	}
	return `failed to spawn subagent runtime '${spawnSpec.command}' from cwd '${cwd}': ${message}`;
}

export interface PiSpawnCommand {
	command: string;
	args: string[];
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argv1 = deps.argv1 ?? process.argv[1];

	if (argv1) {
		const argvPath = normalizePath(argv1);
		if (isRunnableNodeScript(argvPath, existsSync)) {
			return argvPath;
		}
	}

	try {
		const resolvePackageJson = deps.resolvePackageJson ?? (() => {
			const root = deps.piPackageRoot ?? resolvePiPackageRoot();
			if (root) return path.join(root, "package.json");
			const packageRoot = deps.resolvePackageEntry
				? findPiPackageRootFromEntry(deps.resolvePackageEntry())
				: resolveInstalledPiPackageRoot();
			if (!packageRoot) throw new Error(`Could not resolve ${CODING_AGENT_PACKAGE} package root`);
			return path.join(packageRoot, "package.json");
		});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath = typeof binField === "string"
			? binField
			: binField?.[APP_NAME] ?? binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath) return undefined;
		const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
		if (isRunnableNodeScript(candidate, existsSync)) {
			return candidate;
		}
	} catch {
		// Windows CLI resolution is optional; falling back to the app command lets PATH handle execution.
		return undefined;
	}

	return undefined;
}

export function resolveWindowsPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	return resolvePiCliScript(deps);
}

export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
	const cliPath = resolvePiCliScript(deps);
	if (cliPath) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [cliPath, ...args],
		};
	}

	return { command: APP_NAME, args };
}
