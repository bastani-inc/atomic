import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { recordBlueprintContext } from "../src/core/resume/blueprint/resume.ts";
import {
	BLUEPRINT_CONTEXT_TYPE,
	type BlueprintBuildConfig,
	type BlueprintDocument,
	type BlueprintFailure,
	type BlueprintLayer,
	type BlueprintLayerState,
	BlueprintStepFailedError,
	blueprintNotices,
	blueprintRepository,
	describeBlueprints,
	renderBlueprintContext,
	runBlueprintBuild,
	SETUP_COMMAND_ALIAS,
	setUpResumedBlueprints,
} from "../src/core/resume/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-context-")));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);

function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function config(overrides: Partial<BlueprintBuildConfig> = {}): BlueprintBuildConfig {
	mkdirSync(path("home"), { recursive: true });
	return {
		agentDir: path("agent"),
		storeDir: path("store"),
		trusted: () => true,
		platform: "linux",
		homeDir: path("home"),
		environment: { PATH: process.env.PATH ?? "", HOME: path("home") },
		...overrides,
	};
}

const repo = () => ({ root: path("repo"), remotes: ["https://example.test/repo.git"] });

const KNOWLEDGE =
	"knowledge:\n  - name: lint\n    contents: |\n      npm run lint\n  - name: test\n    contents: npm test\n";

describe("blueprint context for the agent (#4588)", () => {
	test("a project without blueprints adds nothing to the conversation (#4588)", async () => {
		mkdirSync(path("repo"), { recursive: true });
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		assert.equal(resumed.context, undefined);
		assert.deepEqual(resumed.notices, []);
		assert.equal(resumed.outcome?.status, "none");
	});

	test("a build that ran labels maintenance as run and lists knowledge (#4588)", async () => {
		write(
			path("repo", ".atomic", "blueprint.yaml"),
			`maintenance:\n  - name: Install deps\n    run: echo installing\n${KNOWLEDGE}`,
		);
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		const context = resumed.context ?? "";
		assert.match(context, /^<blueprint_context>/);
		assert.match(context, /Maintenance steps are NOT run automatically at session start/);
		assert.match(context, /state: ran during this resume's build \(initialize and maintenance\)/);
		assert.match(context, /1\. Install deps\n {5}echo installing/);
		assert.match(context, /lint:\n {4}npm run lint/);
		assert.match(context, /test:\n {4}npm test/);
	});

	test("an untrusted worktree's maintenance and knowledge are surfaced as not yet run, with nothing shown to the user (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), `maintenance: npm ci\n${KNOWLEDGE}`);
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config({ trusted: () => false }) });
		assert.match(resumed.context ?? "", /NOT YET RUN on this machine: the project is not trusted/);
		assert.match(resumed.context ?? "", /npm ci/);
		assert.match(resumed.context ?? "", /npm run lint/);
		assert.deepEqual(resumed.notices, []);
	});

	test("a checkout used in place is described as not built (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), `maintenance: npm install\n`);
		const resumed = await setUpResumedBlueprints({
			restored: [],
			inPlace: [{ root: path("repo"), remotes: [] }],
			config: config(),
		});
		assert.match(resumed.context ?? "", /NOT YET RUN on this machine: this checkout is used as it is/);
		assert.equal(resumed.outcome, undefined);
		assert.deepEqual(resumed.notices, []);
	});

	test("a worktree an earlier resume built is labelled as set up earlier (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), `maintenance: npm install\n`);
		const resumed = await setUpResumedBlueprints({
			restored: [],
			earlier: [{ root: path("repo"), remotes: [] }],
			config: config(),
		});
		assert.match(resumed.context ?? "", /SET UP EARLIER on this machine/);
	});

	test("a failed initialize puts the failing step, its log and its output tail in the context (#4588)", async () => {
		write(
			path("repo", ".atomic", "blueprint.yaml"),
			`initialize:\n  - name: Install toolchain\n    run: |\n      echo "compiler missing" >&2\n      exit 7\nmaintenance: npm install\n${KNOWLEDGE}`,
		);
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		const context = resumed.context ?? "";
		assert.match(context, /NOT RUN: the build of this blueprint failed before its maintenance/);
		assert.match(context, /Failure: The initialize step "Install toolchain"/);
		assert.match(context, /Build log: .*\.log/);
		assert.match(context, /compiler missing/);
		assert.match(context, /npm install/);
		assert.match(context, /npm run lint/);
		assert.match(context, /fix the environment, then update that blueprint/);
	});

	test("a failed maintenance step is labelled partial (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), "maintenance:\n  - echo ok\n  - exit 2\n");
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		assert.match(resumed.context ?? "", /PARTIAL: the build of this blueprint stopped at the failing step/);
	});

	test("an inherited workspace says its initialize was skipped (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), "initialize: echo init\nmaintenance: echo maint\n");
		await setUpResumedBlueprints({ restored: [repo()], config: config() });
		const second = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		assert.match(second.context ?? "", /initialize was skipped because this blueprint is unchanged/);
	});

	test("a global blueprint failure is in the context and the repositories are labelled not run (#4588)", async () => {
		write(path("agent", "blueprint.yaml"), "initialize: exit 3\n");
		write(path("repo", ".atomic", "blueprint.yaml"), "maintenance: npm install\n");
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		assert.match(resumed.context ?? "", /scope: global/);
		assert.match(resumed.context ?? "", /NOT RUN: the global blueprint failed before this one was built/);
	});

	test("the deprecated alias is listed among the global maintenance steps (#4588)", async () => {
		mkdirSync(path("repo"), { recursive: true });
		const layers = await describeBlueprints(
			[blueprintRepository(repo())],
			config({ setupCommand: "npm ci" }),
			"skipped",
		);
		const context = renderBlueprintContext(layers) ?? "";
		assert.match(context, new RegExp(`${SETUP_COMMAND_ALIAS}\\n {5}npm ci`));
	});

	test("a blueprint with no document for this platform surfaces nothing (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), `runs-on: macos\nmaintenance: brew install x\n${KNOWLEDGE}`);
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		assert.equal(resumed.context, undefined);
	});

	test("an invalid blueprint is described by its failure only (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), "maintenance:\n  - uses: github.com/actions/setup-node@v4\n");
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		assert.match(resumed.context ?? "", /'uses' steps are not supported in maintenance sections/);
	});

	test("the output tail is bounded (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), "maintenance: |\n  seq 1 500\n  exit 1\n");
		const resumed = await setUpResumedBlueprints({ restored: [repo()], config: config() });
		const context = resumed.context ?? "";
		assert.match(context, /\n {2}500\n/);
		assert.doesNotMatch(context, /\n {2}400\n/);
	});
});

describe("blueprint notices for the user (#4588)", () => {
	test("success, no blueprint and a skipped build say nothing (#4588)", async () => {
		mkdirSync(path("repo"), { recursive: true });
		const none = await runBlueprintBuild([blueprintRepository(repo())], config());
		assert.deepEqual(blueprintNotices(none, false), []);
		write(path("repo", ".atomic", "blueprint.yaml"), "maintenance: echo ok\n");
		const skipped = await runBlueprintBuild([blueprintRepository(repo())], config({ trusted: () => false }));
		assert.deepEqual(blueprintNotices(skipped, false), []);
		const success = await runBlueprintBuild([blueprintRepository(repo())], config());
		assert.deepEqual(blueprintNotices(success, false), []);
	});

	test("a repository failure is a Partial warning naming the blueprint and the failing step (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), "initialize:\n  - name: Install toolchain\n    run: exit 7\n");
		const outcome = await runBlueprintBuild([blueprintRepository(repo())], config());
		const notices = blueprintNotices(outcome, false);
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.type, "warning");
		assert.match(notices[0]?.message ?? "", /^Partial build: /);
		assert.ok((notices[0]?.message ?? "").includes(path("repo", ".atomic", "blueprint.yaml")));
		assert.ok((notices[0]?.message ?? "").includes("Install toolchain"));
		assert.match(notices[0]?.message ?? "", /\.log/);
	});

	test("a global failure is a prominent warning that says the session resumed anyway (#4588)", async () => {
		write(path("agent", "blueprint.yaml"), "initialize:\n  - name: Install tools\n    run: exit 1\n");
		write(path("repo", ".atomic", "blueprint.yaml"), "maintenance: echo ok\n");
		const outcome = await runBlueprintBuild([blueprintRepository(repo())], config());
		const [notice] = blueprintNotices(outcome, false);
		assert.equal(notice?.type, "warning");
		assert.match(notice?.message ?? "", /^Blueprint build FAILED: /);
		assert.match(notice?.message ?? "", /Install tools/);
		assert.match(notice?.message ?? "", /resumed anyway/);
	});

	test("the deprecated alias earns one deprecation warning when a build ran (#4588)", async () => {
		mkdirSync(path("repo"), { recursive: true });
		const ran = await runBlueprintBuild([blueprintRepository(repo())], config({ setupCommand: "true" }));
		const notices = blueprintNotices(ran, true);
		assert.deepEqual(
			notices.map((notice) => notice.message.startsWith("Deprecation warning: resume.setupCommand is deprecated")),
			[true],
		);
		const skipped = await runBlueprintBuild(
			[blueprintRepository(repo())],
			config({ setupCommand: "true", trusted: () => false }),
		);
		assert.deepEqual(blueprintNotices(skipped, true), []);
	});

	test("a clone section earns a warning once it was built (#4588)", async () => {
		write(path("repo", ".atomic", "blueprint.yaml"), "clone:\n  depth: 1\nmaintenance: echo ok\n");
		const notices = blueprintNotices(await runBlueprintBuild([blueprintRepository(repo())], config()), false);
		assert.equal(notices.length, 1);
		assert.match(notices[0]?.message ?? "", /'clone' is ignored/);
	});
});

describe("recording the context in the session (#4588)", () => {
	test("the context becomes a hidden custom message entry, once while it does not change (#4588)", async () => {
		const sessionManager = SessionManager.inMemory(sandbox);
		await recordBlueprintContext(sessionManager, undefined);
		assert.equal(sessionManager.getBranch().length, 0);
		await recordBlueprintContext(sessionManager, "<blueprint_context>one</blueprint_context>");
		await recordBlueprintContext(sessionManager, "<blueprint_context>one</blueprint_context>");
		const entries = sessionManager.getBranch();
		assert.equal(entries.length, 1);
		const [entry] = entries;
		assert.equal(entry?.type, "custom_message");
		if (entry?.type !== "custom_message") return;
		assert.equal(entry.customType, BLUEPRINT_CONTEXT_TYPE);
		assert.equal(entry.display, false);
		assert.equal(entry.content, "<blueprint_context>one</blueprint_context>");
		await recordBlueprintContext(sessionManager, "<blueprint_context>two</blueprint_context>");
		assert.equal(sessionManager.getBranch().length, 2);
	});
});

const INTRO = [
	"<blueprint_context>",
	"This session was resumed. The blueprints below (.atomic/blueprint.yaml files) describe how its environment is set up. Maintenance steps are NOT run automatically at session start: re-run the ones you need when dependencies changed or a blueprint says its steps have not run yet. Knowledge items are reference information for this project.",
	"When a blueprint failed or did not run, fix the environment, then update that blueprint in the same change so the next restore succeeds. Never write secrets into a blueprint.",
];
const OUTRO = "</blueprint_context>";

function document(overrides: Partial<BlueprintDocument> = {}): BlueprintDocument {
	return {
		platforms: ["linux"],
		shell: "default",
		initialize: [],
		maintenance: [],
		knowledge: [],
		postBuild: [],
		includes: [],
		...overrides,
	};
}

function failure(overrides: Partial<BlueprintFailure> = {}): BlueprintFailure {
	return {
		scope: "repository",
		blueprint: "/repo/.atomic/blueprint.yaml",
		root: "/repo",
		directory: ".",
		error: new BlueprintStepFailedError({
			blueprint: "/repo/.atomic/blueprint.yaml",
			scope: "repository",
			section: "initialize",
			index: 0,
			step: "Install toolchain",
			exitStatus: 7,
			signal: null,
			logPath: "/store/step.log",
		}),
		logPath: "/store/step.log",
		outputTail: "",
		...overrides,
	};
}

function layer(overrides: Partial<BlueprintLayer> = {}): BlueprintLayer {
	return {
		scope: "repository",
		blueprint: "/repo/.atomic/blueprint.yaml",
		root: "/repo",
		directory: ".",
		document: document({ knowledge: [{ name: "lint", contents: "npm run lint" }] }),
		state: { kind: "built", action: "rebuild" },
		...overrides,
	};
}

function render(...layers: BlueprintLayer[]): string {
	const rendered = renderBlueprintContext(layers);
	assert.ok(rendered !== undefined, "expected a blueprint context");
	return rendered;
}

function blockOf(...layers: BlueprintLayer[]): string[] {
	const lines = render(...layers).split("\n");
	assert.deepEqual(lines.slice(0, 3), INTRO);
	assert.equal(lines.at(-1), OUTRO);
	return lines.slice(3, -1);
}

const STATE_LINE = (text: string) => [
	"<blueprint>",
	"scope: repository",
	"blueprint: /repo/.atomic/blueprint.yaml",
	"workspace: .",
	"repository: /repo",
	`state: ${text}`,
];

describe("rendering the blueprint context (#4588)", () => {
	test("layers with nothing to say add nothing to the conversation (#4588)", () => {
		assert.equal(renderBlueprintContext([]), undefined);
		assert.equal(renderBlueprintContext([layer({ state: { kind: "no-document" } })]), undefined);
		assert.equal(
			renderBlueprintContext([
				layer({
					state: { kind: "no-document" },
					document: document({ maintenance: [{ kind: "run", name: undefined, run: "x", env: {} }] }),
				}),
			]),
			undefined,
		);
		assert.equal(renderBlueprintContext([layer({ document: undefined })]), undefined);
		assert.equal(renderBlueprintContext([layer({ document: document() })]), undefined);
		assert.equal(
			renderBlueprintContext([layer({ state: { kind: "not-run", reason: "untrusted" }, document: undefined })]),
			undefined,
		);
	});

	test("a layer with something to say is wrapped between the introduction and the closing tag, one line per line (#4588)", () => {
		const lines = blockOf(layer());
		assert.deepEqual(lines, [
			...STATE_LINE("ran during this resume's build (initialize and maintenance)"),
			"Knowledge:",
			"  lint:",
			"    npm run lint",
			"</blueprint>",
		]);
	});

	test("the header names the scope, the blueprint and, when the layer has them, its workspace and repository (#4588)", () => {
		const header = (scope: BlueprintLayer["scope"], extra: Partial<BlueprintLayer>) =>
			blockOf(layer({ scope, blueprint: `/${scope}.yaml`, ...extra })).slice(0, 5);
		assert.deepEqual(header("global", { root: null, directory: null }), [
			"<blueprint>",
			"scope: global",
			"blueprint: /global.yaml",
			"state: ran during this resume's build (initialize and maintenance)",
			"Knowledge:",
		]);
		assert.deepEqual(header("workspace", { root: "/repo", directory: "services/api" }), [
			"<blueprint>",
			"scope: workspace",
			"blueprint: /workspace.yaml",
			"workspace: services/api",
			"repository: /repo",
		]);
		assert.deepEqual(header("workspace", { root: null, directory: "services/api" }).slice(3, 5), [
			"workspace: services/api",
			"state: ran during this resume's build (initialize and maintenance)",
		]);
		assert.deepEqual(header("repository", { root: "/repo", directory: null }).slice(3, 5), [
			"repository: /repo",
			"state: ran during this resume's build (initialize and maintenance)",
		]);
	});

	test("each layer state says what the build did with the blueprint (#4588)", () => {
		const cases: readonly [BlueprintLayerState, string][] = [
			[{ kind: "built", action: "rebuild" }, "ran during this resume's build (initialize and maintenance)"],
			[
				{ kind: "built", action: "inherit" },
				"ran during this resume's build: maintenance only, initialize was skipped because this blueprint is unchanged since its last successful build on this machine",
			],
			[
				{ kind: "not-run", reason: "untrusted" },
				"NOT YET RUN on this machine: the project is not trusted, so the build was skipped",
			],
			[
				{ kind: "not-run", reason: "in-place" },
				"NOT YET RUN on this machine: this checkout is used as it is and no build ran for it",
			],
			[
				{ kind: "not-run", reason: "earlier" },
				"SET UP EARLIER on this machine: a previous resume built this worktree, and maintenance was not run again",
			],
			[
				{ kind: "not-run", reason: "global-failed" },
				"NOT RUN: the global blueprint failed before this one was built",
			],
			[{ kind: "not-run", reason: "skipped" }, "NOT YET RUN on this machine: the build was skipped"],
		];
		for (const [state, text] of cases) {
			assert.deepEqual(blockOf(layer({ state })).slice(0, 6), STATE_LINE(text), JSON.stringify(state));
		}
	});

	test("a failed layer is partial once maintenance or post-build ran and not run before that (#4588)", () => {
		const partial =
			"PARTIAL: the build of this blueprint stopped at the failing step below; the maintenance steps before it ran";
		const notRun = "NOT RUN: the build of this blueprint failed before its maintenance, see the failing step below";
		const cases: readonly [BlueprintLayerState, string][] = [
			[{ kind: "failed", failure: failure(), section: "maintenance" }, partial],
			[{ kind: "failed", failure: failure(), section: "post-build" }, partial],
			[{ kind: "failed", failure: failure(), section: "initialize" }, notRun],
			[{ kind: "failed", failure: failure(), section: null }, notRun],
		];
		for (const [state, text] of cases) {
			const lines = blockOf(layer({ state, document: undefined }));
			assert.deepEqual(lines.slice(0, 6), STATE_LINE(text));
		}
	});

	test("a failed layer lists its failure, its log and the end of its output, then what the blueprint says (#4588)", () => {
		const failed = failure({ outputTail: "compiler missing\nsee docs\n" });
		const lines = blockOf(
			layer({
				state: { kind: "failed", failure: failed, section: "initialize" },
				document: document({
					maintenance: [{ kind: "run", name: "Install deps", run: "npm ci", env: {} }],
					knowledge: [{ name: "lint", contents: "npm run lint" }],
				}),
			}),
		);
		assert.deepEqual(lines, [
			...STATE_LINE(
				"NOT RUN: the build of this blueprint failed before its maintenance, see the failing step below",
			),
			`Failure: ${failed.error.message}`,
			"Build log: /store/step.log",
			"Output tail:",
			"  compiler missing",
			"  see docs",
			"Maintenance steps:",
			"  1. Install deps",
			"     npm ci",
			"Knowledge:",
			"  lint:",
			"    npm run lint",
			"</blueprint>",
		]);
	});

	test("a failure without a log or output has neither a log line nor an output tail (#4588)", () => {
		for (const outputTail of ["", "\n\n", "   \n "]) {
			const lines = blockOf(
				layer({
					state: { kind: "failed", failure: failure({ logPath: null, outputTail }), section: null },
					document: undefined,
				}),
			);
			assert.equal(lines.length, 8, JSON.stringify(outputTail));
			assert.ok(lines[6]?.startsWith("Failure: "));
			assert.equal(lines[7], "</blueprint>");
		}
	});

	test("the output tail keeps the last 20 lines, its indentation and drops trailing blank lines (#4588)", () => {
		const numbered = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");
		const tailOf = (outputTail: string) => {
			const lines = blockOf(
				layer({ state: { kind: "failed", failure: failure({ outputTail }), section: null }, document: undefined }),
			);
			return lines.slice(lines.indexOf("Output tail:") + 1, -1);
		};
		assert.deepEqual(
			tailOf(`${numbered}\n\n  \n`),
			Array.from({ length: 20 }, (_, index) => `  line ${index + 6}`),
		);
		assert.deepEqual(tailOf("  indented\n    deeper\n"), ["    indented", "      deeper"]);
		assert.deepEqual(tailOf("last\n\n\n"), ["  last"]);
	});

	test("the output tail is capped at its last 1500 characters (#4588)", () => {
		const tailOf = (outputTail: string) => {
			const lines = blockOf(
				layer({ state: { kind: "failed", failure: failure({ outputTail }), section: null }, document: undefined }),
			);
			return lines.slice(lines.indexOf("Output tail:") + 1, -1);
		};
		assert.deepEqual(tailOf(`${"a".repeat(1000)}\n${"b".repeat(1000)}`), [
			`  ${"a".repeat(499)}`,
			`  ${"b".repeat(1000)}`,
		]);
		assert.deepEqual(tailOf("c".repeat(1500)), [`  ${"c".repeat(1500)}`]);
		assert.deepEqual(tailOf("d".repeat(1501)), [`  ${"d".repeat(1500)}`]);
		assert.deepEqual(tailOf("e".repeat(1499)), [`  ${"e".repeat(1499)}`]);
	});

	test("maintenance steps are numbered from 1, named or not, with their commands indented and trimmed at the end (#4588)", () => {
		const lines = blockOf(
			layer({
				document: document({
					maintenance: [
						{ kind: "run", name: "Install deps", run: "npm ci\nnpm run build\n\n", env: {} },
						{ kind: "run", name: undefined, run: "  indented first\n    deeper", env: {} },
						{ kind: "run", name: "Third", run: "echo 3", env: {} },
					],
				}),
			}),
		);
		assert.deepEqual(lines.slice(6), [
			"Maintenance steps:",
			"  1. Install deps",
			"     npm ci",
			"     npm run build",
			"  2. maintenance step",
			"       indented first",
			"         deeper",
			"  3. Third",
			"     echo 3",
			"</blueprint>",
		]);
	});

	test("knowledge items keep their order, their names and their indentation, trimmed at the end (#4588)", () => {
		const lines = blockOf(
			layer({
				document: document({
					knowledge: [
						{ name: "lint", contents: "npm run lint\n  --fix\n\n" },
						{ name: "  spaced", contents: "  leading\nsecond" },
						{ name: "empty", contents: "" },
					],
				}),
			}),
		);
		assert.deepEqual(lines.slice(6), [
			"Knowledge:",
			"  lint:",
			"    npm run lint",
			"      --fix",
			"    spaced:",
			"      leading",
			"    second",
			"  empty:",
			"    ",
			"</blueprint>",
		]);
	});

	test("a document without maintenance steps has no maintenance heading, and one without knowledge has no knowledge heading (#4588)", () => {
		const onlyMaintenance = blockOf(
			layer({ document: document({ maintenance: [{ kind: "run", name: "x", run: "y", env: {} }] }) }),
		);
		assert.deepEqual(onlyMaintenance.slice(6), ["Maintenance steps:", "  1. x", "     y", "</blueprint>"]);
		const onlyKnowledge = blockOf(layer({ document: document({ knowledge: [{ name: "k", contents: "v" }] }) }));
		assert.deepEqual(onlyKnowledge.slice(6), ["Knowledge:", "  k:", "    v", "</blueprint>"]);
	});

	test("layers are listed in order and layers with nothing to say are left out (#4588)", () => {
		const lines = blockOf(
			layer({ scope: "global", blueprint: "/g.yaml", root: null, directory: null }),
			layer({ blueprint: "/skipped.yaml", state: { kind: "no-document" } }),
			layer({ blueprint: "/empty.yaml", document: document() }),
			layer({
				scope: "workspace",
				blueprint: "/w.yaml",
				directory: "w",
				state: { kind: "not-run", reason: "earlier" },
			}),
		);
		assert.deepEqual(
			lines.filter((line) => line.startsWith("blueprint: ") || line === "<blueprint>" || line === "</blueprint>"),
			["<blueprint>", "blueprint: /g.yaml", "</blueprint>", "<blueprint>", "blueprint: /w.yaml", "</blueprint>"],
		);
		assert.equal(lines.filter((line) => line === "").length, 0);
	});
});
