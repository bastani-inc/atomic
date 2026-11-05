import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { DEFAULT_GROUP, explicitHomeGroup, resolveHomeGroup } from "../../packages/intercom/group.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import {
	DEFAULT_GROUP_WARNING,
	gitInstallCommand,
	isProjectGroupError,
	multiNodeSelected,
	ProjectGroupError,
	projectGroup,
	projectHomeGroup,
	projectName,
	remoteRepositoryPath,
} from "../../packages/intercom/project-group.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));

let root: string;
let agentDir: string;

beforeEach(() => {
	root = realpathSync(makeTempDirectory("intercom-project-group-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("ATOMIC_INTERCOM_GROUP", "");
	vi.stubEnv("PI_INTERCOM_GROUP", "");
	vi.stubEnv("ATOMIC_STORAGE", "");
	vi.stubEnv("ATOMIC_PROFILE", "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", cwd, ...args], { env: createGitEnvironment(), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

function repository(name: string, origin?: string): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	git(directory, "init", "--quiet");
	if (origin !== undefined) git(directory, "remote", "add", "origin", origin);
	return directory;
}

function selectSharedStorage(): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: { adapter: "@example/team-db" } }));
}

describe("project groups (#4320)", () => {
	test("the repository path comes from any origin URL form, without credentials or .git (#4320)", () => {
		const cases: [string, string | undefined][] = [
			["https://github.com/acme/alpha.git", "acme/alpha"],
			["https://user:token@github.com/acme/alpha.git/", "acme/alpha"],
			["ssh://git@github.com:22/acme/alpha.git", "acme/alpha"],
			["git@github.com:acme/alpha.git", "acme/alpha"],
			["github.com:acme/alpha", "acme/alpha"],
			["https://gitlab.com/group/sub/alpha.git?ref=main#readme", "group/sub/alpha"],
			["/srv/git/alpha.git", "srv/git/alpha"],
			["./alpha", "alpha"],
			["  https://github.com/acme/alpha\n", "acme/alpha"],
			["https://github.com/", undefined],
			["https://github.com/.git", undefined],
			["https://[bad", undefined],
		];
		for (const [remote, expected] of cases) assert.equal(remoteRepositoryPath(remote), expected, remote);
	});

	test("a project is its origin's owner/repo, else its repository or directory name, cached per directory (#4320)", () => {
		const alpha = repository("alpha-clone", "git@github.com:acme/alpha.git");
		const subdirectory = join(alpha, "src", "deep");
		mkdirSync(subdirectory, { recursive: true });
		const env = createGitEnvironment();
		assert.equal(projectGroup(alpha, env), "project:acme/alpha");
		assert.equal(projectName(subdirectory, env), "acme/alpha");
		assert.equal(projectName(repository("no-origin"), env), "no-origin");
		const plain = join(root, "plain-directory");
		mkdirSync(plain);
		assert.equal(projectName(plain, env), "plain-directory");
		git(alpha, "remote", "set-url", "origin", "git@github.com:acme/renamed.git");
		assert.equal(projectName(alpha, env), "acme/alpha", "git runs once per directory per process");
	});

	test("Git runs at most twice per repository, never outside one, and a broken repository fails fast (#4320)", () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		const calls = join(root, "git-calls");
		const realGit = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
			.stdout.trim()
			.split(/\r?\n/)[0]!;
		const fakeGit = (body: string) => {
			if (process.platform === "win32") writeFileSync(join(bin, "git.cmd"), `@echo call>>"${calls}"\r\n${body}\r\n`);
			else writeFileSync(join(bin, "git"), `#!/bin/sh\necho call >> "${calls}"\n${body}\n`, { mode: 0o755 });
		};
		const counted = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split(/\r?\n/).length : 0);
		const env = { ...createGitEnvironment(), PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
		fakeGit(process.platform === "win32" ? `@"${realGit}" %*` : `exec "${realGit}" "$@"`);
		const alpha = repository("counted", "https://github.com/acme/counted.git");
		assert.equal(projectName(alpha, env), "acme/counted");
		assert.equal(projectName(alpha, env), "acme/counted");
		assert.equal(counted(), 2);
		const outside = join(root, "outside");
		mkdirSync(outside);
		assert.equal(projectName(outside, { PATH: "" }), "outside");
		assert.equal(counted(), 2);

		fakeGit(
			process.platform === "win32"
				? "@echo fatal: detected dubious ownership 1>&2\r\n@exit /b 128"
				: 'printf "\\n  fatal: detected dubious ownership\\nmore\\n" >&2\nexit 128',
		);
		const broken = repository("broken", "https://github.com/acme/broken.git");
		assert.throws(
			() => projectName(broken, env),
			(error: Error) => {
				assert.ok(isProjectGroupError(error));
				assert.deepEqual(
					[error.code, error.cwd, error.detail, error.retryable],
					["git-failed", broken, "fatal: detected dubious ownership", false],
				);
				assert.equal(
					error.message,
					`Git could not read this repository's origin for its Intercom project group: ${broken} (git-failed): fatal: detected dubious ownership. Run git -C ${broken} rev-parse --show-toplevel to see why and fix the repository, or set ATOMIC_INTERCOM_GROUP to choose this session's group.`,
				);
				return true;
			},
		);
		assert.equal(counted(), 3);

		const missing = repository("no-git-binary", "https://github.com/acme/missing.git");
		assert.throws(
			() => projectName(missing, { PATH: join(root, "empty-path") }),
			(error: Error) =>
				isProjectGroupError(error) &&
				error.code === "git-unavailable" &&
				error.hint.startsWith(`Install Git (${gitInstallCommand()})`) &&
				error.cause instanceof Error,
		);
		assert.equal(gitInstallCommand("win32"), "winget install --id Git.Git -e");
		assert.equal(gitInstallCommand("darwin"), "xcode-select --install");
		assert.match(gitInstallCommand("linux"), /^sudo apt-get install git/);
		assert.equal(isProjectGroupError({ name: "ProjectGroupError", code: "git-failed" }), true);
		assert.equal(isProjectGroupError({ name: "ProjectGroupError", code: "other" }), false);
		assert.equal(isProjectGroupError(null), false);
	});

	test("the project group applies only while multi-node routing is selected (#4320)", () => {
		const alpha = repository("alpha", "https://github.com/acme/alpha");
		const env = createGitEnvironment();
		assert.equal(multiNodeSelected(agentDir, { ATOMIC_STORAGE: "" }), false);
		assert.equal(projectHomeGroup(alpha, agentDir, { ATOMIC_STORAGE: "" }, env), undefined);
		assert.equal(projectHomeGroup(alpha, agentDir, { ATOMIC_STORAGE: '{"memory":true}' }, env), undefined);
		assert.equal(
			projectHomeGroup(alpha, agentDir, { ATOMIC_STORAGE: '{"adapter":"@example/team-db"}' }, env),
			"project:acme/alpha",
		);
		selectSharedStorage();
		assert.equal(multiNodeSelected(agentDir, { ATOMIC_STORAGE: "" }), true);
		assert.equal(projectHomeGroup(alpha, agentDir, { ATOMIC_STORAGE: "" }, env), "project:acme/alpha");
	});

	test("explicit groups still win over the project group, which is computed only when needed (#4320)", () => {
		let computed = 0;
		const fallback = () => {
			computed++;
			return "project:acme/alpha";
		};
		assert.equal(resolveHomeGroup({}, null, fallback), "project:acme/alpha");
		assert.equal(
			resolveHomeGroup({}, null, () => undefined),
			DEFAULT_GROUP,
		);
		assert.equal(resolveHomeGroup({}, null), DEFAULT_GROUP);
		assert.equal(resolveHomeGroup({ group: "config-group" }, null, fallback), "config-group");
		assert.equal(
			resolveHomeGroup({}, { orchestrationContext: { intercomGroup: "workflow:run" } }, fallback),
			"workflow:run",
		);
		assert.equal(resolveHomeGroup({}, { subagentPolicy: { intercomGroup: "child" } }, fallback), "child");
		vi.stubEnv("ATOMIC_INTERCOM_GROUP", " env-group ");
		assert.equal(resolveHomeGroup({ group: "config-group" }, null, fallback), "env-group");
		assert.equal(explicitHomeGroup({}, null), "env-group");
		vi.stubEnv("ATOMIC_INTERCOM_GROUP", "");
		assert.equal(explicitHomeGroup({}, null), undefined);
		assert.equal(computed, 1);
	});
});

type LifecycleHandler = (event: { type: string; reason: string }, ctx: ExtensionContext) => unknown;
type ToolResult = { isError: boolean; content: Array<{ text: string }>; details?: { group?: string } };
interface IntercomTool {
	name: string;
	execute(
		id: string,
		params: { action: string; group?: string },
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

function sessionContext(cwd: string, notices: string[]): ExtensionContext {
	return {
		hasUI: true,
		cwd,
		isIdle: () => true,
		ui: { notify: (message: string, level: string) => notices.push(`${level}: ${message}`), setStatus() {} },
		sessionManager: { getSessionId: () => "project-group-session", getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext;
}

function loadExtension() {
	const handlers = new Map<string, LifecycleHandler[]>();
	let intercomTool: IntercomTool | undefined;
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: IntercomTool) {
			if (tool.name === "intercom") intercomTool = tool;
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		getSessionName: () => undefined,
		events: createEventBus(),
	};
	intercomHeavy(pi as never);
	return {
		async fire(name: "session_start" | "session_shutdown", reason: string, ctx: ExtensionContext) {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason }, ctx);
		},
		run(params: { action: string; group?: string }, ctx: ExtensionContext): Promise<ToolResult> {
			assert.ok(intercomTool, "the intercom tool is registered");
			return intercomTool.execute(params.action, params, undefined, undefined, ctx);
		},
	};
}

function recordRegistrations(): string[][] {
	const registrations: string[][] = [];
	let memberships: string[] = [];
	vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async (registration) => {
		memberships = [...(registration.groups ?? [])];
		registrations.push([...memberships]);
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockReturnValue(true);
	vi.spyOn(IntercomClient.prototype, "joinGroup").mockImplementation(async (group) => {
		memberships = [...new Set([...memberships, group])];
		return [...memberships];
	});
	vi.spyOn(IntercomClient.prototype, "listSessions").mockResolvedValue([]);
	vi.spyOn(IntercomClient.prototype, "updatePresence").mockReturnValue(true);
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	return registrations;
}

describe("a session's home group (#4320)", () => {
	test("is the project group while multi-node routing is on, and default on one machine (#4320)", async () => {
		const alpha = repository("alpha", "https://github.com/acme/alpha.git");
		const registrations = recordRegistrations();
		const notices: string[] = [];
		const single = loadExtension();
		await single.fire("session_start", "startup", sessionContext(alpha, notices));
		await single.run({ action: "status" }, sessionContext(alpha, notices));
		await single.fire("session_shutdown", "quit", sessionContext(alpha, notices));

		selectSharedStorage();
		const shared = loadExtension();
		const ctx = sessionContext(alpha, notices);
		await shared.fire("session_start", "startup", ctx);
		await shared.run({ action: "status" }, ctx);
		const joined = await shared.run({ action: "join", group: "default" }, ctx);
		assert.equal(joined.isError, false, joined.content[0]?.text);
		assert.equal(
			joined.content[0]?.text,
			`Joined intercom group "default". Memberships: project:acme/alpha, default.\n${DEFAULT_GROUP_WARNING}`,
		);
		const other = await shared.run({ action: "join", group: "reviewers" }, ctx);
		assert.doesNotMatch(other.content[0]?.text ?? "", /Warning/);
		await shared.fire("session_shutdown", "quit", ctx);
		assert.deepEqual(registrations, [["default"], ["project:acme/alpha"]]);
		assert.deepEqual(notices, []);
	});

	test("an explicit group wins, and an explicit default warns once per session start (#4320)", async () => {
		const alpha = repository("alpha", "https://github.com/acme/alpha.git");
		selectSharedStorage();
		const registrations = recordRegistrations();
		const notices: string[] = [];
		vi.stubEnv("ATOMIC_INTERCOM_GROUP", "default");
		const extension = loadExtension();
		const ctx = sessionContext(alpha, notices);
		await extension.fire("session_start", "startup", ctx);
		await extension.run({ action: "status" }, ctx);
		await extension.fire("session_shutdown", "quit", ctx);
		vi.stubEnv("ATOMIC_INTERCOM_GROUP", "reviewers");
		const named = loadExtension();
		await named.fire("session_start", "startup", ctx);
		await named.run({ action: "status" }, ctx);
		await named.fire("session_shutdown", "quit", ctx);
		assert.deepEqual(registrations, [["default"], ["reviewers"]]);
		assert.deepEqual(notices, [`warning: ${DEFAULT_GROUP_WARNING}`]);
	});

	test("a running session keeps the home group it started with when its environment changes (#4320)", async () => {
		const alpha = repository("alpha", "https://github.com/acme/alpha.git");
		selectSharedStorage();
		recordRegistrations();
		const presence: string[][] = [];
		vi.spyOn(IntercomClient.prototype, "updatePresenceAcked").mockImplementation(async (updates) => {
			presence.push([...(updates.groups ?? [])]);
			return "ok";
		});
		vi.spyOn(IntercomClient.prototype, "groups", "get").mockImplementation(() => presence.at(-1) ?? []);
		const extension = loadExtension();
		const ctx = sessionContext(alpha, []);
		await extension.fire("session_start", "startup", ctx);
		await extension.run({ action: "join", group: "reviewers" }, ctx);
		vi.stubEnv("ATOMIC_INTERCOM_GROUP", "elsewhere");
		const left = await extension.run({ action: "leave" }, ctx);
		await extension.fire("session_shutdown", "quit", ctx);
		assert.equal(left.isError, false, left.content[0]?.text);
		assert.equal(left.details?.group, "project:acme/alpha");
		assert.deepEqual(presence, [["project:acme/alpha"]]);
	});
});

test("the default-group warning says who can address it (#4320)", () => {
	assert.equal(
		DEFAULT_GROUP_WARNING,
		'Warning: multi-node routing is on, so every teammate\'s sessions on the shared database can address the "default" group.',
	);
});

describe("joining a group directly (#4320)", () => {
	function tool(multiNodeRouting?: () => boolean) {
		const tools = new Map<string, IntercomTool>();
		const client = { joinGroup: async (group: string) => ["project:acme/alpha", group] };
		registerIntercomTool(
			{
				registerTool: (registered: IntercomTool) => tools.set(registered.name, registered),
				async appendEntry() {},
			} as never,
			{
				ensureConnected: async () => client,
				syncPresenceIdentity() {},
				beginReplyWait: () => ({}),
				confirmSend: false,
				homeGroup: () => "project:acme/alpha",
				setJoinedGroups() {},
				clearJoinedGroups() {},
				replyTracker: new ReplyTracker(),
				...(multiNodeRouting === undefined ? {} : { multiNodeRouting }),
			} as never,
		);
		return (group: string) =>
			tools.get("intercom")!.execute("join", { action: "join", group }, undefined, undefined, {
				sessionManager: { getSessionId: () => "s" },
				hasUI: false,
			} as never);
	}

	test("warns about default only while multi-node routing is on, and never without the dependency (#4320)", async () => {
		const plain = (group: string) => ({
			type: "text",
			text: `Joined intercom group "${group}". Memberships: project:acme/alpha, ${group}.`,
		});
		assert.deepEqual((await tool()("default")).content, [plain("default")]);
		assert.deepEqual((await tool(() => false)("default")).content, [plain("default")]);
		assert.deepEqual((await tool(() => true)("reviewers")).content, [plain("reviewers")]);
		assert.deepEqual((await tool(() => true)("default")).content, [
			{ type: "text", text: `${plain("default").text}\n${DEFAULT_GROUP_WARNING}` },
		]);
	});
});

test("remote URL forms that only differ in case, scheme characters or a .git inside the name (#4320)", () => {
	assert.equal(remoteRepositoryPath("HTTPS://GitHub.com/acme/alpha.git"), "acme/alpha");
	assert.equal(remoteRepositoryPath("git+ssh://git@github.com/acme/alpha.git"), "acme/alpha");
	assert.equal(remoteRepositoryPath("https://github.com/acme/site.github.io"), "acme/site.github.io");
	assert.equal(remoteRepositoryPath("https://github.com/acme/alpha.git.backup.git"), "acme/alpha.git.backup");
	assert.equal(remoteRepositoryPath("x https://host/acme/alpha"), "host/acme/alpha");
	assert.equal(remoteRepositoryPath("/srv/a:b/repo.git"), "srv/a:b/repo");
});

test("ProjectGroupError carries only the fields it was given and the guard checks name and code (#4320)", () => {
	const bare = new ProjectGroupError("git-failed", { cwd: "/repo", hint: "Fix it." });
	assert.equal(
		bare.message,
		"Git could not read this repository's origin for its Intercom project group: /repo (git-failed). Fix it.",
	);
	assert.equal(Object.hasOwn(bare, "detail"), false);
	assert.equal(Object.hasOwn(bare, "cause"), false);
	const cause = new Error("spawn git ENOENT");
	const full = new ProjectGroupError("git-unavailable", {
		cwd: "/repo",
		hint: "Install.",
		detail: "spawn git ENOENT",
		cause,
	});
	assert.equal(
		full.message,
		"Git is needed to name this repository's Intercom project group: /repo (git-unavailable): spawn git ENOENT. Install.",
	);
	assert.equal(full.cause, cause);
	assert.equal(isProjectGroupError(full), true);
	assert.equal(isProjectGroupError({ name: "ProjectGroupError", code: "git-unavailable" }), true);
	assert.equal(isProjectGroupError({ name: "Other", code: "git-failed" }), false);
	assert.equal(isProjectGroupError("ProjectGroupError"), false);
	assert.equal(isProjectGroupError(undefined), false);
});

test.skipIf(process.platform === "win32")("a failing origin lookup and a silent git failure are typed (#4320)", () => {
	const bin = join(root, "bin-origin");
	mkdirSync(bin);
	const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\ncase "$*" in *"remote get-url"*) echo "fatal: bad config" >&2; exit 1;; esac\nexec "${realGit}" "$@"\n`,
		{ mode: 0o755 },
	);
	const repo = repository("origin-fails", "https://github.com/acme/origin.git");
	const env = { ...createGitEnvironment(), PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
	assert.throws(
		() => projectName(repo, env),
		(error: Error) =>
			isProjectGroupError(error) &&
			error.code === "git-failed" &&
			error.detail === "fatal: bad config" &&
			error.hint ===
				`Run git -C ${repo} remote get-url origin to see why and fix the repository, or set ATOMIC_INTERCOM_GROUP to choose this session's group.`,
	);
	writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n", { mode: 0o755 });
	const silent = repository("silent-failure");
	assert.throws(
		() => projectName(silent, env),
		(error: Error) => isProjectGroupError(error) && error.detail === "git exited with status 128",
	);
});
