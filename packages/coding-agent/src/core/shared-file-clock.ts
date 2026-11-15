import { randomBytes } from "node:crypto";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The time now by the clock that stamps files written in `directory`, as the modification time of a file written there
 * now (#5058). Files a directory shares between hosts are stamped by one clock, the file server's or each writer's,
 * and a file's age is judged on that clock rather than on this host's, which may be minutes off. Where no file can be
 * written, this host's clock.
 */
export function sharedFilesystemNow(directory: string): number {
	const probe = join(directory, `.clock-${process.pid}-${randomBytes(6).toString("hex")}`);
	try {
		writeFileSync(probe, "");
		return statSync(probe).mtimeMs;
	} catch {
		return Date.now();
	} finally {
		try {
			rmSync(probe, { force: true });
		} catch {
			// A probe that cannot be removed is left behind; it is not a marker.
		}
	}
}
