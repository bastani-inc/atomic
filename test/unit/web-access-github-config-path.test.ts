import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getUserConfigPaths } from "@bastani/atomic";
import { afterAll, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const home = makeTempDirectory("web-github-config-home-");
vi.stubEnv("HOME", home);
vi.stubEnv("USERPROFILE", home);
vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(home, "agent"));
vi.stubEnv("XDG_RUNTIME_DIR", "");

const [primaryPath, legacyPath] = getUserConfigPaths("web-search.json");
assert.ok(primaryPath);
assert.ok(legacyPath);
const { loadGitHubConfig, resetGitHubConfig } = await import("../../packages/web-access/github-config.js");

afterAll(() => {
	resetGitHubConfig();
	vi.unstubAllEnvs();
	removeTempDirectory(home);
});

test("GitHub clone settings follow legacy fallback and current-file precedence after reset (#5377)", async () => {
	const legacy = {
		enabled: false,
		maxRepoSizeMB: 42,
		cloneTimeoutSeconds: 17,
		clonePath: join(home, "legacy-clones"),
	};
	mkdirSync(dirname(legacyPath), { recursive: true });
	writeFileSync(legacyPath, JSON.stringify({ githubClone: legacy }));
	assert.equal(existsSync(primaryPath), false);
	assert.deepEqual(await loadGitHubConfig(), legacy);

	const primary = {
		enabled: true,
		maxRepoSizeMB: 91,
		cloneTimeoutSeconds: 25,
		clonePath: join(home, "primary-clones"),
	};
	mkdirSync(dirname(primaryPath), { recursive: true });
	writeFileSync(primaryPath, JSON.stringify({ githubClone: primary }));
	assert.deepEqual(await loadGitHubConfig(), legacy);
	resetGitHubConfig();
	assert.deepEqual(await loadGitHubConfig(), primary);

	rmSync(primaryPath);
	resetGitHubConfig();
	assert.deepEqual(await loadGitHubConfig(), legacy);

	writeFileSync(legacyPath, "{ invalid JSON");
	resetGitHubConfig();
	await assert.rejects(
		loadGitHubConfig,
		(error: unknown) => error instanceof Error && error.message.startsWith(`Failed to parse ${legacyPath}: `),
	);
});
