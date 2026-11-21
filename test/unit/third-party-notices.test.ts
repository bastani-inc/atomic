import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { thirdPartyNotices } from "../../packages/coding-agent/scripts/third-party-notices.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-notices-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function writePackage(
	dir: string,
	manifest: { name: string; version: string; license: string; dependencies?: Record<string, string> },
	files: Record<string, string>,
): Promise<void> {
	await writeFileEnsuringDir(join(dir, "package.json"), JSON.stringify(manifest));
	for (const [name, text] of Object.entries(files)) await writeFileEnsuringDir(join(dir, name), text);
}

test("bundle notices carry the licence files of every bundled package and the dependencies its prebuilt files include", async () => {
	const modules = join(root, "node_modules");
	await writePackage(
		join(modules, "prebuilt"),
		{ name: "prebuilt", version: "1.0.0", license: "ISC", dependencies: { helper: "^2.0.0" } },
		{
			LICENSE: "ISC licence text of prebuilt",
			"worker.js": "/**\n * @license\n * Copyright 2026 Example LLC\n */\nexport const a = 1;\n// plain comment\n",
		},
	);
	await writePackage(
		join(modules, "helper"),
		{ name: "helper", version: "2.1.0", license: "MIT" },
		{ "LICENSE.md": "MIT licence text of helper", NOTICE: "helper notice text" },
	);
	await writePackage(
		join(modules, "@scope", "direct"),
		{ name: "@scope/direct", version: "3.0.0", license: "Apache-2.0" },
		{
			"index.js": [
				"// Taken from Other, (c) 2007-2020 Someone under the MIT license",
				"export default 1;",
				"// These strings are from a draft of DOM Core.",
				"// Copyright 2011 Standards Body, All Rights Reserved.",
				"// Used under the terms of the Document License:",
				"// https://example.org/document-license",
				"",
				"// unrelated trailing comment",
			].join("\n"),
		},
	);
	await writePackage(
		join(modules, "unrelated"),
		{ name: "unrelated", version: "1.0.0", license: "MIT" },
		{
			LICENSE: "unrelated licence",
		},
	);

	const notices = thirdPartyNotices("index.bundle.mjs", [
		join(root, "src", "index.ts"),
		join(modules, "prebuilt", "worker.js"),
		join(modules, "@scope", "direct", "index.js"),
	]);

	assert.ok(notices !== undefined);
	assert.match(notices, /^index\.bundle\.mjs includes code from the following packages/);
	for (const expected of [
		"== @scope/direct@3.0.0 (Apache-2.0) ==",
		"== helper@2.1.0 (MIT) ==",
		"== prebuilt@1.0.0 (ISC) ==",
		"ISC licence text of prebuilt",
		"MIT licence text of helper",
		"helper notice text",
		"Copyright 2026 Example LLC",
		"(c) 2007-2020 Someone under the MIT license",
		[
			"// These strings are from a draft of DOM Core.",
			"// Copyright 2011 Standards Body, All Rights Reserved.",
			"// Used under the terms of the Document License:",
			"// https://example.org/document-license",
		].join("\n"),
	]) {
		assert.ok(notices.includes(expected), `missing ${expected}`);
	}
	assert.equal(notices.includes("unrelated"), false);
	assert.equal(notices.includes("plain comment"), false);
	assert.equal(notices.includes("unrelated trailing comment"), false);
	assert.ok(notices.indexOf("@scope/direct@") < notices.indexOf("helper@"));
	assert.ok(notices.indexOf("helper@") < notices.indexOf("prebuilt@"));
});

test("a bundle of first-party code only has no notices", () => {
	assert.equal(thirdPartyNotices("index.bundle.mjs", [join(root, "src", "index.ts")]), undefined);
});
