import { execFile } from "node:child_process";
import { readdir, readlink, realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import { findHelperExecutableAsync } from "../../utils/helper-command.ts";

export async function processesWorkIn(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	let target: string;
	try {
		target = await realpath(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	const inside = (link: string) => link === target || link.startsWith(target.endsWith(sep) ? target : target + sep);
	try {
		if (platform === "linux") return await linuxProcessesWorkIn(inside);
		if (platform === "darwin") return await openFilesInside(inside);
	} catch {}
	return true;
}

async function linuxProcessesWorkIn(inside: (link: string) => boolean): Promise<boolean> {
	const uid = process.getuid?.();
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const base = `/proc/${entry}`;
		try {
			if ((await stat(base)).uid !== uid) continue;
		} catch {
			continue;
		}
		const links = [`${base}/cwd`, `${base}/root`];
		try {
			links.push(...(await readdir(`${base}/fd`)).map((fd) => `${base}/fd/${fd}`));
		} catch (error) {
			if (gone(error)) continue;
			return true;
		}
		for (const link of links) {
			try {
				if (inside(await readlink(link))) return true;
			} catch (error) {
				if (!gone(error)) return true;
			}
		}
	}
	return false;
}

function gone(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ESRCH";
}

const UNREADABLE_ENTRY = / info error|\((?:readlink|l?stat): /;

async function openFilesInside(inside: (link: string) => boolean): Promise<boolean> {
	const uid = String(process.getuid?.() ?? "");
	const lsof = await findHelperExecutableAsync("lsof");
	// Without lsof nothing tells the checkout is free, as when lsof fails.
	if (lsof === undefined) return true;
	return new Promise((resolve) => {
		execFile(
			lsof,
			["-w", "-n", "-P", "-u", uid, "-F", "n"],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 * 1024 },
			(error, stdout) => {
				if (error !== null || stdout === "") {
					resolve(true);
					return;
				}
				const names = stdout
					.split("\n")
					.filter((line) => line.startsWith("n"))
					.map((line) => line.slice(1));
				resolve(names.some((name) => UNREADABLE_ENTRY.test(name) || inside(name)));
			},
		);
	});
}
