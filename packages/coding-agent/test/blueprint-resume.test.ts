import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import type { BlueprintBuildConfig } from "../src/core/resume/blueprint/build.ts";
import { rootKey, updateLedger } from "../src/core/resume/blueprint/ledger.ts";
import {
	type BlueprintCheckout,
	blueprintRepository,
	checkoutsNeedingRebuild,
	enclosingRepositoryRoot,
	inheritedRemotes,
	recordBlueprintContext,
	setUpResumedBlueprints,
} from "../src/core/resume/blueprint/resume.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import {
	BLUEPRINT_CONTEXT_TYPE,
	continueSessionWhereItWorked,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
	SETUP_COMMAND_ALIAS,
} from "../src/index.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(name: string): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path(`${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

async function recordSession(root: string, cwd = root): Promise<SessionManager> {
	const store = await sqlStore("sessions");
	const manager = await SessionManager.create(store, cwd);
	await manager.appendMessage({ role: "user", content: "work on it", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
	return manager;
}

const markers = () => sandbox.path("markers.txt");
const mark = (label: string) => `echo "${label} $(pwd -P)" >> "${markers().replaceAll("\\", "/")}"`;
const ran = () => (existsSync(markers()) ? readFileSync(markers(), "utf8").trim().split("\n") : []);

function options(overrides: Partial<PrepareSessionResumeOptions["blueprint"]> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprint: {
			agentDir: sandbox.path("agent"),
			trusted: () => true,
			homeDir: sandbox.path("home"),
			environment: { PATH: process.env.PATH ?? "", HOME: sandbox.path("home") },
			...overrides,
		},
	};
}

function ready(prepared: PreparedSessionResume) {
	assert.equal(prepared.status, "ready");
	if (prepared.status !== "ready") throw new Error("unreachable");
	return prepared;
}

function contexts(manager: SessionManager): string[] {
	return manager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom_message" &&
			entry.customType === BLUEPRINT_CONTEXT_TYPE &&
			typeof entry.content === "string"
				? [entry.content]
				: [],
		);
}

/** A clone with a blueprint, recorded by a session and then gone from "node A", so a resume restores it. */
async function recordedProject(blueprint: string | undefined, extra: Record<string, string> = {}) {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
	if (blueprint !== undefined) sandbox.write(join(clone, ".atomic", "blueprint.yaml"), blueprint);
	for (const [file, content] of Object.entries(extra)) sandbox.write(join(clone, file), content);
	const manager = await recordSession(clone);
	renameSync(clone, sandbox.path("node-a-gone"));
	return { clone, manager };
}

describe("resuming a session builds its blueprints and never fails on them (#4588)", () => {
	test("a failing initialize step still resumes the session as Partial, skips that maintenance, builds the other workspaces and forces a Rebuild next time (#4588)", async () => {
		const { manager } = await recordedProject(
			[
				"includes: [services/api]",
				"initialize:",
				"  - name: Install toolchain",
				"    run: |",
				'      echo "compiler missing" >&2',
				"      exit 7",
				`maintenance: ${mark("root-maintenance")}`,
				"knowledge:",
				"  - name: test",
				"    contents: npm test",
				"",
			].join("\n"),
			{ "services/api/.atomic/blueprint.yaml": `maintenance: ${mark("api-maintenance")}\n` },
		);

		const prepared = ready(await prepareSessionResume(manager, options()));

		const restoredRoot = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.equal(prepared.sessionManager.getCwd(), restoredRoot);
		assert.ok(restoredRoot.startsWith(sandbox.path("host")));
		assert.equal(readFileSync(join(restoredRoot, "README.md"), "utf8"), "hello\n");
		assert.deepEqual(ran(), [`api-maintenance ${join(restoredRoot, "services", "api")}`]);
		assert.equal(prepared.blueprintNotices.length, 1);
		const [warning] = prepared.blueprintNotices;
		assert.equal(warning?.type, "warning");
		assert.match(warning?.message ?? "", /^Partial build: /);
		assert.ok((warning?.message ?? "").includes("Install toolchain"));
		assert.ok((warning?.message ?? "").includes(join(restoredRoot, ".atomic", "blueprint.yaml")));
		assert.ok(
			prepared.notices.some(
				(notice) => notice.type === "info" && /^Restored worktree snapshot/.test(notice.message),
			),
		);
		assert.ok(prepared.notices.includes(warning!));

		const [context] = contexts(prepared.sessionManager);
		assert.equal(context, prepared.blueprintContext);
		assert.match(context ?? "", /NOT RUN: the build of this blueprint failed before its maintenance/);
		assert.match(context ?? "", /compiler missing/);
		assert.match(context ?? "", /root-maintenance/);
		assert.match(context ?? "", /npm test/);

		writeFileSync(
			join(restoredRoot, ".atomic", "blueprint.yaml"),
			`includes: [services/api]\ninitialize: ${mark("root-initialize")}\nmaintenance: ${mark("root-maintenance")}\n`,
		);
		const resumedAgain = await continueSessionWhereItWorked(prepared.sessionManager, options());
		assert.deepEqual(ran(), [
			`api-maintenance ${join(restoredRoot, "services", "api")}`,
			`root-initialize ${restoredRoot}`,
			`root-maintenance ${restoredRoot}`,
			`api-maintenance ${join(restoredRoot, "services", "api")}`,
		]);
		const [, relabelled] = contexts(resumedAgain);
		assert.match(relabelled ?? "", /ran during this resume's build/);
		assert.doesNotMatch(relabelled ?? "", /compiler missing/);

		await continueSessionWhereItWorked(resumedAgain, options());
		assert.equal(ran().length, 4);
	});

	test("a failing global initialize and a failing post-build still resume with prominent warnings (#4588)", async () => {
		const { manager } = await recordedProject(`maintenance: ${mark("repo")}\n`);
		const failingGlobal = options();
		const agentBlueprint = join(sandbox.path("agent"), "blueprint.yaml");
		sandbox.write(agentBlueprint, "initialize:\n  - name: Install global tools\n    run: exit 2\n");
		const prepared = ready(await prepareSessionResume(manager, failingGlobal));
		assert.equal(prepared.sessionManager.getCwd(), manager.getWorktreeRootMappings().at(-1)!.to);
		assert.equal(prepared.blueprintNotices.length, 1);
		assert.match(prepared.blueprintNotices[0]?.message ?? "", /^Blueprint build FAILED: /);
		assert.match(prepared.blueprintNotices[0]?.message ?? "", /Install global tools/);
		assert.deepEqual(ran(), []);
	});

	test("an untrusted worktree executes nothing and shows the user nothing, but the agent gets the context (#4588)", async () => {
		const { manager } = await recordedProject(
			`initialize: ${mark("init")}\nmaintenance: npm ci\nknowledge:\n  - name: lint\n    contents: npm run lint\n`,
		);
		const prepared = ready(await prepareSessionResume(manager, options({ trusted: () => false })));
		assert.deepEqual(ran(), []);
		assert.deepEqual(prepared.blueprintNotices, []);
		assert.deepEqual(
			prepared.notices.map((notice) => notice.type),
			["info"],
		);
		assert.match(prepared.blueprintContext ?? "", /NOT YET RUN on this machine: the project is not trusted/);
		assert.match(prepared.blueprintContext ?? "", /npm ci/);
		assert.match(prepared.blueprintContext ?? "", /npm run lint/);
		assert.equal(existsSync(sandbox.path("host", "blueprint-builds")), false);
	});

	test("a project without a blueprint resumes with no notice and no context (#4588)", async () => {
		const { manager } = await recordedProject(undefined);
		const prepared = ready(await prepareSessionResume(manager, options()));
		assert.deepEqual(prepared.blueprintNotices, []);
		assert.equal(prepared.blueprintContext, undefined);
		assert.deepEqual(contexts(prepared.sessionManager), []);
		assert.deepEqual(
			prepared.notices.map((notice) => notice.type),
			["info"],
		);
	});

	test("setup never blocks a resume: no trusted setup, no setupCommand, dependency inputs present (#4588)", async () => {
		const { manager } = await recordedProject(undefined);
		const prepared = ready(await prepareSessionResume(manager, options({ trusted: () => false })));
		assert.equal(prepared.sessionManager.getCwd(), manager.getWorktreeRootMappings().at(-1)!.to);
	});

	test("the deprecated resume.setupCommand runs in the restored root and earns a deprecation notice (#4588)", async () => {
		const { manager } = await recordedProject(undefined);
		const prepared = ready(await prepareSessionResume(manager, options({ setupCommand: mark(SETUP_COMMAND_ALIAS) })));
		const restoredRoot = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.deepEqual(ran(), [`${SETUP_COMMAND_ALIAS} ${restoredRoot}`]);
		assert.match(
			prepared.blueprintNotices[0]?.message ?? "",
			/^Deprecation warning: resume\.setupCommand is deprecated/,
		);
		assert.equal(prepared.blueprintNotices.length, 1);
	});

	test("a checkout used as it is is only described to the agent, and nothing runs in it (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("inplace", { "README.md": "hello\n" });
		sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			`maintenance: ${mark("never")}\nknowledge:\n  - name: test\n    contents: make test\n`,
		);
		const manager = await recordSession(clone);
		const prepared = ready(await prepareSessionResume(manager, { ...options(), launchCwd: clone }));
		assert.deepEqual(ran(), []);
		assert.deepEqual(prepared.blueprintNotices, []);
		assert.match(prepared.blueprintContext ?? "", /NOT YET RUN on this machine: this checkout is used as it is/);
		assert.match(prepared.blueprintContext ?? "", /make test/);
		assert.equal(contexts(prepared.sessionManager).length, 1);
	});

	test("a matching checkout the resume continues in is described, never built, and creates no store (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("moved", { "README.md": "hello\n" });
		sandbox.write(
			join(clone, ".atomic", "blueprint.yaml"),
			`maintenance: ${mark("never")}\nknowledge:\n  - name: test\n    contents: make test\n`,
		);
		const manager = await recordSession(clone);
		const checkout = sandbox.path("node-b", "moved");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		const prepared = ready(
			await prepareSessionResume(manager, {
				...options({ setupCommand: mark(SETUP_COMMAND_ALIAS) }),
				launchCwd: checkout,
			}),
		);
		assert.equal(prepared.sessionManager.getCwd(), checkout);
		assert.deepEqual(ran(), []);
		assert.deepEqual(prepared.blueprintNotices, []);
		assert.match(prepared.blueprintContext ?? "", /NOT YET RUN on this machine: this checkout is used as it is/);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("resuming again before anything changed adds no duplicate context (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("inplace", { "README.md": "hello\n" });
		sandbox.write(join(clone, ".atomic", "blueprint.yaml"), "knowledge:\n  - name: test\n    contents: make test\n");
		const manager = await recordSession(clone);
		await prepareSessionResume(manager, { ...options(), launchCwd: clone });
		await prepareSessionResume(manager, { ...options(), launchCwd: clone });
		assert.equal(contexts(manager).length, 1);
	});

	test("a session with no snapshots still gets its repository's and the global blueprint's context (#4588)", async () => {
		const { clone } = await sandbox.remoteWithClone("plain", { "README.md": "hello\n" });
		sandbox.write(join(clone, ".atomic", "blueprint.yaml"), "knowledge:\n  - name: test\n    contents: make test\n");
		sandbox.write(join(sandbox.path("agent"), "blueprint.yaml"), "maintenance: echo global\n");
		const store = await sqlStore("plain-sessions");
		const manager = await SessionManager.create(store, join(clone));
		await manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const prepared = ready(await prepareSessionResume(manager, { ...options(), launchCwd: clone }));
		assert.deepEqual(ran(), []);
		assert.match(prepared.blueprintContext ?? "", /scope: global/);
		assert.match(prepared.blueprintContext ?? "", /make test/);
		assert.equal(contexts(manager).length, 1);
	});
});

function buildConfig(overrides: Partial<BlueprintBuildConfig> = {}): BlueprintBuildConfig {
	mkdirSync(sandbox.path("home"), { recursive: true });
	return {
		agentDir: sandbox.path("agent"),
		storeDir: sandbox.path("host"),
		trusted: () => true,
		platform: "linux",
		homeDir: sandbox.path("home"),
		environment: { PATH: process.env.PATH ?? "", HOME: sandbox.path("home") },
		...overrides,
	};
}

function checkout(name: string, blueprintText?: string, remotes: readonly string[] = []): BlueprintCheckout {
	const root = sandbox.path("checkouts", name);
	mkdirSync(root, { recursive: true });
	if (blueprintText !== undefined) sandbox.write(join(root, ".atomic", "blueprint.yaml"), blueprintText);
	return { root, remotes };
}

const layerStates = (layers: readonly { scope: string; state: unknown }[]) =>
	layers.map((layer) => [layer.scope, layer.state]);

describe("the repository a checkout belongs to (#4588)", () => {
	test("its identity is its sorted remotes joined by newlines, else its own root, and the remotes are left as they were (#4588)", () => {
		assert.deepEqual(blueprintRepository({ root: "/work/repo", remotes: [] }), {
			root: "/work/repo",
			identity: "/work/repo",
		});
		const remotes = ["https://b.example/x.git", "https://a.example/x.git"];
		assert.deepEqual(blueprintRepository({ root: "/work/repo", remotes }), {
			root: "/work/repo",
			identity: "https://a.example/x.git\nhttps://b.example/x.git",
		});
		assert.deepEqual(remotes, ["https://b.example/x.git", "https://a.example/x.git"]);
		assert.equal(blueprintRepository({ root: "/work/repo", remotes: ["only"] }).identity, "only");
	});
});

describe("setting up the blueprints of a resume (#4588)", () => {
	const globalKnowledge = "knowledge:\n  - name: tip\n    contents: be kind\n";

	test("with nothing restored the global blueprint is described once as skipped, with or without empty lists (#4588)", async () => {
		sandbox.write(sandbox.path("agent", "blueprint.yaml"), globalKnowledge);
		for (const lists of [{}, { inPlace: [], earlier: [] }]) {
			const result = await setUpResumedBlueprints({ restored: [], config: buildConfig(), ...lists });
			assert.equal(result.outcome, undefined);
			assert.deepEqual(result.notices, []);
			assert.deepEqual(layerStates(result.layers), [["global", { kind: "not-run", reason: "skipped" }]]);
			assert.match(result.context ?? "", /be kind/);
		}
	});

	test("with nothing at all to describe there is no layer and no context (#4588)", async () => {
		const result = await setUpResumedBlueprints({ restored: [], config: buildConfig() });
		assert.deepEqual([result.outcome, result.notices, result.layers, result.context], [undefined, [], [], undefined]);
	});

	test("checkouts used as they are and earlier ones are described in that order, with the global blueprint once and first (#4588)", async () => {
		sandbox.write(sandbox.path("agent", "blueprint.yaml"), globalKnowledge);
		const inPlace = checkout("in-place", "maintenance: echo in-place\n");
		const earlier = checkout("earlier", "maintenance: echo earlier\n");
		const result = await setUpResumedBlueprints({
			restored: [],
			inPlace: [inPlace],
			earlier: [earlier],
			config: buildConfig(),
		});
		assert.equal(result.outcome, undefined);
		assert.deepEqual(
			result.layers.map((layer) => [layer.scope, layer.root, layer.state]),
			[
				["global", null, { kind: "not-run", reason: "in-place" }],
				["repository", inPlace.root, { kind: "not-run", reason: "in-place" }],
				["repository", earlier.root, { kind: "not-run", reason: "earlier" }],
			],
		);
		const onlyEarlier = await setUpResumedBlueprints({ restored: [], earlier: [earlier], config: buildConfig() });
		assert.deepEqual(layerStates(onlyEarlier.layers), [
			["global", { kind: "not-run", reason: "earlier" }],
			["repository", { kind: "not-run", reason: "earlier" }],
		]);
	});

	test("a checkout without a blueprint of its own adds no second global layer, before or after a build (#4588)", async () => {
		sandbox.write(sandbox.path("agent", "blueprint.yaml"), "maintenance: echo global\n");
		const bare = checkout("bare");
		const described = await setUpResumedBlueprints({ restored: [], inPlace: [bare], config: buildConfig() });
		assert.deepEqual(layerStates(described.layers), [["global", { kind: "not-run", reason: "in-place" }]]);
		const built = await setUpResumedBlueprints({ restored: [bare], inPlace: [bare], config: buildConfig() });
		assert.deepEqual(layerStates(built.layers), [["global", { kind: "built", action: "rebuild" }]]);
	});

	test("restored worktrees are built, and the checkouts described after them add no second global layer (#4588)", async () => {
		sandbox.write(sandbox.path("agent", "blueprint.yaml"), "maintenance: echo global\n");
		const restored = checkout("restored", "maintenance: echo restored\n");
		const inPlace = checkout("in-place-after", "maintenance: echo in-place\n");
		const result = await setUpResumedBlueprints({
			restored: [restored],
			inPlace: [inPlace],
			config: buildConfig(),
		});
		assert.equal(result.outcome?.status, "success");
		assert.deepEqual(result.notices, []);
		assert.deepEqual(
			result.layers.map((layer) => [layer.scope, layer.root, layer.state]),
			[
				["global", null, { kind: "built", action: "rebuild" }],
				["repository", restored.root, { kind: "built", action: "rebuild" }],
				["repository", inPlace.root, { kind: "not-run", reason: "in-place" }],
			],
		);
		assert.match(result.context ?? "", /echo in-place/);
	});

	test("the notices of a build come with it, and the deprecation notice only for a real setupCommand (#4588)", async () => {
		const failing = checkout("failing", "maintenance: exit 2\n");
		const failed = await setUpResumedBlueprints({ restored: [failing], config: buildConfig() });
		assert.deepEqual(
			failed.notices.map((notice) => [notice.type, notice.message.startsWith("Partial build: ")]),
			[["warning", true]],
		);
		const healthy = checkout("healthy", "maintenance: echo ok\n");
		const blank = await setUpResumedBlueprints({
			restored: [healthy],
			config: buildConfig({ setupCommand: "  \n " }),
		});
		assert.equal(blank.outcome?.status, "success");
		assert.deepEqual(blank.notices, []);
		const aliased = await setUpResumedBlueprints({
			restored: [healthy],
			config: buildConfig({ setupCommand: "echo alias" }),
		});
		assert.deepEqual(
			aliased.notices.map((notice) => notice.message.startsWith("Deprecation warning: resume.setupCommand")),
			[true],
		);
	});
});

describe("which restored worktrees are built again (#4588)", () => {
	test("those whose last build failed, never finished or left no record, in the order given (#4588)", async () => {
		const [failed, running, succeeded, unknown] = ["failed", "running", "succeeded", "unknown"].map((name) =>
			checkout(name),
		) as [BlueprintCheckout, BlueprintCheckout, BlueprintCheckout, BlueprintCheckout];
		assert.deepEqual(await checkoutsNeedingRebuild([failed, running], sandbox.path("host")), [failed, running]);
		await updateLedger(sandbox.path("host"), (ledger) => ({
			...ledger,
			roots: {
				[rootKey(failed.root)]: { state: "failed", at: "2026-11-09T00:00:00.000Z" },
				[rootKey(running.root)]: { state: "running", at: "2026-11-09T00:00:00.000Z" },
				[rootKey(succeeded.root)]: { state: "success", at: "2026-11-09T00:00:00.000Z" },
			},
		}));
		const rebuilt = await checkoutsNeedingRebuild([unknown, running, succeeded, failed], sandbox.path("host"));
		assert.deepEqual(rebuilt, [unknown, running, failed]);
		assert.equal(rebuilt[0], unknown);
	});
});

describe("recording the blueprint context in the session (#4588)", () => {
	async function newSession(): Promise<SessionManager> {
		return SessionManager.create(await sqlStore("recorded"), sandbox.root);
	}

	test("nothing is recorded for no context (#4588)", async () => {
		const manager = await newSession();
		await recordBlueprintContext(manager, undefined);
		assert.deepEqual(manager.getBranch(), []);
	});

	test("a context is a hidden custom message, and the same one is not recorded twice in a row (#4588)", async () => {
		const manager = await newSession();
		await recordBlueprintContext(manager, "context A");
		await recordBlueprintContext(manager, "context A");
		const [entry, ...others] = manager.getBranch();
		assert.equal(others.length, 0);
		assert.ok(entry?.type === "custom_message");
		assert.equal(entry.customType, BLUEPRINT_CONTEXT_TYPE);
		assert.equal(entry.content, "context A");
		assert.equal(entry.display, false);
	});

	test("a changed context is recorded, and only the latest context decides whether it is a repeat (#4588)", async () => {
		const manager = await newSession();
		for (const context of ["A", "B", "B", "A", "A"]) await recordBlueprintContext(manager, context);
		assert.deepEqual(contexts(manager), ["A", "B", "A"]);
	});

	test("messages and other custom entries in between do not make the context a new one (#4588)", async () => {
		const manager = await newSession();
		await recordBlueprintContext(manager, "context A");
		await manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await manager.appendCustomMessageEntry("another-extension", "something else", false);
		await manager.appendCustomEntry(BLUEPRINT_CONTEXT_TYPE, { unrelated: true });
		await recordBlueprintContext(manager, "context A");
		assert.deepEqual(contexts(manager), ["context A"]);
		await recordBlueprintContext(manager, "context B");
		assert.deepEqual(contexts(manager), ["context A", "context B"]);
	});
});

describe("finding the repository a directory is in (#4588)", () => {
	test("the nearest directory upward that has a .git, whether a directory or a file (#4588)", () => {
		mkdirSync(sandbox.path("outer", ".git"), { recursive: true });
		mkdirSync(sandbox.path("outer", "pkg", "src"), { recursive: true });
		sandbox.write(sandbox.path("outer", "linked", ".git"), "gitdir: elsewhere\n");
		mkdirSync(sandbox.path("outer", "linked", "deep", "er"), { recursive: true });
		assert.equal(enclosingRepositoryRoot(sandbox.path("outer")), sandbox.path("outer"));
		assert.equal(enclosingRepositoryRoot(sandbox.path("outer", "pkg", "src")), sandbox.path("outer"));
		assert.equal(
			enclosingRepositoryRoot(sandbox.path("outer", "linked", "deep", "er")),
			sandbox.path("outer", "linked"),
		);
	});

	test("a directory outside any repository, a filesystem root and a relative path end the search (#4588)", () => {
		mkdirSync(sandbox.path("plain", "a", "b"), { recursive: true });
		const found = enclosingRepositoryRoot(sandbox.path("plain", "a", "b"));
		assert.ok(found === undefined || !found.startsWith(sandbox.root));
		const root = parse(sandbox.root).root;
		assert.equal(enclosingRepositoryRoot(root), existsSync(join(root, ".git")) ? root : undefined);
		assert.equal(enclosingRepositoryRoot("."), existsSync(".git") ? "." : undefined);
	});
});

describe("the remotes that identify a repository across restores (#4588)", () => {
	const remotes = ["https://example.test/repo.git"];
	const snapshots = new Map([
		["s0", { remotes }],
		["s1", { remotes: [] as string[] }],
		["s2", { remotes: [] as string[] }],
	]);

	test("a checkout's own remotes win (#4588)", () => {
		assert.deepEqual(inheritedRemotes("/r1", ["https://own.test/x.git"], [], snapshots), ["https://own.test/x.git"]);
	});

	test("remotes are found by following the restores back to the first snapshot that has some (#4588)", () => {
		const restores = [
			{ from: "/r0", to: "/r1", snapshotId: "s0" },
			{ from: "/r1", to: "/r2", snapshotId: "s1" },
			{ from: "/r2", to: "/r3", snapshotId: "s2" },
		];
		assert.deepEqual(inheritedRemotes("/r1", [], restores, snapshots), remotes);
		assert.deepEqual(inheritedRemotes("/r2", [], restores, snapshots), remotes);
		assert.deepEqual(inheritedRemotes("/r3", [], restores, snapshots), remotes);
	});

	test("a checkout nothing was restored into, a missing snapshot and a chain without remotes give none (#4588)", () => {
		const restores = [
			{ from: "/r0", to: "/r1", snapshotId: "s1" },
			{ from: "/r1", to: "/r2", snapshotId: "gone" },
		];
		assert.deepEqual(inheritedRemotes("/elsewhere", [], restores, snapshots), []);
		assert.deepEqual(inheritedRemotes("/r1", [], restores, snapshots), []);
		assert.deepEqual(inheritedRemotes("/r2", [], restores, snapshots), []);
	});

	test("the newest restore into a path decides, and a cycle of restores ends instead of looping (#4588)", () => {
		const newest = [
			{ from: "/r0", to: "/r1", snapshotId: "s1" },
			{ from: "/r9", to: "/r1", snapshotId: "s0" },
		];
		assert.deepEqual(inheritedRemotes("/r1", [], newest, snapshots), remotes);
		const cycle = [
			{ from: "/a", to: "/b", snapshotId: "s1" },
			{ from: "/b", to: "/a", snapshotId: "s2" },
		];
		assert.deepEqual(inheritedRemotes("/a", [], cycle, snapshots), []);
	});

	test("paths are compared as resolved paths (#4588)", () => {
		const restores = [{ from: "/r0/", to: "/r1/./", snapshotId: "s0" }];
		assert.deepEqual(inheritedRemotes("/r1", [], restores, snapshots), remotes);
	});
});
