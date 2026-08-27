import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	deriveImportClosure,
	INSTALLED_IMPORT_CLOSURE_ROOTS,
	relativeImportSpecifiers,
	resolveRelativeImport,
} from "../../packages/coding-agent/scripts/derive-import-closure.js";
import {
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	readDirectorySync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");
const distBuiltinRoot = join(root, "packages", "coding-agent", "dist", "builtin");
const buildCommand = "npm --workspace=@bastani/atomic run build";

function requireBuiltPath(path: string): void {
	assert.ok(fileExistsSync(path), `Missing built artifact ${path}. Run \`${buildCommand}\` before this test.`);
}

function listFiles(path: string, prefix = ""): string[] {
	const files: string[] = [];
	for (const entry of readDirectorySync(path, { withFileTypes: true })) {
		const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) files.push(...listFiles(join(path, entry.name), relativePath));
		else if (entry.isFile()) files.push(relativePath);
	}
	return files;
}

test("builtin copy derives transitive relative imports without copying excluded files", () => {
	const fixture = makeTempDirectory("atomic-builtin-import-closure-");
	try {
		makeDirectorySync(join(fixture, "broker"), { recursive: true });
		makeDirectorySync(join(fixture, "node_modules", "ignored"), { recursive: true });
		writeTextSync(
			join(fixture, "broker", "entry.ts"),
			[
				'export { value } from "../new-dependency.js";',
				'type Imported = import("../type-target.js").Foo;',
				'const required = require("../require-target.js");',
				"export const loaded: Imported | typeof required = required;",
			].join("\n"),
		);
		writeTextSync(join(fixture, "new-dependency.ts"), 'export { value } from "./nested.js";\n');
		writeTextSync(join(fixture, "nested.ts"), "export const value = 1;\n");
		writeTextSync(join(fixture, "type-target.ts"), "export interface Foo { value: number }\n");
		writeTextSync(join(fixture, "require-target.ts"), "export const required = true;\n");
		writeTextSync(join(fixture, "unrelated.ts"), "export const unrelated = true;\n");
		writeTextSync(join(fixture, "unrelated.test.ts"), "throw new Error();\n");
		writeTextSync(join(fixture, "unrelated.spec.ts"), "throw new Error();\n");
		writeTextSync(join(fixture, "node_modules", "ignored", "index.ts"), "throw new Error();\n");

		assert.deepEqual([...deriveImportClosure(fixture, ["broker/"])].sort(), [
			"broker/entry.ts",
			"nested.ts",
			"new-dependency.ts",
			"require-target.ts",
			"type-target.ts",
		]);

		writeTextSync(join(fixture, "broker", "entry.ts"), 'export { value } from "../../outside.js";\n');
		assert.throws(() => deriveImportClosure(fixture, ["broker/"]), /escapes the package root/u);
	} finally {
		removeTempDirectory(fixture);
	}
});

test("builtin copy fails closed on non-literal dynamic specifiers", () => {
	const fixture = makeTempDirectory("atomic-builtin-dynamic-import-");
	try {
		makeDirectorySync(join(fixture, "broker"), { recursive: true });
		const entry = join(fixture, "broker", "entry.ts");
		writeTextSync(entry, "const target = './dynamic.js';\nvoid import(target);\n");
		assert.throws(() => deriveImportClosure(fixture, ["broker/"]), /Non-literal import\(\) specifier/u);

		writeTextSync(entry, "const target = './dynamic.js';\nrequire(target);\n");
		assert.throws(() => deriveImportClosure(fixture, ["broker/"]), /Non-literal require\(\) specifier/u);
	} finally {
		removeTempDirectory(fixture);
	}
});

test("builtin copy rejects a relative import that resolves beneath an excluded path", () => {
	const fixture = makeTempDirectory("atomic-builtin-excluded-import-");
	try {
		makeDirectorySync(join(fixture, "broker"), { recursive: true });
		makeDirectorySync(join(fixture, "test"), { recursive: true });
		writeTextSync(join(fixture, "broker", "entry.ts"), 'export { helper } from "../test/helper.js";\n');
		writeTextSync(join(fixture, "test", "helper.ts"), "export const helper = true;\n");
		assert.throws(
			() => deriveImportClosure(fixture, ["broker/"]),
			/Relative import \.\.\/test\/helper\.js from broker\/entry\.ts resolves to excluded path test\/helper\.ts/u,
		);
	} finally {
		removeTempDirectory(fixture);
	}
});

test("every shipped raw TypeScript file has resolvable relative imports", () => {
	for (const packageName of Object.keys(INSTALLED_IMPORT_CLOSURE_ROOTS)) {
		const packageRoot = join(distBuiltinRoot, packageName);
		requireBuiltPath(packageRoot);
		const rawTypeScriptFiles = listFiles(packageRoot).filter(
			(path) => path.endsWith(".ts") && !path.endsWith(".d.ts"),
		);
		for (const relativePath of rawTypeScriptFiles) {
			const importer = join(packageRoot, relativePath);
			for (const specifier of relativeImportSpecifiers(importer)) {
				assert.ok(
					resolveRelativeImport(importer, specifier),
					`Unresolved relative import ${specifier} from ${packageName}/${relativePath}`,
				);
			}
		}
	}
});

test("shipped intercom includes broker dependencies without excluded files", () => {
	const intercomRoot = join(distBuiltinRoot, "intercom");
	requireBuiltPath(intercomRoot);
	for (const path of ["group.ts", "session-target.ts", "source-ownership.ts", "types.ts"]) {
		assert.ok(fileExistsSync(join(intercomRoot, path)), `Missing shipped intercom dependency ${path}`);
	}
	const files = listFiles(intercomRoot);
	assert.equal(
		files.some((path) => path.endsWith(".test.ts")),
		false,
	);
	assert.equal(
		files.some((path) => path.endsWith(".spec.ts")),
		false,
	);
	assert.equal(
		files.some((path) => path.split("/").includes("node_modules")),
		false,
	);
});
