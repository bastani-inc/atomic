import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { rootKey } from "../src/core/resume/blueprint/ledger.ts";
import { restoredWorktreeOf } from "../src/core/resume/blueprint/resume.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	BLUEPRINT_CONTEXT_TYPE,
	type BlueprintBuildConfig,
	isBlueprintBuildFailedError,
	recordRestoredWorktreeContext,
	setUpResumedBlueprints,
} from "../src/index.ts";
import { forThisHost } from "./helpers/blueprint-fixtures.ts";

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-root-context-")));
});
afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);
const storeDir = () => path("agent", "worktree-snapshots");
const contextPath = (root: string) => join(storeDir(), "blueprint-context", `${rootKey(root)}.md`);

function write(file: string, content: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
}

function worktree(name: string, blueprint?: string): string {
	const root = join(storeDir(), "worktrees", name);
	mkdirSync(root, { recursive: true });
	if (blueprint !== undefined) write(join(root, ".atomic", "blueprint.yaml"), forThisHost(blueprint));
	return root;
}

function config(overrides: Partial<BlueprintBuildConfig> = {}): BlueprintBuildConfig {
	return {
		agentDir: path("agent"),
		storeDir: storeDir(),
		trusted: () => true,
		homeDir: sandbox,
		environment: { PATH: process.env.PATH ?? "" },
		...overrides,
	};
}

const knowledge = (contents: string) => `knowledge:\n  - name: test\n    contents: ${contents}\n`;

describe("restoredWorktreeOf (#4588)", () => {
	const store = resolve(sep, "store");
	const worktrees = join(store, "worktrees");

	test("names the restored worktree that holds a directory, whatever its depth (#4588)", () => {
		assert.equal(restoredWorktreeOf(store, join(worktrees, "abc")), join(worktrees, "abc"));
		assert.equal(restoredWorktreeOf(store, join(worktrees, "abc", "packages", "app")), join(worktrees, "abc"));
		assert.equal(restoredWorktreeOf(store, join(worktrees, "..hidden", "src")), join(worktrees, "..hidden"));
	});

	test("names nothing for the worktrees directory itself or anything outside it (#4588)", () => {
		assert.equal(restoredWorktreeOf(store, worktrees), undefined);
		assert.equal(restoredWorktreeOf(store, store), undefined);
		assert.equal(restoredWorktreeOf(store, join(store, "worktrees-other", "abc")), undefined);
		assert.equal(restoredWorktreeOf(store, join(store, "repositories", "abc")), undefined);
		assert.equal(restoredWorktreeOf(store, join(sep, "elsewhere", "abc")), undefined);
		assert.equal(restoredWorktreeOf(store, join(worktrees, "..")), undefined);
	});
});

describe("the blueprint context kept for later sessions (#4588)", () => {
	test("each build keeps one context per restored worktree: the global blueprint's and that worktree's own (#4588)", async () => {
		write(path("agent", "blueprint.yaml"), forThisHost(knowledge("global-fact")));
		const first = worktree("one", knowledge("first-fact"));
		const second = worktree("two", knowledge("second-fact"));
		await setUpResumedBlueprints({
			restored: [
				{ root: first, remotes: ["https://example.test/one.git"] },
				{ root: second, remotes: ["https://example.test/two.git"] },
			],
			config: config(),
		});

		const kept = readFileSync(contextPath(first), "utf8");
		assert.ok(kept.includes("global-fact"));
		assert.ok(kept.includes("first-fact"));
		assert.ok(!kept.includes("second-fact"));
		const other = readFileSync(contextPath(second), "utf8");
		assert.ok(other.includes("global-fact") && other.includes("second-fact") && !other.includes("first-fact"));
		if (process.platform !== "win32") assert.equal(statSync(contextPath(first)).mode & 0o777, 0o600);
	});

	test("a worktree that no longer has anything to say loses its kept context (#4588)", async () => {
		const root = worktree("one", knowledge("first-fact"));
		await setUpResumedBlueprints({ restored: [{ root, remotes: [] }], config: config() });
		assert.equal(existsSync(contextPath(root)), true);
		rmSync(join(root, ".atomic"), { recursive: true });
		await setUpResumedBlueprints({ restored: [{ root, remotes: [] }], config: config() });
		assert.equal(existsSync(contextPath(root)), false);
	});

	test("a context that cannot be kept is one warning and never costs the session its own context (#4588)", async () => {
		const root = worktree("one", knowledge("first-fact"));
		write(join(storeDir(), "blueprint-context"), "a file where the directory should be");
		const resumed = await setUpResumedBlueprints({ restored: [{ root, remotes: [] }], config: config() });
		assert.equal(resumed.notices.length, 1);
		assert.equal(resumed.notices[0]?.type, "warning");
		assert.match(
			resumed.notices[0]?.message ?? "",
			/^The blueprint context could not be kept for later sessions in these worktrees: .+\.$/,
		);
		assert.ok(resumed.context?.includes("first-fact"));
	});

	test("a session that starts inside a restored worktree is told its context once (#4588)", async () => {
		const root = worktree("one", `initialize: exit 7\n${knowledge("first-fact")}`);
		await setUpResumedBlueprints({ restored: [{ root, remotes: [] }], config: config() });
		const manager = SessionManager.inMemory(join(root, "packages"));
		const contextsOf = () =>
			manager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === BLUEPRINT_CONTEXT_TYPE);

		await recordRestoredWorktreeContext(manager, storeDir(), join(root, "packages", "app"));
		await recordRestoredWorktreeContext(manager, storeDir(), join(root, "packages", "app"));
		const [entry] = contextsOf();
		assert.equal(contextsOf().length, 1);
		assert.equal(entry?.type === "custom_message" && entry.content, readFileSync(contextPath(root), "utf8"));
		assert.equal(entry?.type === "custom_message" && entry.display, false);
	});

	test("a directory outside the restored worktrees, or a worktree with no kept context, adds nothing (#4588)", async () => {
		const root = worktree("one");
		const manager = SessionManager.inMemory(root);
		assert.equal(await recordRestoredWorktreeContext(manager, storeDir(), root), undefined);
		assert.equal(await recordRestoredWorktreeContext(manager, storeDir(), sandbox), undefined);
		assert.equal(manager.getBranch().filter((entry) => entry.type === "custom_message").length, 0);
	});

	test("a kept context that cannot be read is returned as a typed failure and the session starts without it (#4588)", async () => {
		const root = worktree("one");
		mkdirSync(contextPath(root), { recursive: true });
		const manager = SessionManager.inMemory(root);
		const failure = await recordRestoredWorktreeContext(manager, storeDir(), root);
		assert.ok(isBlueprintBuildFailedError(failure));
		assert.equal(failure.phase, "environment");
		assert.equal((failure.cause as NodeJS.ErrnoException).code, "EISDIR");
		assert.equal(manager.getBranch().filter((entry) => entry.type === "custom_message").length, 0);
	});
});

describe("setting up resumed blueprints never rejects except for cancellation (#4588)", () => {
	test("an unexpected failure is one warning that says the session resumed anyway, with nothing else (#4588)", async () => {
		const resumed = await setUpResumedBlueprints({ restored: [{ root: "/x" } as never], config: config() });
		assert.equal(resumed.outcome, undefined);
		assert.deepEqual(resumed.layers, []);
		assert.equal(resumed.context, undefined);
		assert.equal(resumed.notices.length, 1);
		assert.equal(resumed.notices[0]?.type, "warning");
		assert.match(
			resumed.notices[0]?.message ?? "",
			/^Blueprint setup stopped unexpectedly: .+\. The session resumed anyway\.$/,
		);
	});

	test("cancellation rejects with the signal's reason (#4588)", async () => {
		const stop = new Error("stop the resume");
		await assert.rejects(
			setUpResumedBlueprints({
				restored: [{ root: worktree("one", knowledge("x")), remotes: [] }],
				config: config(),
				signal: AbortSignal.abort(stop),
			}),
			(error: unknown) => error === stop,
		);
	});
});

describe("blueprints the build cannot read (#4588)", () => {
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a repository whose .atomic directory cannot be entered is a Partial failure that names the unreadable blueprint (#4588)",
		async () => {
			const root = worktree("one", "maintenance: echo ok\n");
			chmodSync(join(root, ".atomic"), 0o000);
			try {
				const resumed = await setUpResumedBlueprints({ restored: [{ root, remotes: [] }], config: config() });
				assert.equal(resumed.outcome?.status, "partial");
				assert.equal(resumed.notices.length, 1);
				assert.match(resumed.notices[0]?.message ?? "", /^Partial build: .*could not be read/);
			} finally {
				chmodSync(join(root, ".atomic"), 0o700);
			}
		},
	);
});
