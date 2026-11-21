/**
 * What a compile-cache helper watches so that it stands down when its installation starts to change: an install, an
 * upgrade or an uninstall of the package it loads modules from. It then stops reading the installation's files at once
 * and leaves no marker, so the installer is not kept waiting on files the helper or the system's scanner has open.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The parts of an installation that every installer changes before or while it replaces it. */
export interface InstallationSnapshot {
	/** The package directory's file id and creation time; undefined when it is gone. */
	readonly directory: string | undefined;
	/** `package.json`'s size and modification time; undefined when it is gone. */
	readonly manifest: string | undefined;
	/** Whether the CLI entry file is still there. */
	readonly entry: boolean;
	/** Hidden entries next to the package directory, where npm moves a package it replaces or removes. */
	readonly beside: readonly string[];
}

/** A hidden entry beside the package younger than this is an installer at work, not one an earlier install left. */
export const INSTALLER_AT_WORK_MS = 10 * 60 * 1000;

/** Whether an installer is at work on the installation now: a hidden entry beside it was made or changed lately. */
export function installerAtWork(packageDir: string, now: number = Date.now()): boolean {
	try {
		const scope = dirname(packageDir);
		const own = basename(packageDir);
		return readdirSync(scope).some((name) => {
			if (!name.startsWith(".") || name === own) return false;
			try {
				return now - statSync(join(scope, name)).mtimeMs < INSTALLER_AT_WORK_MS;
			} catch {
				// Gone again: an installer that just finished with it.
				return true;
			}
		});
	} catch {
		return true;
	}
}

/** Whether the installation is no longer the one the helper started from. */
export function installationChanged(start: InstallationSnapshot, now: InstallationSnapshot): boolean {
	if (now.directory === undefined || now.directory !== start.directory) return true;
	if (now.manifest === undefined || now.manifest !== start.manifest) return true;
	if (!now.entry) return true;
	return now.beside.some((name) => !start.beside.includes(name));
}

function identity(path: string, withSize: boolean): string | undefined {
	try {
		const stat = statSync(path, { bigint: true });
		return withSize ? `${stat.size}:${stat.mtimeNs}` : `${stat.ino}:${stat.birthtimeNs}`;
	} catch {
		return undefined;
	}
}

/** Read the snapshot of the installation at `packageDir`; nothing it reads stays open. */
export function readInstallationSnapshot(packageDir: string): InstallationSnapshot {
	let beside: string[] = [];
	try {
		const own = basename(packageDir);
		beside = readdirSync(dirname(packageDir)).filter((name) => name.startsWith(".") && name !== own);
	} catch {
		// The directory around it is gone too: the package directory check below says so.
	}
	return {
		directory: identity(packageDir, false),
		manifest: identity(join(packageDir, "package.json"), true),
		entry: identity(join(packageDir, "dist", "cli.js"), true) !== undefined,
		beside,
	};
}
