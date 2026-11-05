import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	settingsFilesWrittenInPlace,
	writeSettingsFile,
} from "../../packages/coding-agent/src/core/settings-storage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const refuse = vi.hoisted(() => ({
	temporary: false,
	created: [] as unknown[],
	rename: undefined as string | undefined,
}));
vi.mock("fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("fs")>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			if (String(args[0]).endsWith(".tmp")) refuse.created.push(args[2]);
			if (refuse.temporary && String(args[0]).endsWith(".tmp")) {
				throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
			}
			return fs.writeFileSync(...args);
		},
		renameSync: (...args: Parameters<typeof fs.renameSync>) => {
			if (refuse.rename !== undefined && String(args[0]).endsWith(".tmp")) {
				throw Object.assign(new Error(`${refuse.rename}: cannot replace the file, rename`), {
					code: refuse.rename,
					syscall: "rename",
				});
			}
			return fs.renameSync(...args);
		},
	};
});

let root: string;

beforeEach(() => {
	root = makeTempDirectory("settings-atomic-failure-");
});

afterEach(() => {
	refuse.temporary = false;
	refuse.created = [];
	refuse.rename = undefined;
	removeTempDirectory(root);
});

test("a temporary file that cannot be created reports that failure, not a missing-file cleanup error (#4320)", () => {
	const path = join(root, "settings.json");
	writeFileSync(path, '{"keep":true}');
	refuse.temporary = true;
	assert.throws(() => writeSettingsFile(path, '{"keep":false}'), { code: "EACCES" });
	assert.equal(readFileSync(path, "utf8"), '{"keep":true}');
	assert.deepEqual(readdirSync(root), ["settings.json"]);
});

test.skipIf(process.platform === "win32")(
	"the temporary file is created with the settings file's mode, never more readable than the file it replaces (#4320)",
	() => {
		const path = join(root, "settings.json");
		writeFileSync(path, '{"keep":true}');
		chmodSync(path, 0o600);
		writeSettingsFile(path, '{"keep":false}');
		writeSettingsFile(join(root, "new.json"), "{}");
		assert.deepEqual(refuse.created, [{ encoding: "utf-8", mode: 0o600 }, { encoding: "utf-8" }]);
	},
);

test("a settings file that cannot be replaced, such as a single mounted file, is written in place and recorded once (#4320)", () => {
	for (const code of ["EBUSY", "EXDEV"]) {
		const path = join(root, `${code}.json`);
		writeFileSync(path, '{"keep":true}');
		chmodSync(path, 0o600);
		refuse.rename = code;
		const first = writeSettingsFile(path, '{"keep":false}');
		const second = writeSettingsFile(path, '{"keep":"again"}');
		assert.equal(first.mode, "in-place");
		assert.equal(first.mode === "in-place" ? first.reason.code : undefined, code);
		assert.equal(second.mode, "in-place");
		assert.equal(readFileSync(path, "utf8"), '{"keep":"again"}');
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(
			settingsFilesWrittenInPlace().get(realpathSync(path)),
			first.mode === "in-place" ? first.reason : undefined,
		);
	}
	assert.deepEqual(readdirSync(root).sort(), ["EBUSY.json", "EXDEV.json"]);
	refuse.rename = undefined;
	const replaced = join(root, "replaced.json");
	assert.deepEqual(writeSettingsFile(replaced, "{}"), { mode: "replaced" });
	assert.equal(settingsFilesWrittenInPlace().has(realpathSync(replaced)), false);
});

test.skipIf(process.platform === "win32")(
	"a file written in place by its path and through a link is recorded once, under its real path (#4320)",
	() => {
		const path = join(root, "mounted.json");
		writeFileSync(path, "{}");
		mkdirSync(join(root, "sub"));
		const link = join(root, "link.json");
		symlinkSync("./sub/../mounted.json", link);
		refuse.rename = "EBUSY";

		writeSettingsFile(path, '{"via":"path"}');
		writeSettingsFile(link, '{"via":"link"}');

		assert.equal(readFileSync(path, "utf8"), '{"via":"link"}');
		const ownWrites = [...settingsFilesWrittenInPlace().keys()].filter((key) => key.startsWith(root));
		assert.deepEqual(ownWrites, [realpathSync(path)]);
	},
);

test("any other rename failure still throws and leaves the previous file and no temporary file (#4320)", () => {
	const path = join(root, "settings.json");
	writeFileSync(path, '{"keep":true}');
	for (const code of ["ENOSPC", "EACCES", "EPERM"]) {
		refuse.rename = code;
		assert.throws(() => writeSettingsFile(path, '{"keep":false}'), { code });
		assert.equal(readFileSync(path, "utf8"), '{"keep":true}');
		assert.deepEqual(readdirSync(root), ["settings.json"]);
		assert.equal(settingsFilesWrittenInPlace().has(realpathSync(path)), false);
	}
});
