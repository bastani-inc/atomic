import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	deriveImportClosure,
	INSTALLED_IMPORT_CLOSURE_ROOTS,
} from "../../packages/coding-agent/scripts/derive-import-closure.js";
import {
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	readDirectorySync,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

interface WorkflowsManifest {
	exports?: {
		"."?: {
			types?: string;
		};
	};
}

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
		writeTextSync(join(fixture, "broker", "entry.ts"), 'export { value } from "../new-dependency.js";\n');
		writeTextSync(join(fixture, "new-dependency.ts"), 'export { value } from "./nested.js";\n');
		writeTextSync(join(fixture, "nested.ts"), "export const value = 1;\n");
		writeTextSync(join(fixture, "unrelated.ts"), "export const unrelated = true;\n");
		writeTextSync(join(fixture, "unrelated.test.ts"), "throw new Error();\n");
		writeTextSync(join(fixture, "unrelated.spec.ts"), "throw new Error();\n");
		writeTextSync(join(fixture, "node_modules", "ignored", "index.ts"), "throw new Error();\n");

		assert.deepEqual([...deriveImportClosure(fixture, ["broker/"])].sort(), [
			"broker/entry.ts",
			"nested.ts",
			"new-dependency.ts",
		]);

		writeTextSync(join(fixture, "broker", "entry.ts"), 'export { value } from "../../outside.js";\n');
		assert.throws(() => deriveImportClosure(fixture, ["broker/"]), /escapes the package root/u);
	} finally {
		removeTempDirectory(fixture);
	}
});

test("shipped raw TypeScript closure roots have no unresolved relative imports", () => {
	for (const [packageName, roots] of Object.entries(INSTALLED_IMPORT_CLOSURE_ROOTS)) {
		const packageRoot = join(distBuiltinRoot, packageName);
		requireBuiltPath(packageRoot);
		assert.doesNotThrow(() => deriveImportClosure(packageRoot, roots));
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

test("shipped workflows manifest points its types condition at the emitted declaration", () => {
	const workflowsRoot = join(distBuiltinRoot, "workflows");
	const manifestPath = join(workflowsRoot, "package.json");
	const declarationPath = join(workflowsRoot, "src", "authoring.d.ts");
	requireBuiltPath(manifestPath);
	const manifest = JSON.parse(readTextSync(manifestPath, "utf8")) as WorkflowsManifest;
	assert.equal(manifest.exports?.["."]?.types, "./src/authoring.d.ts");
	assert.ok(fileExistsSync(declarationPath), "The workflows authoring declaration must be shipped");
});
