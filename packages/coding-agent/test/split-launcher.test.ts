import { afterEach, describe, expect, test } from "vitest";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
	isSplitLauncherRuntime,
	moduleDirFromMetaUrl,
	moduleFileFromMetaUrl,
	splitLauncherDir,
} from "../src/utils/split-launcher.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalCodingAgent = process.env.ATOMIC_CODING_AGENT;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", { value, configurable: true, writable: false });
}

afterEach(() => {
	if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
	if (originalCodingAgent === undefined) delete process.env.ATOMIC_CODING_AGENT;
	else process.env.ATOMIC_CODING_AGENT = originalCodingAgent;
});

// The real Windows trigger is a macOS `file:///Users/...` URL (no drive letter),
// which fileURLToPath rejects on Windows. That URL still decodes fine on POSIX
// dev machines, so for a cross-platform unit test we use a non-file scheme,
// which fileURLToPath rejects everywhere — exercising the same catch/fallback
// branch deterministically.
const NON_DECODABLE_URL = "https://example.com/build/app.js";
const VALID_LOCAL_URL = pathToFileURL(join(process.cwd(), "some", "module.js")).href;

describe("isSplitLauncherRuntime", () => {
	test("true only when ATOMIC_CODING_AGENT=true and execPath is the atomic launcher", () => {
		process.env.ATOMIC_CODING_AGENT = "true";
		setExecPath(join("C:", "atomic", "atomic.exe"));
		expect(isSplitLauncherRuntime()).toBe(true);

		setExecPath(join("/opt", "atomic", "atomic"));
		expect(isSplitLauncherRuntime()).toBe(true);
	});

	test("false when the env flag is set but the runtime is plain bun (not the launcher)", () => {
		process.env.ATOMIC_CODING_AGENT = "true";
		setExecPath(join("/opt", "homebrew", "bin", "bun"));
		expect(isSplitLauncherRuntime()).toBe(false);
	});

	test("false when the env flag is absent", () => {
		delete process.env.ATOMIC_CODING_AGENT;
		setExecPath(join("C:", "atomic", "atomic.exe"));
		expect(isSplitLauncherRuntime()).toBe(false);
	});
});

describe("moduleDirFromMetaUrl", () => {
	test("decodes a valid local URL normally", () => {
		expect(moduleDirFromMetaUrl(VALID_LOCAL_URL)).toBe(dirname(join(process.cwd(), "some", "module.js")));
	});

	test("falls back to an executable-relative dir under the split launcher when decode fails", () => {
		process.env.ATOMIC_CODING_AGENT = "true";
		setExecPath(join("C:", "atomic", "atomic.exe"));
		expect(moduleDirFromMetaUrl(NON_DECODABLE_URL, "dist", "core")).toBe(
			join(splitLauncherDir(), "dist", "core"),
		);
	});

	test("rethrows a decode failure when not the split launcher", () => {
		delete process.env.ATOMIC_CODING_AGENT;
		setExecPath(join("/opt", "homebrew", "bin", "bun"));
		expect(() => moduleDirFromMetaUrl(NON_DECODABLE_URL)).toThrow();
	});
});

describe("moduleFileFromMetaUrl", () => {
	test("falls back to an executable-relative file under the split launcher when decode fails", () => {
		process.env.ATOMIC_CODING_AGENT = "true";
		setExecPath(join("C:", "atomic", "atomic.exe"));
		expect(moduleFileFromMetaUrl(NON_DECODABLE_URL, "app.js")).toBe(join(splitLauncherDir(), "app.js"));
	});
});
