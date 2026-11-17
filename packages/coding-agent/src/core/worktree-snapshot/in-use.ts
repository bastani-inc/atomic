import { execFile } from "node:child_process";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Whether a process of this user may still work in the directory at `path` (#5379): one has its working directory, its
 * root, or an open file inside it. On Linux each process is read from `/proc`; on macOS the user's open files are
 * listed with `lsof`. Where that cannot be told, as on other systems or when listing fails, it counts as in use, so
 * nothing that may be in use is removed. A Linux process of this user whose entries cannot be read, as one that is not
 * dumpable, counts as in use when it started at or after `since` (milliseconds since the epoch), or when `since` is
 * undefined: one that started before cannot be a step of a build that started then. Never throws.
 */
export async function processesWorkIn(path: string, since?: number): Promise<boolean> {
	let target: string;
	try {
		target = await realpath(path);
	} catch (error) {
		// A directory that is gone holds nothing anyone works in.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	const inside = (link: string) => link === target || link.startsWith(target.endsWith(sep) ? target : target + sep);
	try {
		if (process.platform === "linux") return await linuxProcessesWorkIn(inside, since);
		if (process.platform === "darwin") return await openFilesInside(inside);
	} catch {}
	return true;
}

/** Linux reports process start times in clock ticks of 1/100 s since boot on every architecture it runs Atomic on. */
const CLOCK_TICKS_PER_SECOND = 100;

/** When process `pid` started, in milliseconds since the epoch; undefined when that cannot be read. */
async function startedAt(pid: string): Promise<number | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
		const boot = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1];
		if (!Number.isFinite(ticks) || boot === undefined) return undefined;
		return Number(boot) * 1000 + (ticks * 1000) / CLOCK_TICKS_PER_SECOND;
	} catch {
		return undefined;
	}
}

async function linuxProcessesWorkIn(inside: (link: string) => boolean, since: number | undefined): Promise<boolean> {
	const uid = process.getuid?.();
	// A process that cannot be read may work anywhere, unless it started before the build whose steps are looked for.
	const unreadable = async (pid: string) => {
		if (since === undefined) return true;
		const started = await startedAt(pid);
		return started === undefined || started >= since - 1_000;
	};
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
			if (await unreadable(entry)) return true;
			continue;
		}
		for (const link of links) {
			try {
				if (inside(await readlink(link))) return true;
			} catch (error) {
				if (!gone(error) && (await unreadable(entry))) return true;
			}
		}
	}
	return false;
}

/** The process, or one of its open files, ended while it was read. */
function gone(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ESRCH";
}

function openFilesInside(inside: (link: string) => boolean): Promise<boolean> {
	const uid = String(process.getuid?.() ?? "");
	return new Promise((resolve) => {
		execFile(
			"lsof",
			["-w", "-n", "-P", "-u", uid, "-F", "n"],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 * 1024 },
			(error, stdout) => {
				if (error !== null && stdout === "") {
					resolve(true);
					return;
				}
				resolve(stdout.split("\n").some((line) => line.startsWith("n") && inside(line.slice(1))));
			},
		);
	});
}
