/** Synchronous because Node and jiti enable their caches before loading the application. */
import { accessSync, constants, lstatSync, mkdirSync, type Stats, writeFileSync } from "node:fs";
import { access, lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	evaluateWindowsDirectorySecurity,
	type WindowsDirectorySecurity,
} from "./core/tools/windows-directory-descriptor.ts";
import { createModuleRequire } from "./utils/module-require.js";

function checkMode(stat: Stats, privateBase: boolean): void {
	if (
		!stat.isDirectory() ||
		(process.platform !== "win32" &&
			(stat.uid !== process.getuid?.() || (stat.mode & (privateBase ? 0o077 : 0o022)) !== 0))
	)
		throw new Error("Untrusted cache directory");
}
function checkDirectory(dir: string, privateBase = false): void {
	checkMode(lstatSync(dir), privateBase);
	if (process.platform === "win32") {
		const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
			windowsDirectorySecurity(path: string): WindowsDirectorySecurity | null;
		};
		const acl = binding.windowsDirectorySecurity(dir);
		if (!acl || evaluateWindowsDirectorySecurity(acl) !== undefined) throw new Error("Untrusted cache directory");
	}
	accessSync(dir, constants.W_OK | constants.X_OK);
}

/** A short, per-account alternative to the configured agent directory, not the system temp directory. */
export function alternateRuntimeBase(): string | undefined {
	const base = process.platform === "win32" ? process.env.LOCALAPPDATA : process.env.XDG_RUNTIME_DIR;
	return base && isAbsolute(base) ? base : undefined;
}

export async function ensureCacheDirectoryAsync(
	base: string,
	dir: string,
	alternate: boolean,
	ignored: string,
): Promise<void> {
	const check = async (path: string, privateBase: boolean) => {
		checkMode(await lstat(path), privateBase);
		if (process.platform === "win32") {
			const { verifyWindowsDirectorySecurityAsync } = await import("./core/tools/windows-directory-security.ts");
			if ((await verifyWindowsDirectorySecurityAsync(path)) !== undefined)
				throw new Error("Untrusted cache directory");
		}
		await access(path, constants.W_OK | constants.X_OK);
	};
	if (alternate) await check(base, true);
	else await mkdir(base, { recursive: true, mode: 0o700 });
	let current = base;
	for (const part of relative(base, dir).split(sep)) {
		current = join(current, part);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await check(current, false);
	}
	try {
		await writeFile(join(ignored, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export function ensureCacheDirectory(base: string, dir: string, alternate: boolean, ignored: string): void {
	if (alternate) checkDirectory(base, true);
	else mkdirSync(base, { recursive: true, mode: 0o700 });
	let current = base;
	for (const part of relative(base, dir).split(sep)) {
		current = join(current, part);
		try {
			mkdirSync(current, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		checkDirectory(current);
	}
	try {
		writeFileSync(join(ignored, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}
