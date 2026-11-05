import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { renameReplacing, writeSettingsFile } from "../../packages/coding-agent/src/core/settings-storage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

let root: string;

beforeEach(() => {
	root = makeTempDirectory("settings-atomic-");
});

afterEach(() => {
	removeTempDirectory(root);
});

const posix = process.platform !== "win32";

test("a settings file is replaced whole, keeps its mode, and leaves no temporary file (#4320)", () => {
	const path = join(root, "settings.json");
	writeSettingsFile(path, '{"a":1}');
	assert.equal(readFileSync(path, "utf8"), '{"a":1}');
	if (posix) chmodSync(path, 0o600);
	writeSettingsFile(path, '{"a":2}');
	assert.equal(readFileSync(path, "utf8"), '{"a":2}');
	if (posix) assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(root), ["settings.json"]);
});

test.skipIf(!posix)("a mode any common umask would strip is kept (#4320)", () => {
	const path = join(root, "settings.json");
	writeFileSync(path, "{}");
	chmodSync(path, 0o646);
	writeSettingsFile(path, '{"shared":true}');
	assert.equal(statSync(path).mode & 0o777, 0o646);
});

test.skipIf(!posix)("a symbolic link stays a link and its target is replaced (#4320)", () => {
	const dotfiles = join(root, "dotfiles");
	mkdirSync(dotfiles);
	const target = join(dotfiles, "settings.json");
	writeFileSync(target, "{}");
	chmodSync(target, 0o640);
	const link = join(root, "settings.json");
	symlinkSync(target, link);
	writeSettingsFile(link, '{"theme":"dark"}');
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(readFileSync(target, "utf8"), '{"theme":"dark"}');
	assert.equal(statSync(target).mode & 0o777, 0o640);
	assert.deepEqual(readdirSync(dotfiles), ["settings.json"]);
});

test.skipIf(!posix)(
	"a link whose target does not exist yet stays a link, and the write creates the end of its chain (#4320)",
	() => {
		const dotfiles = join(root, "dotfiles");
		mkdirSync(dotfiles);
		const target = join(dotfiles, "settings.json");
		symlinkSync("dotfiles/next.json", join(root, "settings.json"));
		symlinkSync("settings.json", join(dotfiles, "next.json"));

		writeSettingsFile(join(root, "settings.json"), '{"theme":"dark"}');

		assert.equal(lstatSync(join(root, "settings.json")).isSymbolicLink(), true);
		assert.equal(lstatSync(join(dotfiles, "next.json")).isSymbolicLink(), true);
		assert.equal(readFileSync(target, "utf8"), '{"theme":"dark"}');
		assert.deepEqual(readdirSync(dotfiles).sort(), ["next.json", "settings.json"]);
	},
);

test.skipIf(!posix)(
	"a link to a missing directory keeps the link and fails as writing through it would (#4320)",
	() => {
		const link = join(root, "settings.json");
		symlinkSync(join(root, "missing", "settings.json"), link);

		assert.throws(() => writeSettingsFile(link, "{}"), { code: "ENOENT" });

		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.deepEqual(readdirSync(root), ["settings.json"]);
	},
);

test.skipIf(!posix)("a link cycle fails without replacing the link (#4320)", () => {
	const link = join(root, "settings.json");
	symlinkSync("other.json", link);
	symlinkSync("settings.json", join(root, "other.json"));

	assert.throws(() => writeSettingsFile(link, "{}"), {
		code: "ELOOP",
		message: `ELOOP: too many symbolic links encountered, write '${link}'`,
	});

	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(root).sort(), ["other.json", "settings.json"]);
});

test.skipIf(!posix)(
	"a chain of as many links as the system follows is written through, and one more fails (#4320)",
	() => {
		const chain = (name: string, links: number): string => {
			const directory = join(root, name);
			mkdirSync(directory);
			for (let index = 0; index < links; index += 1) symlinkSync(`l${index + 1}`, join(directory, `l${index}`));
			return directory;
		};
		const longest = chain("forty", 40);
		writeSettingsFile(join(longest, "l0"), '{"deep":true}');
		assert.equal(readFileSync(join(longest, "l40"), "utf8"), '{"deep":true}');

		const tooLong = chain("forty-one", 41);
		assert.throws(() => writeSettingsFile(join(tooLong, "l0"), "{}"), { code: "ELOOP" });
		assert.equal(readdirSync(tooLong).length, 41);
	},
);

test.skipIf(!posix)("an absolute link to a missing file creates that file and stays a link (#4320)", () => {
	const dotfiles = join(root, "dotfiles");
	mkdirSync(dotfiles);
	const link = join(root, "settings.json");
	symlinkSync(join(dotfiles, "settings.json"), link);

	writeSettingsFile(link, '{"a":1}');

	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(readFileSync(join(dotfiles, "settings.json"), "utf8"), '{"a":1}');
});

test.skipIf(!posix)(
	"a link that goes up from a linked directory creates the file where the system resolves it (#4320)",
	() => {
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		symlinkSync(nested, join(root, "linked"));
		const link = join(root, "settings.json");
		symlinkSync("linked/../created.json", link);

		writeSettingsFile(link, '{"up":true}');

		assert.equal(readFileSync(join(root, "a", "created.json"), "utf8"), '{"up":true}');
		assert.deepEqual(readdirSync(root).sort(), ["a", "linked", "settings.json"]);
		assert.equal(lstatSync(link).isSymbolicLink(), true);
	},
);

test("a write that cannot finish leaves what was there and no temporary file (#4320)", () => {
	const path = join(root, "settings.json");
	mkdirSync(path);
	writeFileSync(join(path, "inside"), "kept");
	assert.throws(() => writeSettingsFile(path, '{"keep":false}'));
	assert.equal(readFileSync(join(path, "inside"), "utf8"), "kept");
	assert.deepEqual(readdirSync(root), ["settings.json"]);
	assert.throws(() => writeSettingsFile(join(root, "missing", "settings.json"), "{}"), { code: "ENOENT" });
	assert.deepEqual(readdirSync(root), ["settings.json"]);
});

test("on Windows a rename blocked by another handle is retried, and anything else throws at once (#4320)", () => {
	const failing = (codes: (string | undefined)[]) => {
		const calls: string[] = [];
		return {
			calls,
			rename: (from: string, to: string) => {
				calls.push(`${from}->${to}`);
				const code = codes.shift();
				if (code !== undefined) throw Object.assign(new Error(code), { code });
			},
		};
	};
	const transient = failing(["EPERM", "EBUSY", "EACCES"]);
	const times: number[] = [];
	renameReplacing("a", "b", "win32", (from, to) => {
		times.push(Date.now());
		transient.rename(from, to);
	});
	assert.equal(transient.calls.length, 4);
	for (let index = 1; index < times.length; index++) {
		assert.ok(
			times[index]! - times[index - 1]! >= 19,
			`retry ${index} waited ${times[index]! - times[index - 1]!} ms`,
		);
	}

	const permanent = failing(Array.from({ length: 12 }, () => "EPERM"));
	assert.throws(() => renameReplacing("a", "b", "win32", permanent.rename), { code: "EPERM" });
	assert.equal(permanent.calls.length, 10);

	const other = failing(["ENOSPC"]);
	assert.throws(() => renameReplacing("a", "b", "win32", other.rename), { code: "ENOSPC" });
	assert.equal(other.calls.length, 1);

	const uncoded = failing([]);
	const throwing = (from: string, to: string) => {
		uncoded.calls.push(`${from}->${to}`);
		throw new Error("no code");
	};
	assert.throws(() => renameReplacing("a", "b", "win32", throwing), /no code/);
	assert.equal(uncoded.calls.length, 1);

	const elsewhere = failing(["EPERM"]);
	assert.throws(() => renameReplacing("a", "b", "linux", elsewhere.rename), { code: "EPERM" });
	assert.equal(elsewhere.calls.length, 1);
});
