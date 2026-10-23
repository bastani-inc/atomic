import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

export const admissionHost = hostname();

let bootIdentity: Promise<string | null> | undefined;
export function admissionBootIdentity(): Promise<string | null> {
	bootIdentity ??= (async () => {
		try {
			if (process.platform === "linux") return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
			if (process.platform === "darwin") {
				return await new Promise<string | null>((resolve) => {
					execFile("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 1000 }, (error, stdout) =>
						resolve(error ? null : stdout.trim() || null),
					);
				});
			}
		} catch {}
		return null;
	})();
	return bootIdentity;
}

export function admissionProcessStopped(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}
