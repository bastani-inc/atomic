import assert from "node:assert/strict";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { writeSettingsFile } from "../../packages/coding-agent/src/core/settings-storage.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const refuse = vi.hoisted(() => ({ temporary: false, created: [] as unknown[] }));
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
	};
});

let root: string;

beforeEach(() => {
	root = makeTempDirectory("settings-atomic-failure-");
});

afterEach(() => {
	refuse.temporary = false;
	refuse.created = [];
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
