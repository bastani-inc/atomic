/**
 * Code loaded on demand after an in-place update replaced the installation (`loadOnDemand`, `utils/updated-install.ts`):
 * a module that cannot link or is gone says to restart, naming the feature, instead of failing with the runtime's error.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const DIST = join(ROOT, "packages/coding-agent/dist");
/** One child process that loads the helper and the host configuration: structural, not a slow test. */
const CHILD_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

interface Outcome {
	readonly loaded?: string;
	readonly name?: string;
	readonly message?: string;
	readonly cause?: string;
}

/**
 * A process of version 0.10.90 (its installation is `ATOMIC_PACKAGE_DIR`) loads `module` for a feature: a module of
 * the installation, or with `owner` "user" one outside it, as a user's extension is. With `update`, an update to
 * 0.10.91 has replaced the installation's package.json first; with `remove`, the installation is gone.
 */
function load(
	module: "lacks-export" | "missing-file" | "missing-package" | "throws" | "loads",
	change: "none" | "update" | "remove",
	options: { via?: "helper" | "tool"; owner?: "installation" | "user" } = {},
): Outcome {
	const dir = makeTempDirectory("atomic-load-on-demand-");
	dirs.push(dir);
	const installation = join(dir, "installation");
	const modules = options.owner === "user" ? join(dir, "user") : join(installation, "dist");
	mkdirSync(installation, { recursive: true });
	mkdirSync(modules, { recursive: true });
	const sources: Record<string, string> = {
		"earlier.mjs": "export const kept = 1;\n",
		"lacks-export.mjs": 'import { added } from "./earlier.mjs";\nexport const value = added;\n',
		"missing-package.mjs": 'import { pad } from "left-pad-not-installed-atomic";\nexport const value = pad;\n',
		"throws.mjs": 'throw new Error("evaluation failed");\n',
		"loads.mjs": 'import { kept } from "./earlier.mjs";\nexport const value = kept;\n',
	};
	for (const [name, source] of Object.entries(sources)) writeFileSync(join(modules, name), source);
	const script = join(dir, "session.mjs");
	writeFileSync(
		script,
		`import { rmSync, writeFileSync } from "node:fs";
const installation = ${JSON.stringify(installation)};
writeFileSync(installation + "/package.json", JSON.stringify({ name: "@bastani/atomic", version: "0.10.90" }));
const { loadOnDemand } = await import(${JSON.stringify(pathToFileURL(join(DIST, "utils/updated-install.js")).href)});
const { wrapToolDefinition } = await import(${JSON.stringify(pathToFileURL(join(DIST, "core/tools/tool-definition-wrapper.js")).href)});
await import(${JSON.stringify(pathToFileURL(join(modules, "earlier.mjs")).href)});
${
	change === "update"
		? 'writeFileSync(installation + "/package.json", JSON.stringify({ name: "@bastani/atomic", version: "0.10.91" }));'
		: change === "remove"
			? "rmSync(installation, { recursive: true });"
			: ""
}
const url = ${JSON.stringify(pathToFileURL(join(modules, `${module === "missing-file" ? "removed" : module}.mjs`)).href)};
const run = ${
			options.via === "tool"
				? `() => wrapToolDefinition({ name: "probe", label: "probe", description: "", parameters: {}, execute: async () => { await import(url); return { content: [], details: undefined }; } }).execute("call-1", {}, undefined, undefined)`
				: `() => loadOnDemand("the probe", () => import(url))`
		};
try {
	await run();
	process.stdout.write(JSON.stringify({ loaded: "yes" }));
} catch (error) {
	process.stdout.write(JSON.stringify({ name: error?.name, message: error?.message, cause: error?.cause?.code ?? error?.cause?.name }));
}
`,
	);
	const result = spawnSyncCollect([process.execPath, script], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: "", ATOMIC_PACKAGE_DIR: installation, PI_PACKAGE_DIR: "" },
		timeout: CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(result.stdout.toString()) as Outcome;
}

test(
	"a module that no longer links after an update says to restart, naming the feature",
	() => {
		const outcome = load("lacks-export", "update");
		assert.equal(outcome.name, "UpdatedInstallError");
		assert.equal(outcome.cause, "SyntaxError");
		const [first, ...rest] = (outcome.message ?? "").split("\n");
		assert.equal(
			first,
			"atomic was updated to 0.10.91 while this session was running; restart it to keep using the probe.",
		);
		assert.match(rest.join("\n"), /does not provide an export named 'added'/);
	},
	CHILD_TIMEOUT_MS,
);

test(
	"a module the update removed says to restart, naming the feature",
	() => {
		const outcome = load("missing-file", "update");
		assert.equal(outcome.name, "UpdatedInstallError");
		assert.equal(outcome.cause, "ERR_MODULE_NOT_FOUND");
		const [first, ...rest] = (outcome.message ?? "").split("\n");
		assert.equal(
			first,
			"atomic was updated to 0.10.91 while this session was running; restart it to keep using the probe.",
		);
		assert.match(rest.join("\n"), /Cannot find module .*removed\.mjs/);
	},
	CHILD_TIMEOUT_MS,
);

test(
	"a removed installation says so",
	() => {
		const outcome = load("missing-file", "remove");
		assert.equal(outcome.name, "UpdatedInstallError");
		assert.equal(outcome.cause, "ERR_MODULE_NOT_FOUND");
		const [first, ...rest] = (outcome.message ?? "").split("\n");
		assert.equal(
			first,
			"The atomic installation this session runs from was removed or replaced; restart it to keep using the probe.",
		);
		assert.match(rest.join("\n"), /Cannot find module .*removed\.mjs/);
	},
	CHILD_TIMEOUT_MS,
);

test(
	"without an update the runtime's own error stays",
	() => {
		const outcome = load("lacks-export", "none");
		assert.equal(outcome.name, "SyntaxError");
		assert.match(outcome.message ?? "", /does not provide an export named 'added'/);
	},
	CHILD_TIMEOUT_MS,
);

test(
	"an error of the loaded code itself stays its own after an update",
	() => {
		assert.deepEqual(load("throws", "update"), { name: "Error", message: "evaluation failed" });
	},
	CHILD_TIMEOUT_MS,
);

test(
	"code that loads after an update loads",
	() => {
		assert.deepEqual(load("loads", "update"), { loaded: "yes" });
	},
	CHILD_TIMEOUT_MS,
);

test(
	"a tool whose code no longer links after an update fails with the restart message",
	() => {
		const outcome = load("lacks-export", "update", { via: "tool" });
		assert.equal(outcome.name, "UpdatedInstallError");
		assert.equal(outcome.cause, "SyntaxError");
		const [first, ...rest] = (outcome.message ?? "").split("\n");
		assert.equal(
			first,
			"atomic was updated to 0.10.91 while this session was running; restart it to keep using the probe tool.",
		);
		assert.match(rest.join("\n"), /does not provide an export named 'added'/);
	},
	CHILD_TIMEOUT_MS,
);

test(
	"a module outside the installation keeps its own error after an update",
	() => {
		const missing = load("missing-package", "update", { owner: "user" });
		assert.equal(missing.name, "Error");
		assert.match(missing.message ?? "", /Cannot find package 'left-pad-not-installed-atomic'/);
		const unlinked = load("lacks-export", "update", { owner: "user" });
		assert.equal(unlinked.name, "SyntaxError");
		assert.match(unlinked.message ?? "", /does not provide an export named 'added'/);
	},
	CHILD_TIMEOUT_MS,
);

test(
	"a tool whose own dependency is missing keeps that error after an update",
	() => {
		const outcome = load("missing-package", "update", { via: "tool", owner: "user" });
		assert.equal(outcome.name, "Error");
		assert.match(outcome.message ?? "", /Cannot find package 'left-pad-not-installed-atomic'/);
	},
	CHILD_TIMEOUT_MS,
);

/** The error a user extension that imports a package that is not installed fails to load with, after an update. */
function userExtensionLoadError(): string {
	const dir = makeTempDirectory("atomic-load-on-demand-extension-");
	dirs.push(dir);
	const installation = join(dir, "installation");
	mkdirSync(installation);
	const extension = join(dir, "missing-dep.mjs");
	writeFileSync(
		extension,
		'import { pad } from "left-pad-not-installed-atomic";\nexport default function (pi) { void pi; void pad; }\n',
	);
	const script = join(dir, "session.mjs");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
const installation = ${JSON.stringify(installation)};
writeFileSync(installation + "/package.json", JSON.stringify({ name: "@bastani/atomic", version: "0.10.90" }));
const { loadExtensions } = await import(${JSON.stringify(pathToFileURL(join(DIST, "core/extensions/loader-core.js")).href)});
writeFileSync(installation + "/package.json", JSON.stringify({ name: "@bastani/atomic", version: "0.10.91" }));
const result = await loadExtensions([${JSON.stringify(extension)}], ${JSON.stringify(dir)}, undefined, undefined, undefined, undefined, ${JSON.stringify(join(dir, "agent"))});
process.stdout.write(JSON.stringify(result.errors.map((entry) => entry.error)));
process.exit(0);
`,
	);
	const result = spawnSyncCollect([process.execPath, script], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: "", ATOMIC_PACKAGE_DIR: installation, PI_PACKAGE_DIR: "", HOME: dir },
		timeout: CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const errors = JSON.parse(result.stdout.toString()) as string[];
	assert.equal(errors.length, 1, JSON.stringify(errors));
	return errors[0]!;
}

test(
	"a user extension whose dependency is missing fails to load with that error after an update",
	() => {
		const error = userExtensionLoadError();
		assert.match(error, /^Failed to load extension: Cannot find (?:module|package) 'left-pad-not-installed-atomic'/);
		assert.doesNotMatch(error, /restart it/);
	},
	CHILD_TIMEOUT_MS,
);
