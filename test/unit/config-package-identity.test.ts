import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	COMPANION_BUILTIN_PACKAGE_NAMES,
	isCompanionBuiltinPackageName,
	packageJsonDefinesAppIdentity,
	resolvePackageDirFrom,
} from "../../packages/coding-agent/src/config-package-identity.ts";
import { BUILTIN_PACKAGE_DIR_NAMES } from "../../packages/coding-agent/src/core/builtin-install-layout.ts";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

test("companion package names stay aligned with shipped builtin directories", () => {
	assert.deepEqual(
		COMPANION_BUILTIN_PACKAGE_NAMES,
		BUILTIN_PACKAGE_DIR_NAMES.map((dirName) => `@bastani/${dirName}`),
	);
	assert.equal(isCompanionBuiltinPackageName("@bastani/workflows"), true);
	assert.equal(isCompanionBuiltinPackageName("@bastani/atomic"), false);
});

test("atomicConfig or the Atomic package name marks app identity", () => {
	assert.equal(packageJsonDefinesAppIdentity({ name: "@bastani/atomic" }), true);
	assert.equal(packageJsonDefinesAppIdentity({ name: "@mariozechner/pi" }), true);
	assert.equal(
		packageJsonDefinesAppIdentity({
			name: "@bastani/workflows",
			atomicConfig: { name: "atomic", configDir: ".atomic" },
		}),
		true,
	);
	assert.equal(
		packageJsonDefinesAppIdentity({
			name: "@bastani/workflows",
			piConfig: { name: "pi", configDir: ".pi" },
		}),
		true,
	);
	assert.equal(packageJsonDefinesAppIdentity({ name: "@bastani/workflows" }), false);
});

test("prebundled workflows package.json does not become the Atomic app root", async () => {
	const root = makeTempDirectory("atomic-package-identity-");
	try {
		const atomicRoot = join(root, "node_modules", "@bastani", "atomic");
		const bundleDir = join(atomicRoot, "dist", "builtin", "workflows", "src", "extension");
		await writeFileEnsuringDir(
			join(atomicRoot, "package.json"),
			JSON.stringify({
				name: "@bastani/atomic",
				atomicConfig: { name: "atomic", configDir: ".atomic" },
			}),
		);
		await writeFileEnsuringDir(
			join(atomicRoot, "dist", "builtin", "workflows", "package.json"),
			JSON.stringify({ name: "@bastani/workflows" }),
		);

		assert.equal(resolvePackageDirFrom(bundleDir), atomicRoot);
	} finally {
		removeTempDirectory(root);
	}
});

test("prebundled companion with a non-object atomicConfig still walks to Atomic", async () => {
	const root = makeTempDirectory("atomic-package-identity-primitive-");
	try {
		const atomicRoot = join(root, "node_modules", "@bastani", "atomic");
		const bundleDir = join(atomicRoot, "dist", "builtin", "workflows", "src", "extension");
		await writeFileEnsuringDir(
			join(atomicRoot, "package.json"),
			JSON.stringify({
				name: "@bastani/atomic",
				atomicConfig: { name: "atomic", configDir: ".atomic" },
			}),
		);
		await writeFileEnsuringDir(
			join(atomicRoot, "dist", "builtin", "workflows", "package.json"),
			JSON.stringify({ name: "@bastani/workflows", atomicConfig: true }),
		);

		assert.equal(resolvePackageDirFrom(bundleDir), atomicRoot);
	} finally {
		removeTempDirectory(root);
	}
});
