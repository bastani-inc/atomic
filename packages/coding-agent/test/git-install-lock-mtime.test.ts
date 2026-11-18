import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { plainStatMtimeMs } from "../src/utils/tools-manager.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Nanosecond mtimes around half a millisecond, where float and integer rounding of a 1.8e12 ms time can disagree. */
function nearHalfMillisecond(): bigint[] {
	const values: bigint[] = [];
	for (let second = 1_794_981_234n; second < 1_794_981_238n; second++)
		for (let offset = 499_000n; offset <= 501_000n; offset += 37n)
			values.push(second * 1_000_000_000n + 392_000_000n + offset);
	return values;
}

it.skipIf(process.platform === "win32")(
	"a lock put back carries the mtime a plain stat reports, also near half a millisecond (#4322)",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-lock-mtime-"));
		directories.push(directory);
		const file = join(directory, "stamp");
		writeFileSync(file, "");
		for (const mtimeNs of nearHalfMillisecond()) {
			const seconds = mtimeNs / 1_000_000_000n;
			const nanoseconds = (mtimeNs % 1_000_000_000n).toString().padStart(9, "0");
			const touched = spawnSync("touch", ["-m", "-d", `@${seconds}.${nanoseconds}`, file]);
			assert.equal(touched.status, 0, String(touched.stderr));
			const stored = statSync(file, { bigint: true }).mtimeNs;
			assert.equal(plainStatMtimeMs(stored), statSync(file).mtime.getTime(), `mtimeNs ${stored}`);
		}
	},
);
