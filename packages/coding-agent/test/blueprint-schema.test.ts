import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { getProjectBlueprintPath } from "../src/config.ts";
import { blueprintPlatformOf } from "../src/core/resume/blueprint/schema.ts";
import {
	BLUEPRINT_RULES,
	BlueprintInvalidError,
	type BlueprintInvalidReason,
	type BlueprintScope,
	hostPlatform,
	isBlueprintInvalidError,
	parseBlueprint,
	selectDocument,
} from "../src/core/resume/index.ts";

const PATH = "/repo/.atomic/blueprint.yaml";

function parse(source: string, scope: BlueprintScope = "repository") {
	return parseBlueprint(source, { path: PATH, scope });
}

function invalidReason(source: string, scope: BlueprintScope = "repository"): BlueprintInvalidReason {
	try {
		parse(source, scope);
	} catch (error) {
		assert.ok(error instanceof BlueprintInvalidError, `expected BlueprintInvalidError, got ${String(error)}`);
		return error.reason;
	}
	assert.fail("expected the blueprint to be invalid");
}

function firstDocument(source: string, scope: BlueprintScope = "repository") {
	const document = parse(source, scope).documents[0];
	assert.ok(document !== undefined);
	return document;
}

describe("blueprint parsing: sections and steps (#4588)", () => {
	test("a section given as a bare string becomes one run step (#4588)", () => {
		const document = firstDocument("initialize: |\n  npm install -g pnpm\n  pnpm --version\n");
		assert.deepEqual(document.initialize, [
			{ kind: "run", name: undefined, run: "npm install -g pnpm\npnpm --version\n", env: {} },
		]);
	});

	test("a list entry given as a bare string becomes a run step, and both forms mix (#4588)", () => {
		const document = firstDocument(
			"maintenance:\n  - npm install\n  - name: Install python deps\n    run: uv sync\n    env:\n      UV_CACHE_DIR: /tmp/uv\n",
		);
		assert.deepEqual(document.maintenance, [
			{ kind: "run", name: undefined, run: "npm install", env: {} },
			{ kind: "run", name: "Install python deps", run: "uv sync", env: { UV_CACHE_DIR: "/tmp/uv" } },
		]);
	});

	test("a uses step keeps its reference, stringifies every with value and env value (#4588)", () => {
		const document = firstDocument(
			"initialize:\n  - uses: github.com/actions/setup-node@v4\n    with:\n      node-version: 20\n      check-latest: true\n      cache: null\n    env:\n      RUNNER_DEBUG: 1\n",
		);
		assert.deepEqual(document.initialize, [
			{
				kind: "uses",
				name: undefined,
				uses: "github.com/actions/setup-node@v4",
				with: { "node-version": "20", "check-latest": "true", cache: "" },
				env: { RUNNER_DEBUG: "1" },
			},
		]);
	});

	test("a uses reference may name a subpath (#4588)", () => {
		const document = firstDocument("initialize:\n  - uses: github.com/gradle/actions/setup-gradle@v4\n");
		assert.equal(document.initialize[0]?.kind, "uses");
		assert.equal((document.initialize[0] as { uses: string }).uses, "github.com/gradle/actions/setup-gradle@v4");
	});

	test("knowledge items are { name, contents } and never steps (#4588)", () => {
		const document = firstDocument("knowledge:\n  - name: lint\n    contents: |\n      npm run lint\n");
		assert.deepEqual(document.knowledge, [{ name: "lint", contents: "npm run lint\n" }]);
		assert.deepEqual(document.initialize, []);
		assert.deepEqual(document.maintenance, []);
	});

	test("omitted sections are empty and unknown keys are ignored (#4588)", () => {
		const document = firstDocument("something-else: true\n");
		assert.deepEqual(document.initialize, []);
		assert.deepEqual(document.maintenance, []);
		assert.deepEqual(document.knowledge, []);
		assert.deepEqual(document.postBuild, []);
		assert.deepEqual(document.platforms, ["linux"]);
		assert.equal(document.shell, "default");
	});

	test("an empty file has no documents and so nothing to run (#4588)", () => {
		assert.deepEqual(parse("").documents, []);
		assert.deepEqual(parse("# only a comment\n").documents, []);
		assert.equal(selectDocument(parse(""), "linux"), undefined);
	});

	test("post-build is read in the global blueprint (#4588)", () => {
		const document = firstDocument("post-build:\n  - name: verify\n    run: node --version\n", "global");
		assert.deepEqual(document.postBuild, [{ kind: "run", name: "verify", run: "node --version", env: {} }]);
	});
});

describe("blueprint validation errors (#4588)", () => {
	test("a step with run and uses is rejected (#4588)", () => {
		assert.equal(
			invalidReason("initialize:\n  - run: echo\n    uses: github.com/a/b@v1\n"),
			"run-and-uses" satisfies BlueprintInvalidReason,
		);
	});

	test("a step with neither run nor uses is rejected (#4588)", () => {
		assert.equal(invalidReason("initialize:\n  - name: nothing\n"), "missing-run-or-uses");
	});

	test("with on a run step is rejected, even when empty (#4588)", () => {
		assert.equal(invalidReason("initialize:\n  - run: echo\n    with: {}\n"), "with-without-uses");
	});

	test("uses in maintenance is rejected with Devin's exact message (#4588)", () => {
		assert.throws(
			() => parse("maintenance:\n  - uses: github.com/actions/setup-node@v4\n"),
			(error: unknown) => {
				assert.ok(isBlueprintInvalidError(error));
				assert.equal(error.code, "blueprint-invalid");
				assert.equal(error.reason, "uses-in-maintenance");
				assert.equal(error.rule, "'uses' steps are not supported in maintenance sections");
				assert.equal(error.rule, BLUEPRINT_RULES.usesInMaintenance);
				assert.ok(error.message.includes("'uses' steps are not supported in maintenance sections"));
				assert.equal(error.subject, "maintenance[0]");
				assert.equal(error.blueprint, PATH);
				assert.equal(error.scope, "repository");
				return true;
			},
		);
	});

	test("uses next to run in maintenance is still the uses-in-maintenance rule (#4588)", () => {
		assert.equal(invalidReason("maintenance:\n  - run: echo\n    uses: github.com/a/b@v1\n"), "uses-in-maintenance");
	});

	test("a uses reference needs the github.com prefix and the @ref suffix (#4588)", () => {
		assert.equal(invalidReason("initialize:\n  - uses: actions/setup-node@v4\n"), "invalid-uses-reference");
		assert.equal(invalidReason("initialize:\n  - uses: github.com/actions/setup-node\n"), "invalid-uses-reference");
		assert.equal(invalidReason("initialize:\n  - uses: github.com/actions@v4\n"), "invalid-uses-reference");
		assert.equal(invalidReason("initialize:\n  - uses: 3\n"), "invalid-uses-reference");
	});

	test("a top-level sequence is rejected with Devin's exact message (#4588)", () => {
		assert.throws(
			() => parse("- initialize: echo\n- maintenance: echo\n"),
			(error: unknown) => {
				assert.ok(isBlueprintInvalidError(error));
				assert.equal(error.reason, "not-a-mapping");
				assert.equal(
					error.rule,
					"each YAML document must be a mapping, not a sequence; use '---' to separate multiple blocks",
				);
				return true;
			},
		);
	});

	test("a scalar document is rejected as not a mapping (#4588)", () => {
		assert.equal(invalidReason("just text\n"), "not-a-mapping");
	});

	test("every document must be a mapping, not only the first (#4588)", () => {
		assert.equal(invalidReason("initialize: echo\n---\n- a\n"), "not-a-mapping");
	});

	test("shell accepts default, bash and powershell in any case and rejects the rest with Devin's exact message (#4588)", () => {
		assert.equal(firstDocument("shell: Bash\n").shell, "default");
		assert.equal(firstDocument("shell: DEFAULT\n").shell, "default");
		assert.equal(firstDocument("shell: PowerShell\n").shell, "powershell");
		assert.throws(
			() => parse("shell: zsh\n"),
			(error: unknown) => {
				assert.ok(isBlueprintInvalidError(error));
				assert.equal(error.reason, "invalid-shell");
				assert.equal(error.rule, "shell: must be 'default', 'bash', or 'powershell'");
				return true;
			},
		);
		assert.equal(invalidReason("shell: 5\n"), "invalid-shell");
	});

	test("text that is not YAML is a yaml-syntax error that keeps its cause (#4588)", () => {
		assert.throws(
			() => parse("initialize: [unterminated\n"),
			(error: unknown) => {
				assert.ok(isBlueprintInvalidError(error));
				assert.equal(error.reason, "yaml-syntax");
				assert.ok(error.cause instanceof Error);
				return true;
			},
		);
	});

	test("a document with too many YAML aliases is a yaml-syntax error that keeps its cause (#4588)", () => {
		const aliases = Array.from({ length: 150 }, () => "*a").join(", ");
		assert.throws(
			() => parse(`anchor: &a [1, 2, 3]\nrepeated: [${aliases}]\n`),
			(error: unknown) => {
				assert.ok(isBlueprintInvalidError(error));
				assert.equal(error.reason, "yaml-syntax");
				assert.equal(error.subject, "document 1");
				assert.equal(error.rule, "YAML cannot be read: it has too many aliases");
				assert.ok(error.cause instanceof Error);
				return true;
			},
		);
	});

	test("an invalid blueprint names its path and scope in typed fields (#4588)", () => {
		assert.throws(
			() => parseBlueprint("shell: zsh\n", { path: "/home/a/.atomic/agent/blueprint.yaml", scope: "global" }),
			(error: unknown) => {
				assert.ok(isBlueprintInvalidError(error));
				assert.equal(error.blueprint, "/home/a/.atomic/agent/blueprint.yaml");
				assert.equal(error.scope, "global");
				return true;
			},
		);
	});
});

describe("blueprint runs-on and multi-document files (#4588)", () => {
	test("runs-on resolves default to linux, lower-cases labels and accepts a string or a list (#4588)", () => {
		assert.deepEqual(firstDocument("runs-on: Default\n").platforms, ["linux"]);
		assert.deepEqual(firstDocument("runs-on: [Linux, MacOS, windows]\n").platforms, ["linux", "macos", "windows"]);
		assert.deepEqual(firstDocument("runs-on: [default, linux]\n").platforms, ["linux"]);
		assert.deepEqual(firstDocument("runs-on: []\n").platforms, ["linux"]);
	});

	test("two documents that resolve to the same platform are rejected, including default and linux (#4588)", () => {
		assert.equal(invalidReason("initialize: a\n---\nruns-on: linux\ninitialize: b\n"), "duplicate-platform");
		assert.equal(invalidReason("runs-on: [default]\n---\nruns-on: [Linux]\n"), "duplicate-platform");
		assert.equal(invalidReason("runs-on: macos\n---\nruns-on: [windows, MACOS]\n"), "duplicate-platform");
	});

	test("documents for different platforms coexist and each host selects only its own (#4588)", () => {
		const blueprint = parse(
			"initialize: echo linux\n---\nruns-on: macos\ninitialize: echo mac\n---\nruns-on: windows\nshell: powershell\ninitialize: echo win\n",
		);
		assert.equal(blueprint.documents.length, 3);
		const run = (platform: "linux" | "macos" | "windows") => {
			const step = selectDocument(blueprint, platform)?.initialize[0];
			return step?.kind === "run" ? step.run : undefined;
		};
		assert.equal(run("linux"), "echo linux");
		assert.equal(run("macos"), "echo mac");
		assert.equal(run("windows"), "echo win");
		assert.equal(selectDocument(blueprint, "windows")?.shell, "powershell");
	});

	test("a host with no matching document selects nothing, so nothing runs or is surfaced (#4588)", () => {
		const blueprint = parse("runs-on: macos\ninitialize: echo mac\n");
		assert.equal(selectDocument(blueprint, "linux"), undefined);
		assert.equal(selectDocument(blueprint, "windows"), undefined);
	});

	test("a file without runs-on does not apply on a macOS or Windows host (#4588)", () => {
		const blueprint = parse("initialize: echo\n");
		assert.notEqual(selectDocument(blueprint, "linux"), undefined);
		assert.equal(selectDocument(blueprint, "macos"), undefined);
		assert.equal(selectDocument(blueprint, "windows"), undefined);
	});

	test("the host platform follows process.platform (#4588)", () => {
		const expected = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
		assert.equal(hostPlatform(), expected);
	});

	test("validation covers documents for other platforms too (#4588)", () => {
		assert.equal(invalidReason("initialize: ok\n---\nruns-on: windows\nshell: zsh\n"), "invalid-shell");
	});
});

describe("blueprint includes, post-build and clone (#4588)", () => {
	test("includes names workspace directories and full file paths, normalized (#4588)", () => {
		const document = firstDocument("includes:\n  - services/api/\n  - ./web\n  - tools/cli/.atomic/blueprint.yaml\n");
		assert.deepEqual(document.includes, [
			{ entry: "services/api/", directory: "services/api", file: "services/api/.atomic/blueprint.yaml" },
			{ entry: "./web", directory: "web", file: "web/.atomic/blueprint.yaml" },
			{
				entry: "tools/cli/.atomic/blueprint.yaml",
				directory: "tools/cli",
				file: "tools/cli/.atomic/blueprint.yaml",
			},
		]);
		assert.equal(firstDocument("includes: services/api\n").includes[0]?.directory, "services/api");
	});

	test("only <dir>/.atomic/blueprint.yaml is a blueprint file path: no other file name is ever read (#4588)", () => {
		const { includes } = firstDocument(
			"includes:\n  - pkg/.devin/blueprint.yaml\n  - other/blueprint.yaml\n  - blueprint.yaml\n  - docs/.atomic/other.yaml\n",
		);
		assert.deepEqual(
			includes.map((include) => [include.directory, include.file]),
			[
				["pkg/.devin/blueprint.yaml", "pkg/.devin/blueprint.yaml/.atomic/blueprint.yaml"],
				["other/blueprint.yaml", "other/blueprint.yaml/.atomic/blueprint.yaml"],
				["blueprint.yaml", "blueprint.yaml/.atomic/blueprint.yaml"],
				["docs/.atomic/other.yaml", "docs/.atomic/other.yaml/.atomic/blueprint.yaml"],
			],
		);
		for (const include of includes) assert.ok(include.file.endsWith("/.atomic/blueprint.yaml"), include.file);
	});

	test("an include path with .. is rejected, wherever the segment sits (#4588)", () => {
		assert.equal(invalidReason("includes: ../outside\n"), "include-parent-path");
		assert.equal(invalidReason("includes:\n  - a/../b\n"), "include-parent-path");
		assert.equal(invalidReason("includes: 'a\\..\\b'\n"), "include-parent-path");
	});

	test("each workspace path may appear only once, however it is spelled (#4588)", () => {
		assert.equal(invalidReason("includes: [api, api]\n"), "duplicate-include");
		assert.equal(invalidReason("includes: [api, ./api/, api/.atomic/blueprint.yaml]\n"), "duplicate-include");
		assert.equal(invalidReason("includes: ['.']\n"), "duplicate-include");
	});

	test("includes is not allowed in a workspace blueprint (no nesting) (#4588)", () => {
		assert.equal(invalidReason("includes: [api]\n", "workspace"), "nested-includes");
	});

	test("includes is ignored in the global blueprint (#4588)", () => {
		assert.deepEqual(firstDocument("includes: [api, ../bad]\n", "global").includes, []);
	});

	test("post-build is rejected in repository and workspace blueprints (#4588)", () => {
		assert.equal(invalidReason("post-build: echo\n", "repository"), "post-build-not-global");
		assert.equal(invalidReason("post-build: echo\n", "workspace"), "post-build-not-global");
	});

	test("clone is parsed and ignored with a warning (#4588)", () => {
		const blueprint = parse("clone:\n  depth: 1\ninitialize: echo\n");
		assert.equal(blueprint.documents.length, 1);
		assert.equal(blueprint.warnings.length, 1);
		assert.equal(blueprint.warnings[0]?.code, "clone-ignored");
		assert.equal(blueprint.warnings[0]?.blueprint, PATH);
		assert.deepEqual(parse("initialize: echo\n").warnings, []);
	});

	test("blueprint paths come from the config helpers: <dir>/.atomic/blueprint.yaml (#4588)", () => {
		assert.ok(getProjectBlueprintPath("/repo").replaceAll("\\", "/").endsWith("/repo/.atomic/blueprint.yaml"));
	});
});

interface Failure {
	readonly reason: BlueprintInvalidReason;
	readonly rule: string;
	readonly subject: string | null;
	readonly message: string;
	readonly cause: Error | undefined;
}

function failureOf(source: string, scope: BlueprintScope = "repository"): Failure {
	try {
		parse(source, scope);
	} catch (error) {
		assert.ok(error instanceof BlueprintInvalidError, `expected BlueprintInvalidError, got ${String(error)}`);
		return {
			reason: error.reason,
			rule: error.rule,
			subject: error.subject,
			message: error.message,
			cause: error.cause instanceof Error ? error.cause : undefined,
		};
	}
	return assert.fail("expected the blueprint to be invalid");
}

function expectFailure(
	source: string,
	expected: { reason: BlueprintInvalidReason; rule: string; subject: string | null },
	scope: BlueprintScope = "repository",
): void {
	const { reason, rule, subject } = failureOf(source, scope);
	assert.deepEqual({ reason, rule, subject }, expected);
}

describe("blueprint host platform (#4588)", () => {
	test("each Node.js platform maps to its blueprint platform, and every other one is linux (#4588)", () => {
		assert.equal(blueprintPlatformOf("darwin"), "macos");
		assert.equal(blueprintPlatformOf("win32"), "windows");
		assert.equal(blueprintPlatformOf("linux"), "linux");
		assert.equal(blueprintPlatformOf("freebsd"), "linux");
		assert.equal(blueprintPlatformOf("aix"), "linux");
	});
});

describe("blueprint YAML documents (#4588)", () => {
	test("a YAML syntax error names its code and the line it is on, and its cause carries no source excerpt (#4588)", () => {
		const first = failureOf("a: b: c\n");
		assert.equal(first.reason, "yaml-syntax");
		assert.equal(first.rule, "YAML syntax error (BLOCK_AS_IMPLICIT_KEY)");
		assert.equal(first.subject, "line 1");
		assert.ok(first.message.includes("YAML syntax error (BLOCK_AS_IMPLICIT_KEY) (line 1)"));
		assert.ok(first.cause instanceof Error);
		assert.equal(first.cause.message.includes("a: b: c"), false);
		const later = failureOf("ok: 1\n---\nfine: 2\ntabs:\n\t- x\n");
		assert.equal(later.rule, "YAML syntax error (TAB_AS_INDENT)");
		assert.equal(later.subject, "line 5");
	});

	test("empty documents between separators are skipped, not read as blueprints (#4588)", () => {
		const blueprint = parse("---\n---\ninitialize: echo\n---\n~\n---\nnull\n");
		assert.equal(blueprint.documents.length, 1);
		assert.deepEqual(parse("null\n").documents, []);
		assert.deepEqual(parse("~\n").documents, []);
	});

	test("a document that is not a mapping names its position in the file (#4588)", () => {
		expectFailure("- a\n", {
			reason: "not-a-mapping",
			rule: BLUEPRINT_RULES.documentSequence,
			subject: "document 1",
		});
		expectFailure("initialize: echo\n---\n- a\n", {
			reason: "not-a-mapping",
			rule: "each YAML document must be a mapping, not a sequence; use '---' to separate multiple blocks",
			subject: "document 2",
		});
		expectFailure("initialize: echo\n---\nplain text\n", {
			reason: "not-a-mapping",
			rule: "each YAML document must be a mapping, not a scalar; use '---' to separate multiple blocks",
			subject: "document 2",
		});
		expectFailure("5\n", {
			reason: "not-a-mapping",
			rule: BLUEPRINT_RULES.documentScalar,
			subject: "document 1",
		});
	});

	test("a duplicate platform names the platform and the alias rule (#4588)", () => {
		expectFailure("initialize: a\n---\nruns-on: default\n", {
			reason: "duplicate-platform",
			rule: "two YAML documents cannot resolve to the same platform; this includes the 'default' and 'linux' aliases",
			subject: "linux",
		});
		expectFailure("runs-on: [macos, windows]\n---\nruns-on: windows\n", {
			reason: "duplicate-platform",
			rule: "two YAML documents cannot resolve to the same platform; this includes the 'default' and 'linux' aliases",
			subject: "windows",
		});
	});

	test("post-build and nested includes name their rule and field (#4588)", () => {
		expectFailure(
			"post-build: echo\n",
			{
				reason: "post-build-not-global",
				rule: "'post-build' is only supported in the global blueprint",
				subject: "post-build",
			},
			"repository",
		);
		expectFailure(
			"includes: [api]\n",
			{
				reason: "nested-includes",
				rule: "'includes' is not allowed in an included workspace blueprint",
				subject: "includes",
			},
			"workspace",
		);
	});

	test("clone warns with the reason and names the blueprint (#4588)", () => {
		const [warning] = parse("clone: {}\n").warnings;
		assert.deepEqual(warning, {
			code: "clone-ignored",
			blueprint: PATH,
			message: "'clone' is ignored: a resume restores the recorded tree instead of cloning the repository",
		});
	});
});

describe("blueprint runs-on and shell values (#4588)", () => {
	test("a missing or null runs-on targets linux, and labels are trimmed and lower-cased (#4588)", () => {
		assert.deepEqual(firstDocument("runs-on:\ninitialize: echo\n").platforms, ["linux"]);
		assert.deepEqual(firstDocument("runs-on: '  MacOS '\n").platforms, ["macos"]);
		assert.deepEqual(firstDocument("runs-on: [' Windows ', ' DEFAULT ']\n").platforms, ["windows", "linux"]);
	});

	test("a runs-on label that is not a string is rejected (#4588)", () => {
		const expected = {
			reason: "invalid-field",
			rule: "'runs-on' must be a string or a list of strings",
			subject: "runs-on",
		} as const;
		expectFailure("runs-on: 5\n", expected);
		expectFailure("runs-on: [linux, 5]\n", expected);
		expectFailure("runs-on: [[linux]]\n", expected);
	});

	test("a null shell is the default and the shell value is trimmed (#4588)", () => {
		assert.equal(firstDocument("shell:\n").shell, "default");
		assert.equal(firstDocument("shell: ' bash '\n").shell, "default");
		assert.equal(firstDocument("shell: ' PowerShell '\n").shell, "powershell");
		expectFailure("shell: zsh\n", { reason: "invalid-shell", rule: BLUEPRINT_RULES.shell, subject: "shell" });
		expectFailure("shell: [bash]\n", { reason: "invalid-shell", rule: BLUEPRINT_RULES.shell, subject: "shell" });
	});
});

describe("blueprint step fields (#4588)", () => {
	test("a step error names its section and position (#4588)", () => {
		expectFailure("initialize:\n  - run: a\n  - name: b\n", {
			reason: "missing-run-or-uses",
			rule: "a step must define 'run' or 'uses'",
			subject: "initialize[1]",
		});
		expectFailure("initialize:\n  name: b\n", {
			reason: "missing-run-or-uses",
			rule: "a step must define 'run' or 'uses'",
			subject: "initialize",
		});
		expectFailure(
			"post-build:\n  - run: a\n  - run: b\n    uses: github.com/a/b@v1\n",
			{
				reason: "run-and-uses",
				rule: "a step must define 'run' or 'uses', but not both",
				subject: "post-build[1]",
			},
			"global",
		);
		expectFailure("maintenance:\n  - run: a\n    with: {}\n", {
			reason: "with-without-uses",
			rule: "'with' is only valid on 'uses' steps",
			subject: "maintenance[0]",
		});
		expectFailure("maintenance:\n  run: a\n  uses: github.com/a/b@v1\n", {
			reason: "uses-in-maintenance",
			rule: BLUEPRINT_RULES.usesInMaintenance,
			subject: "maintenance",
		});
	});

	test("a step that is not a string or a mapping is rejected, null and lists included (#4588)", () => {
		const expected = (subject: string) =>
			({ reason: "invalid-field", rule: "a step must be a string or a mapping", subject }) as const;
		expectFailure("initialize:\n  - run: a\n  - 5\n", expected("initialize[1]"));
		expectFailure("initialize: [~]\n", expected("initialize[0]"));
		expectFailure("initialize: [[a, b]]\n", expected("initialize[0]"));
		expectFailure("maintenance: 5\n", expected("maintenance"));
		expectFailure("initialize: true\n", expected("initialize"));
	});

	test("an empty section is empty, and a single mapping is one step (#4588)", () => {
		const document = firstDocument("initialize:\nmaintenance:\nknowledge:\n");
		assert.deepEqual(document.initialize, []);
		assert.deepEqual(document.maintenance, []);
		assert.deepEqual(document.knowledge, []);
		assert.deepEqual(firstDocument("initialize:\n  name: only\n  run: echo hi\n").initialize, [
			{ kind: "run", name: "only", run: "echo hi", env: {} },
		]);
		assert.deepEqual(firstDocument("initialize:\n  uses: github.com/a/b@v1\n  with:\n    k: v\n").initialize, [
			{ kind: "uses", name: undefined, uses: "github.com/a/b@v1", with: { k: "v" }, env: {} },
		]);
	});

	test("run and name accept any scalar and stringify it; other values are rejected (#4588)", () => {
		assert.deepEqual(firstDocument("initialize:\n  - name: 5\n    run: true\n").initialize, [
			{ kind: "run", name: "5", run: "true", env: {} },
		]);
		assert.deepEqual(firstDocument("initialize:\n  - name: false\n    run: 42\n").initialize, [
			{ kind: "run", name: "false", run: "42", env: {} },
		]);
		assert.equal(firstDocument("initialize:\n  - name:\n    run: echo\n").initialize[0]?.name, undefined);
		expectFailure("initialize:\n  - run:\n", {
			reason: "invalid-field",
			rule: "'run' must be a string",
			subject: "initialize[0]",
		});
		expectFailure("initialize:\n  - run: [a]\n", {
			reason: "invalid-field",
			rule: "'run' must be a string",
			subject: "initialize[0]",
		});
		expectFailure("initialize:\n  - name: [a]\n    run: echo\n", {
			reason: "invalid-field",
			rule: "'name' must be a string",
			subject: "initialize[0]",
		});
		expectFailure("initialize:\n  - name: {a: 1}\n    uses: github.com/a/b@v1\n", {
			reason: "invalid-field",
			rule: "'name' must be a string",
			subject: "initialize[0]",
		});
	});

	test("env and with values keep strings, stringify scalars and collections, and null is empty (#4588)", () => {
		const [step] = firstDocument(
			"initialize:\n  - uses: github.com/a/b@v1\n    with:\n      s: text\n      n: 3\n      b: false\n      z: ~\n      list: [1, two]\n      map: {k: v}\n    env:\n      E: 1.5\n      F: [a]\n",
		).initialize;
		assert.deepEqual(step, {
			kind: "uses",
			name: undefined,
			uses: "github.com/a/b@v1",
			with: { s: "text", n: "3", b: "false", z: "", list: '[1,"two"]', map: '{"k":"v"}' },
			env: { E: "1.5", F: '["a"]' },
		});
	});

	test("env and with must be mappings, named by their step and field (#4588)", () => {
		expectFailure("initialize:\n  - run: a\n    env: 5\n", {
			reason: "invalid-field",
			rule: "'env' must be a mapping",
			subject: "initialize[0].env",
		});
		expectFailure("initialize:\n  - run: a\n    env: [a]\n", {
			reason: "invalid-field",
			rule: "'env' must be a mapping",
			subject: "initialize[0].env",
		});
		expectFailure("initialize:\n  run: a\n  env: text\n", {
			reason: "invalid-field",
			rule: "'env' must be a mapping",
			subject: "initialize.env",
		});
		expectFailure("initialize:\n  - uses: github.com/a/b@v1\n    with: 5\n", {
			reason: "invalid-field",
			rule: "'with' must be a mapping",
			subject: "initialize[0].with",
		});
		expectFailure("initialize:\n  - uses: github.com/a/b@v1\n    with: [a]\n", {
			reason: "invalid-field",
			rule: "'with' must be a mapping",
			subject: "initialize[0].with",
		});
		assert.deepEqual(firstDocument("initialize:\n  - run: a\n    env:\n").initialize[0]?.env, {});
		assert.deepEqual(
			(firstDocument("initialize:\n  - uses: github.com/a/b@v1\n    with:\n").initialize[0] as { with: object })
				.with,
			{},
		);
	});

	test("a uses reference is trimmed and a bad one names its rule (#4588)", () => {
		const [step] = firstDocument("initialize:\n  - uses: '  github.com/a/b/sub/dir@v1.2  '\n").initialize;
		assert.equal((step as { uses: string }).uses, "github.com/a/b/sub/dir@v1.2");
		expectFailure("initialize:\n  - uses: actions/setup-node@v4\n", {
			reason: "invalid-uses-reference",
			rule: "'uses' must be github.com/<owner>/<repo>[/<subpath>]@<ref>; the 'github.com/' prefix and the '@<ref>' suffix are required",
			subject: "initialize[0]",
		});
	});

	test("a uses step in maintenance is rejected before any other step field is read (#4588)", () => {
		expectFailure("maintenance:\n  - uses: 5\n    env: 5\n", {
			reason: "uses-in-maintenance",
			rule: "'uses' steps are not supported in maintenance sections",
			subject: "maintenance[0]",
		});
	});
});

describe("blueprint knowledge and includes values (#4588)", () => {
	test("knowledge stringifies name and contents and treats missing ones as empty (#4588)", () => {
		assert.deepEqual(firstDocument("knowledge:\n  - name: 5\n    contents: true\n  - {}\n  - name: ~\n").knowledge, [
			{ name: "5", contents: "true" },
			{ name: "", contents: "" },
			{ name: "", contents: "" },
		]);
		assert.deepEqual(firstDocument("knowledge:\n  - name: n\n    contents: [a, b]\n").knowledge, [
			{ name: "n", contents: '["a","b"]' },
		]);
	});

	test("knowledge must be a list of mappings (#4588)", () => {
		expectFailure("knowledge: text\n", {
			reason: "invalid-field",
			rule: "'knowledge' must be a list of { name, contents } items",
			subject: "knowledge",
		});
		expectFailure("knowledge: {name: a}\n", {
			reason: "invalid-field",
			rule: "'knowledge' must be a list of { name, contents } items",
			subject: "knowledge",
		});
		const item = { reason: "invalid-field", rule: "a knowledge item must be { name, contents }" } as const;
		expectFailure("knowledge:\n  - name: a\n  - text\n", { ...item, subject: "knowledge[1]" });
		expectFailure("knowledge: [~]\n", { ...item, subject: "knowledge[0]" });
		expectFailure("knowledge: [[a]]\n", { ...item, subject: "knowledge[0]" });
	});

	test("includes null is none, entries must be strings, and rule texts name the entry (#4588)", () => {
		assert.deepEqual(firstDocument("includes:\n").includes, []);
		const notString = {
			reason: "invalid-field",
			rule: "'includes' must be a string or a list of strings",
			subject: "includes",
		} as const;
		expectFailure("includes: 5\n", notString);
		expectFailure("includes: [api, 5]\n", notString);
		expectFailure("includes: [~]\n", notString);
		expectFailure("includes: [a/../b]\n", {
			reason: "include-parent-path",
			rule: "'includes' paths cannot contain '..'",
			subject: "a/../b",
		});
		expectFailure("includes: [api, ./api]\n", {
			reason: "duplicate-include",
			rule: "each workspace path can appear only once in 'includes'",
			subject: "./api",
		});
	});

	test("an include that resolves to the repository root is rejected, whichever way it is spelled (#4588)", () => {
		const root = (entry: string) =>
			({
				reason: "duplicate-include",
				rule: "each workspace path can appear only once in 'includes'",
				subject: entry,
			}) as const;
		expectFailure("includes: [.atomic/blueprint.yaml]\n", root(".atomic/blueprint.yaml"));
		expectFailure("includes: ['./.atomic/blueprint.yaml']\n", root("./.atomic/blueprint.yaml"));
		expectFailure("includes: ['']\n", root(""));
	});

	test("include separators are normalized and a nested blueprint file keeps its directory (#4588)", () => {
		assert.deepEqual(
			firstDocument(
				"includes:\n  - 'services\\api'\n  - a//b/./c/\n  - x/.atomic/blueprint.yaml\n  - y/z/.atomic/blueprint.yaml\n",
			).includes,
			[
				{ entry: "services\\api", directory: "services/api", file: "services/api/.atomic/blueprint.yaml" },
				{ entry: "a//b/./c/", directory: "a/b/c", file: "a/b/c/.atomic/blueprint.yaml" },
				{ entry: "x/.atomic/blueprint.yaml", directory: "x", file: "x/.atomic/blueprint.yaml" },
				{ entry: "y/z/.atomic/blueprint.yaml", directory: "y/z", file: "y/z/.atomic/blueprint.yaml" },
			],
		);
	});
});
