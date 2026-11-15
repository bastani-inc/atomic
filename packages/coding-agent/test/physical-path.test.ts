import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { resolvePhysicalPath } from "../src/utils/physical-path.js";

let root: string;
beforeEach(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-physical-path-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")(
	"resolvePhysicalPath (symbolic links need a privilege on Windows)",
	() => {
		it("follows a chain of dangling links to the missing path a write would create (#5045)", () => {
			mkdirSync(join(root, "ws"));
			mkdirSync(join(root, "elsewhere"));
			symlinkSync("second", join(root, "ws", "first"));
			symlinkSync(join("..", "elsewhere", "new"), join(root, "ws", "second"));
			assert.equal(resolvePhysicalPath(join(root, "ws", "first", "below")), join(root, "elsewhere", "new", "below"));
		});

		it("resolves a dangling link relative to the real directory that holds it (#5045)", () => {
			mkdirSync(join(root, "real", "dir"), { recursive: true });
			symlinkSync(join(root, "real", "dir"), join(root, "alias"));
			symlinkSync(join("..", "target"), join(root, "real", "dir", "dangling"));
			assert.equal(resolvePhysicalPath(join(root, "alias", "dangling")), join(root, "real", "target"));
		});

		it("applies .. in a link target after resolving the directory link before it (#5045)", () => {
			mkdirSync(join(root, "ws"));
			mkdirSync(join(root, "outside", "a", "b"), { recursive: true });
			symlinkSync(join(root, "outside", "a", "b"), join(root, "ws", "d"));
			symlinkSync("d/../pwned.txt", join(root, "ws", "L"));
			assert.equal(resolvePhysicalPath(join(root, "ws", "L")), join(root, "outside", "a", "pwned.txt"));
		});

		it("keeps missing components below a regular file and a missing path as spelled (#5045)", () => {
			writeFileSync(join(root, "file"), "");
			assert.equal(resolvePhysicalPath(join(root, "file", "below")), join(root, "file", "below"));
			assert.equal(resolvePhysicalPath(join(root, "missing", "deeper")), join(root, "missing", "deeper"));
		});

		it("rethrows an lstat failure other than a missing component (#5045)", () => {
			assert.throws(() => resolvePhysicalPath(join(root, "x".repeat(300), "below")), { code: "ENAMETOOLONG" });
		});

		it("fails on a link cycle instead of guessing (#5045)", () => {
			symlinkSync(join(root, "loop"), join(root, "loop"));
			const absolute = join(root, "loop", "x");
			assert.throws(() => resolvePhysicalPath(absolute), {
				code: "ELOOP",
				errno: -constants.errno.ELOOP,
				syscall: "lstat",
				path: absolute,
				message: `ELOOP: too many symbolic links encountered, lstat '${absolute}'`,
			});
		});

		it("follows forty links in a row and refuses the forty-first (#5045)", () => {
			for (let link = 1; link <= 41; link++) symlinkSync(`l${link - 1}`, join(root, `l${link}`));
			assert.equal(resolvePhysicalPath(join(root, "l40")), join(root, "l0"));
			assert.throws(() => resolvePhysicalPath(join(root, "l41")), { code: "ELOOP" });
		});
	},
);
