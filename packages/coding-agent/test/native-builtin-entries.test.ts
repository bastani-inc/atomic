import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	BUILTIN_PACKAGE_DIR_NAMES,
	INSTALLED_EXTENSION_ENTRIES,
	SOURCE_EXTENSION_ENTRIES,
} from "../src/core/builtin-install-layout.ts";
import { extensionLoaderTestHooks, loadExtensionModule } from "../src/core/extensions/loader-virtual-modules.ts";
import {
	getNativeBuiltinExtensionEntries,
	isNativeBuiltinExtensionPath,
	resetNativeBuiltinExtensionEntriesForTest,
} from "../src/core/extensions/native-builtin-entries.ts";

const roots: string[] = [];
const originalPackageDir = process.env.ATOMIC_PACKAGE_DIR;

function createInstall(options: { spoof?: "subagents" } = {}): string {
	const packageDir = mkdtempSync(join(tmpdir(), "atomic-native-builtins-"));
	roots.push(packageDir);
	for (const dirName of BUILTIN_PACKAGE_DIR_NAMES) {
		const builtinDir = join(packageDir, "builtin", dirName);
		const installedEntry = join(builtinDir, INSTALLED_EXTENSION_ENTRIES[dirName]);
		mkdirSync(dirname(installedEntry), { recursive: true });
		writeFileSync(
			join(builtinDir, "package.json"),
			JSON.stringify({
				name: options.spoof === dirName ? "user-controlled-package" : `@bastani/${dirName}`,
				atomic: { extensions: ["manifest-only.bundle.mjs"] },
			}),
		);
		writeFileSync(installedEntry, "export default function register() {}\n");
		writeFileSync(join(builtinDir, "manifest-only.bundle.mjs"), "export default function register() {}\n");
		const sourceEntry = join(builtinDir, SOURCE_EXTENSION_ENTRIES[dirName]);
		mkdirSync(dirname(sourceEntry), { recursive: true });
		if (!existsSync(sourceEntry)) writeFileSync(sourceEntry, "export default function register() {}\n");
	}
	process.env.ATOMIC_PACKAGE_DIR = packageDir;
	resetNativeBuiltinExtensionEntriesForTest();
	return packageDir;
}

afterEach(() => {
	if (originalPackageDir === undefined) delete process.env.ATOMIC_PACKAGE_DIR;
	else process.env.ATOMIC_PACKAGE_DIR = originalPackageDir;
	resetNativeBuiltinExtensionEntriesForTest();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("trusts exactly the four identity-verified installed builtin entries", async () => {
	const packageDir = createInstall();
	const expected = BUILTIN_PACKAGE_DIR_NAMES.map((dirName) =>
		resolve(packageDir, "builtin", dirName, INSTALLED_EXTENSION_ENTRIES[dirName]),
	);

	expect([...(await getNativeBuiltinExtensionEntries())]).toEqual(expected);
});

test("does not infer builtin trust from suffixes, filenames, manifests, or source entries", async () => {
	const packageDir = createInstall();
	const arbitrary = join(packageDir, "arbitrary.mjs");
	writeFileSync(arbitrary, "export default function register() {}\n");
	const subagentsDir = join(packageDir, "builtin", "subagents");
	const sibling = join(subagentsDir, "sibling.mjs");
	writeFileSync(sibling, "export default function register() {}\n");

	expect(await isNativeBuiltinExtensionPath(arbitrary)).toBe(false);
	expect(await isNativeBuiltinExtensionPath(join(subagentsDir, "manifest-only.bundle.mjs"))).toBe(false);
	expect(await isNativeBuiltinExtensionPath(sibling)).toBe(false);
	expect(await isNativeBuiltinExtensionPath(join(subagentsDir, SOURCE_EXTENSION_ENTRIES.subagents))).toBe(false);
});

test("rejects an installed-looking entry when the package identity is not Atomic-owned", async () => {
	const packageDir = createInstall({ spoof: "subagents" });
	const spoofedEntry = resolve(packageDir, "builtin", "subagents", INSTALLED_EXTENSION_ENTRIES.subagents);

	expect(await isNativeBuiltinExtensionPath(spoofedEntry)).toBe(false);
	expect((await getNativeBuiltinExtensionEntries()).size).toBe(3);
});

test("does not retain installed builtin factories in the native cache under Node", async () => {
	const packageDir = createInstall();
	const entry = resolve(packageDir, "builtin", "subagents", INSTALLED_EXTENSION_ENTRIES.subagents);

	expect(await isNativeBuiltinExtensionPath(entry)).toBe(true);
	const factory = await loadExtensionModule(entry);
	expect(typeof factory).toBe("function");
	// Under Node both .mjs routes converge behaviorally, so cache population is
	// the faithful observable that the single-file-build guard remained inert.
	expect(extensionLoaderTestHooks.hasNativeBuiltinFactory(entry)).toBe(false);
});
