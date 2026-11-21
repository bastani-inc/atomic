import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	clearDeprecationWarningsForTests,
	setDeprecationWarningSink,
} from "../../packages/coding-agent/src/utils/deprecation.js";
import { installNativeModuleWarning } from "../../packages/coding-agent/src/utils/native-module-warning.js";

const REPORT = Symbol.for("@bastani/atomic/natives/report-missing-platform-package");
const MISSING = Symbol.for("@bastani/atomic/natives/missing-platform-package");
type Registry = typeof globalThis & { [REPORT]?: (message: string) => void; [MISSING]?: string };

let restoreSink: (() => void) | undefined;
let directory: string | undefined;

beforeEach(() => {
	clearDeprecationWarningsForTests();
});

afterEach(() => {
	restoreSink?.();
	restoreSink = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	delete (globalThis as Registry)[REPORT];
	delete (globalThis as Registry)[MISSING];
	clearDeprecationWarningsForTests();
	vi.restoreAllMocks();
});

/** The platform package `@bastani/atomic-natives` loads its binary from on the hosts the tests run on. */
const HOST_PLATFORM_PACKAGE: Record<string, string> = {
	"linux-x64": "@bastani/atomic-natives-linux-x64-gnu",
	"linux-arm64": "@bastani/atomic-natives-linux-arm64-gnu",
	"darwin-x64": "@bastani/atomic-natives-darwin-x64",
	"darwin-arm64": "@bastani/atomic-natives-darwin-arm64",
	"win32-x64": "@bastani/atomic-natives-win32-x64-msvc",
	"win32-arm64": "@bastani/atomic-natives-win32-arm64-msvc",
};
const hostPlatformPackage = HOST_PLATFORM_PACKAGE[`${process.platform}-${process.arch}`];

/**
 * `@bastani/atomic-natives`' own loader, installed as published (its package lists this host's platform package as an
 * optional dependency) without that package and with no binary beside it.
 */
function loadNativesWithoutBinding(): string {
	directory ??= mkdtempSync(join(tmpdir(), "atomic-natives-missing-"));
	mkdirSync(join(directory, "native"), { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name: "@bastani/atomic-natives",
			optionalDependencies: { [String(hostPlatformPackage)]: "0.10.4" },
		}),
	);
	copyFileSync(join("packages", "natives", "native", "index.js"), join(directory, "native", "index.js"));
	try {
		createRequire(join(directory, "native", "index.js"))("./index.js");
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("the loader found a native binding");
}

test("a native module that cannot load because its platform package is missing is shown once, never as napi's advice", () => {
	const shown: string[] = [];
	restoreSink = setDeprecationWarningSink((message) => shown.push(message));
	installNativeModuleWarning();

	const message = loadNativesWithoutBinding();
	loadNativesWithoutBinding();

	assert.ok(
		message.startsWith(
			`Cannot find Atomic's native module: the optional package ${hostPlatformPackage} is not installed.`,
		),
		message,
	);
	assert.match(message, /Reinstall Atomic without omitting optional dependencies/);
	assert.doesNotMatch(message, /npm has a bug/);
	assert.deepEqual(shown, [message]);
});

test("a native module that failed to load before Atomic set up its warnings is shown when it does", () => {
	const message = loadNativesWithoutBinding();
	const shown: string[] = [];
	restoreSink = setDeprecationWarningSink((warning) => shown.push(warning));

	installNativeModuleWarning();

	assert.deepEqual(shown, [message]);
	assert.equal((globalThis as Registry)[MISSING], undefined);
});

test("without a UI the warning goes to stderr as a warning, not as a deprecation", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	installNativeModuleWarning();

	const message = loadNativesWithoutBinding();

	assert.equal(warn.mock.calls.length, 1);
	const printed = String(warn.mock.calls[0]?.[0]);
	assert.ok(printed.includes(`Warning: ${message}`), printed);
	assert.equal(printed.includes("Deprecation"), false);
});
