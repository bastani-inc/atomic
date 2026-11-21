import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { applyArgumentEnvironment, settingsEnvironmentForEarlyChild } from "../src/utils/startup-environment.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentDirWith(settings: string | undefined): string {
	const dir = mkdtempSync(join(tmpdir(), "startup-environment-"));
	tempDirs.push(dir);
	if (settings !== undefined) writeFileSync(join(dir, "settings.json"), settings);
	return dir;
}

describe("the settings environment of an engine child started before main() loads the settings", () => {
	test("gives the child the proxy and debug setting while this process's environment stays as it was", async () => {
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ATOMIC_DEBUG_SETTING"]) vi.stubEnv(name, undefined);
		const env = await settingsEnvironmentForEarlyChild(
			agentDirWith(`\uFEFF${JSON.stringify({ debug: true, httpProxy: "  http://proxy.test:3128  " })}`),
		);
		assert.deepEqual(env, {
			ATOMIC_DEBUG_SETTING: "1",
			HTTP_PROXY: "http://proxy.test:3128",
			HTTPS_PROXY: "http://proxy.test:3128",
		});
		// main() applies the settings it loads itself, so a file changed meanwhile is never applied here from this read.
		assert.equal(process.env.HTTP_PROXY, undefined);
		assert.equal(process.env.HTTPS_PROXY, undefined);
		assert.equal(process.env.ATOMIC_DEBUG_SETTING, undefined);
	});

	test("keeps a proxy the environment names, and a debug setting a parent passed down", async () => {
		vi.stubEnv("HTTP_PROXY", "http://user.test:8080");
		vi.stubEnv("HTTPS_PROXY", undefined);
		vi.stubEnv("ATOMIC_DEBUG_SETTING", "0");
		const env = await settingsEnvironmentForEarlyChild(
			agentDirWith(JSON.stringify({ debug: true, httpProxy: "http://proxy.test:3128" })),
		);
		assert.deepEqual(env, { HTTPS_PROXY: "http://proxy.test:3128" });
	});

	test("reads values of the wrong type, and a missing or unparsable file, as no setting", async () => {
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ATOMIC_DEBUG_SETTING"]) vi.stubEnv(name, undefined);
		assert.deepEqual(
			await settingsEnvironmentForEarlyChild(agentDirWith(JSON.stringify({ debug: "true", httpProxy: 3128 }))),
			{ ATOMIC_DEBUG_SETTING: "0" },
		);
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith(JSON.stringify({ httpProxy: "  " }))), {
			ATOMIC_DEBUG_SETTING: "0",
		});
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith(undefined)), { ATOMIC_DEBUG_SETTING: "0" });
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith("{ not json")), {});
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDirWith("[]")), {});
	});
});

describe("the global settings layers, without an agent directory named by the environment", () => {
	/** A home whose Atomic and legacy agent directories hold these `settings.json` contents (undefined: no file). */
	function homeWith(atomic: string | undefined, legacy: string | undefined): string {
		const home = mkdtempSync(join(tmpdir(), "startup-environment-home-"));
		tempDirs.push(home);
		for (const [directory, content] of [
			[join(home, ".atomic", "agent"), atomic],
			[join(home, ".pi", "agent"), legacy],
		] as const) {
			mkdirSync(directory, { recursive: true });
			if (content !== undefined) writeFileSync(join(directory, "settings.json"), content);
		}
		for (const name of [
			"ATOMIC_CODING_AGENT_DIR",
			"PI_CODING_AGENT_DIR",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ATOMIC_DEBUG_SETTING",
		])
			vi.stubEnv(name, undefined);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		return join(home, ".atomic", "agent");
	}

	test("the Atomic file's values win over the legacy file's, each value of the right type only", async () => {
		const agentDir = homeWith(
			JSON.stringify({ debug: false, httpProxy: 8080 }),
			JSON.stringify({ debug: true, httpProxy: "http://legacy.test:3128" }),
		);
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDir), {
			ATOMIC_DEBUG_SETTING: "0",
			HTTP_PROXY: "http://legacy.test:3128",
			HTTPS_PROXY: "http://legacy.test:3128",
		});
		const legacyOnly = homeWith(undefined, JSON.stringify({ debug: true }));
		assert.deepEqual(await settingsEnvironmentForEarlyChild(legacyOnly), { ATOMIC_DEBUG_SETTING: "1" });
	});

	test("a legacy file that cannot be parsed leaves no global settings, as the settings manager reads them", async () => {
		const agentDir = homeWith(JSON.stringify({ debug: true, httpProxy: "http://proxy.test:3128" }), "{ broken");
		assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDir), {});
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a legacy file that cannot be read leaves no global settings either",
		async () => {
			const agentDir = homeWith(JSON.stringify({ debug: true }), JSON.stringify({}));
			const legacy = join(agentDir, "..", "..", ".pi", "agent", "settings.json");
			chmodSync(legacy, 0o000);
			try {
				assert.deepEqual(await settingsEnvironmentForEarlyChild(agentDir), {});
			} finally {
				chmodSync(legacy, 0o600);
			}
		},
	);
});

describe("the environment the command line sets before main()", () => {
	test("--debug turns debug mode on only where the parser reads it as the flag", async () => {
		for (const name of ["ATOMIC_DEBUG", "PI_DEBUG", "ATOMIC_OFFLINE", "PI_OFFLINE"]) vi.stubEnv(name, undefined);
		await applyArgumentEnvironment(["--name", "--debug"]);
		assert.equal(process.env.ATOMIC_DEBUG, undefined, "--debug as the value of --name");
		await applyArgumentEnvironment(["--debug"]);
		assert.equal(process.env.ATOMIC_DEBUG, "1");
	});
});
