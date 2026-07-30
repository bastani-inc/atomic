import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueUncached,
} from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";

describe("resolveConfigValue", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-config-value-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	test("resolves literals, environment templates, and escapes", () => {
		process.env.TEST_CONFIG_LEFT = "left";
		process.env.TEST_CONFIG_RIGHT = "right";
		try {
			expect(resolveConfigValue("literal-key")).toBe("literal-key");
			expect(resolveConfigValue("$TEST_CONFIG_LEFT")).toBe("left");
			expect(resolveConfigValue("$" + "{TEST_CONFIG_LEFT}_$TEST_CONFIG_RIGHT")).toBe("left_right");
			expect(resolveConfigValue("$$TEST_CONFIG_LEFT")).toBe("$TEST_CONFIG_LEFT");
			expect(resolveConfigValue("$!literal-$TEST_CONFIG_RIGHT")).toBe("!literal-right");
		} finally {
			delete process.env.TEST_CONFIG_LEFT;
			delete process.env.TEST_CONFIG_RIGHT;
		}
	});

	test("uses credential-scoped environment before process.env", () => {
		process.env.TEST_CONFIG_SCOPED = "process";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_SCOPED", { TEST_CONFIG_SCOPED: "credential" })).toBe("credential");
		} finally {
			delete process.env.TEST_CONFIG_SCOPED;
		}
	});

	test("executes shell commands and trims their output", () => {
		expect(resolveConfigValue("!echo '  spaced-key  '")).toBe("spaced-key");
		expect(resolveConfigValue("!printf 'line1\\nline2'")).toBe("line1\nline2");
		expect(resolveConfigValue("!echo 'hello world' | tr ' ' '-'")).toBe("hello-world");
	});

	test.each(["!exit 1", "!nonexistent-command-12345", "!printf ''"])(
		"returns undefined when command resolution fails: %s",
		(command) => {
			expect(resolveConfigValue(command)).toBeUndefined();
		},
	);

	test("caches successful and failed commands until explicitly cleared", () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");
		// Slashes first (sh-friendly on Windows), then one escaping pass covering
		// both backslash and quote: escaping quotes alone is the incomplete
		// sanitization CodeQL flags (js/incomplete-sanitization).
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/[\\"]/g, "\\$&");
		const success = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;

		expect(resolveConfigValue(success)).toBe("value");
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");

		clearConfigValueCache();
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");

		const failure = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; exit 1'`;
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("3");
	});

	test("does not cache environment values", () => {
		process.env.TEST_CONFIG_DYNAMIC = "first";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("first");
			process.env.TEST_CONFIG_DYNAMIC = "second";
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("second");
		} finally {
			delete process.env.TEST_CONFIG_DYNAMIC;
		}
	});

	test("uncached resolution executes a command on every call", () => {
		const counterFile = join(tempDir, "uncached-counter");
		writeFileSync(counterFile, "0");
		// Same complete escaping pass as above (CodeQL js/incomplete-sanitization).
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/[\\"]/g, "\\$&");
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
	});

	test("uses stdin when the configured Windows shell requires it", () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-s"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const expansion = "$" + "{name}";
			expect(resolveConfigValueUncached(`!name='World'; echo "Hello, ${expansion}!"`)).toBe("Hello, World!");
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});

describe("AuthStorage file backend regressions", () => {
	let tempDir: string;
	let authPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-auth-backend-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "anthropic-key" } }));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("fresh storage reads credentials while another process holds the write lock", async () => {
		const release = lockfile.lockSync(authPath, { realpath: false });
		try {
			const storage = AuthStorage.create(authPath);
			await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "anthropic-key" });
		} finally {
			release();
		}
	});

	test("many fresh storage reads succeed while the write lock is held", async () => {
		const release = lockfile.lockSync(authPath, { realpath: false });
		try {
			for (let index = 0; index < 12; index++) {
				const storage = AuthStorage.create(authPath);
				await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "anthropic-key" });
			}
		} finally {
			release();
		}
	});

	test("reads resolve while an async writer holds the lock across an await", async () => {
		const backend = new FileAuthStorageBackend(authPath, [authPath]);
		let releaseHeld!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseHeld = resolve;
		});
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const writer = backend.withLockAsync(async () => {
			markEntered();
			await held;
			return { result: undefined };
		});
		await entered;

		try {
			for (let index = 0; index < 10; index++) {
				const storage = AuthStorage.create(authPath);
				await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "anthropic-key" });
			}
		} finally {
			releaseHeld();
			await writer;
		}
	});

	test("atomic writes leave no sibling temporary files", async () => {
		const storage = AuthStorage.create(authPath);
		await storage.modify("openai", async () => ({ type: "api_key", key: "openai-key" }));

		expect(readdirSync(tempDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
	});

	const posixTest = process.platform === "win32" ? test.skip : test;
	posixTest("atomic writes preserve 0600 file permissions", async () => {
		const storage = AuthStorage.create(authPath);
		await storage.modify("openai", async () => ({ type: "api_key", key: "openai-key" }));
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
	});
});
