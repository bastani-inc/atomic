import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const existenceProbes = vi.hoisted(() => vi.fn<typeof import("node:fs").existsSync>());
vi.mock("node:fs", async (original) => {
	const filesystem = await original<typeof import("node:fs")>();
	return { ...filesystem, existsSync: existenceProbes.mockImplementation(filesystem.existsSync) };
});
vi.resetModules();

const { resetStorageHomeCacheForTests, storageHomeDir } = await import(
	"../../packages/coding-agent/src/core/storage/file-identity.js"
);
const { adapterOpenContext, secretFilePath } = await import("../../packages/coding-agent/src/core/storage/provider.js");

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-secret-paths-");
	resetStorageHomeCacheForTests();
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("USERPROFILE", join(root, "home"));
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
	])
		vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

test.each(["default", "adopted"])(
	"relative secret paths in the %s home need no existence probes when primary and legacy paths coincide (#5242)",
	(layout) => {
		const home = layout === "default" ? join(root, "home", ".atomic") : join(root, "legacy");
		const agent = join(home, "agent");
		mkdirSync(agent, { recursive: true });
		if (layout === "adopted") {
			mkdirSync(join(home, "workflows"));
			writeFileSync(join(home, "workflows", "journal.sqlite"), "");
		}
		assert.equal(storageHomeDir(agent, {}), home);
		for (const file of ["absent", "present"]) {
			if (file === "present") writeFileSync(join(home, file), "fixture");
			secretFilePath(file, agent);
			existenceProbes.mockClear();
			assert.equal(secretFilePath(file, agent), join(home, file));
			assert.deepEqual(existenceProbes.mock.calls, []);
		}
	},
);

test("isolated secret paths skip primary probes without a legacy candidate and observe live file creation, priority, replacement, and deletion (#5242)", async () => {
	const agent = join(root, "isolated", "agent");
	mkdirSync(agent, { recursive: true });
	assert.equal(storageHomeDir(agent, {}), agent);
	const file = "keys/token";
	const primary = join(agent, file);
	const legacy = join(dirname(agent), file);
	const context = adapterOpenContext(
		{ kind: "adapter", module: "fixture", secrets: { token: { file } } },
		{ agentDir: agent, domain: "sessions" },
	);
	assert.ok(context.secret);
	secretFilePath(file, agent);
	existenceProbes.mockClear();
	assert.equal(secretFilePath(file, agent), primary);
	assert.deepEqual(existenceProbes.mock.calls, [[legacy]]);

	mkdirSync(dirname(legacy), { recursive: true });
	writeFileSync(legacy, "legacy-first");
	assert.equal(secretFilePath(file, agent), legacy);
	assert.equal(await context.secret("token"), "legacy-first");

	mkdirSync(dirname(primary), { recursive: true });
	writeFileSync(primary, "primary-first");
	assert.equal(secretFilePath(file, agent), primary);
	assert.equal(await context.secret("token"), "primary-first");
	const replacement = join(root, "replacement");
	writeFileSync(replacement, "primary-replaced");
	renameSync(replacement, primary);
	assert.equal(await context.secret("token"), "primary-replaced");

	rmSync(primary);
	assert.equal(secretFilePath(file, agent), legacy);
	writeFileSync(legacy, "legacy-replaced");
	assert.equal(await context.secret("token"), "legacy-replaced");
	rmSync(legacy);
	assert.equal(secretFilePath(file, agent), primary);
	await assert.rejects(context.secret("token"));
});

test("managed legacy token paths remain selected while missing without hiding a live primary file (#5242)", () => {
	const agent = join(root, "managed", "agent");
	mkdirSync(agent, { recursive: true });
	assert.equal(storageHomeDir(agent, {}), agent);
	const file = "agent/storage-token.fixture";
	const primary = join(agent, file);
	const legacy = join(dirname(agent), file);
	assert.equal(secretFilePath(file, agent), legacy);
	mkdirSync(dirname(primary), { recursive: true });
	writeFileSync(primary, "primary");
	assert.equal(secretFilePath(file, agent), primary);
	writeFileSync(legacy, "legacy");
	assert.equal(secretFilePath(file, agent), primary);
	rmSync(primary);
	assert.equal(secretFilePath(file, agent), legacy);
	rmSync(legacy);
	assert.equal(secretFilePath(file, agent), legacy);
});

test("secret path arithmetic follows a settings-aware home that replaces a provisional home (#5242)", () => {
	const parent = join(root, "provisional");
	const agent = join(parent, "agent");
	mkdirSync(agent, { recursive: true });
	assert.equal(secretFilePath("token", agent), join(agent, "token"));
	mkdirSync(join(parent, "workflows"));
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	assert.equal(storageHomeDir(agent, {}), parent);
	assert.equal(secretFilePath("token", agent), join(parent, "token"));
});

test.each(["cwd", "agent spelling"])(
	"secret path arithmetic keeps lexical legacy parents distinct when %s changes (#5242)",
	(input) => {
		const home = join(root, "home", ".atomic");
		const canonical = join(home, "agent");
		mkdirSync(canonical, { recursive: true });
		assert.equal(storageHomeDir(canonical, {}), home);
		const previousCwd = process.cwd();
		try {
			for (const name of ["first", "second"]) {
				const cwd = join(root, name);
				mkdirSync(cwd);
				const alias = join(cwd, "agent");
				symlinkSync(canonical, alias, "junction");
				writeFileSync(join(cwd, "token"), name);
				if (input === "cwd") process.chdir(cwd);
				const agent = input === "cwd" ? "agent" : alias;
				assert.equal(storageHomeDir(agent), home);
				assert.equal(secretFilePath("token", agent), join(cwd, "token"));
			}
		} finally {
			process.chdir(previousCwd);
		}
	},
);
