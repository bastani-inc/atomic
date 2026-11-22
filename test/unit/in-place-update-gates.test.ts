/**
 * The gates the build writes at the paths an earlier release imports on demand
 * (`packages/coding-agent/scripts/in-place-update-gate.mjs`): a process of an earlier release that imports one after an
 * in-place update gets the module's code when it loads there, and is told to restart when it cannot; any other process
 * gets the module's code or its own error. Each case runs in a process of its own, whose module loader holds what it
 * loaded before.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Node, parse } from "acorn";
import { ancestor } from "acorn-walk";
import { afterEach, describe, test } from "vitest";
import {
	CALL_SITE_GUARD,
	callSiteGuardSource,
	codePath,
	GATE_FILE_MARK,
	gateSource,
	moduleOfPath,
	RELEASE_MODULE_STUB,
	releaseVersionModules,
} from "../../packages/coding-agent/scripts/in-place-update-gate.mjs";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

/** One Node or Bun child process per case: structural, not a slow test. */
const CHILD_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

/** A release record whose processes all loaded `holder` (in `dist`), which names that release's version. */
const record = (version: string, holder: string) => ({
	version,
	packages: {
		"@bastani/atomic": {
			files: { [`dist/${holder}`]: ["APP_NAME", "VERSION"], "dist/index.js": ["APP_NAME", "VERSION"] },
			startup: [`dist/${holder}`],
			running: ["dist/index.js", `dist/${holder}`],
		},
	},
});

/** This build (2.0.0) writes `index.js` and `_shared/own.js`; 1.0.0's process held `_shared/old.js`, 1.5.0's `own.js`. */
const RECORDS = [record("1.0.0", "_shared/old.js"), record("1.5.0", "_shared/own.js")];
const BUILD_FILES = new Set(["index.js", "_shared/own.js"]);

interface Outcome {
	readonly message?: string;
	readonly cause?: string;
	readonly exported?: string;
	readonly defaultExport?: number;
	readonly implementationLoaded: boolean;
	readonly ownLoaded: boolean;
}

/**
 * A process that first loads what a process of `held` loaded (`{ "_shared/old.js": "1.0.0" }`: that file, of that
 * version), then has its installation updated to this build, then imports the gated `/export` module, whose code
 * fails as it loads there when `fails`.
 */
function importAfterUpdate(runtime: "node" | "bun", held: Record<string, string>, fails: boolean): Outcome {
	const dir = makeTempDirectory("atomic-in-place-gate-");
	dirs.push(dir);
	const dist = join(dir, "dist");
	const write = (path: string, contents: string) => {
		mkdirSync(dirname(join(dist, path)), { recursive: true });
		writeFileSync(join(dist, path), contents);
	};
	const holder = (version: string) =>
		`export const VERSION = ${JSON.stringify(version)};\nexport const APP_NAME = "atomic";\n`;
	for (const [path, version] of Object.entries(held)) write(path, holder(version));
	const { probes, stubs } = releaseVersionModules(RECORDS, (path: string) => BUILD_FILES.has(path));
	const update = [
		...stubs.map((path: string) => [path, RELEASE_MODULE_STUB]),
		["_shared/own.js", `globalThis.ownLoaded = true;\n${holder("2.0.0")}`],
		["index.js", `export * from "./_shared/own.js";\n`],
		[
			"core/export-html/index.js",
			gateSource({
				path: "core/export-html/index.js",
				code: "./index.code.js",
				exports: ["exportSessionToHtml", "default"],
				probes,
				version: "2.0.0",
			}),
		],
		[
			"core/export-html/index.code.js",
			fails
				? 'globalThis.implementationLoaded = true;\nthrow new Error("the update\'s code failed");\n'
				: 'globalThis.implementationLoaded = true;\nexport const exportSessionToHtml = () => "html";\nexport default 42;\n',
		],
	];
	const script = join(dir, "process.mjs");
	writeFileSync(
		script,
		[
			'import { mkdirSync, rmSync, writeFileSync } from "node:fs";',
			'import { dirname, join } from "node:path";',
			"const dist = process.argv[2];",
			`for (const path of ${JSON.stringify(Object.keys(held))}) await import(new URL("./dist/" + path, import.meta.url).href);`,
			// The update removes the files the build does not write, and writes its own.
			`for (const path of ${JSON.stringify(Object.keys(held))}) rmSync(join(dist, path));`,
			`for (const [path, contents] of ${JSON.stringify(update)}) {`,
			"\tmkdirSync(dirname(join(dist, path)), { recursive: true });",
			"\twriteFileSync(join(dist, path), contents);",
			"}",
			"const outcome = {};",
			"try {",
			'\tconst module = await import(new URL("./dist/core/export-html/index.js", import.meta.url).href);',
			"\toutcome.exported = module.exportSessionToHtml();",
			"\toutcome.defaultExport = module.default;",
			"} catch (error) {",
			"\toutcome.message = error.message;",
			"\tif (error.cause) outcome.cause = error.cause.message;",
			"}",
			"outcome.implementationLoaded = globalThis.implementationLoaded === true;",
			"outcome.ownLoaded = globalThis.ownLoaded === true;",
			"console.log(JSON.stringify(outcome));",
		].join("\n"),
	);
	const executable = runtime === "bun" ? bunExecutable() : process.execPath;
	const result = spawnSyncCollect([executable, script, dist], { cwd: dir, timeout: CHILD_TIMEOUT_MS });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Outcome;
}

const RESTART = "atomic was updated to 2.0.0 while this session was running; restart it to keep using session export.";

const LOADED = { exported: "html", defaultExport: 42, implementationLoaded: true };

describe.each(["node", "bun"] as const)("a gated module under %s", (runtime) => {
	test(
		"whose code fails in a process of an earlier release whose module the update removed says to restart, with the failure as its cause",
		() => {
			const outcome = importAfterUpdate(runtime, { "_shared/old.js": "1.0.0" }, true);
			assert.deepEqual(outcome, {
				message: RESTART,
				cause: "the update's code failed",
				implementationLoaded: true,
				ownLoaded: false,
			});
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"whose code fails in a process of an earlier release that holds a module at a path of this build's says to restart",
		() => {
			const outcome = importAfterUpdate(runtime, { "_shared/own.js": "1.5.0" }, true);
			assert.deepEqual(outcome, {
				message: RESTART,
				cause: "the update's code failed",
				implementationLoaded: true,
				ownLoaded: false,
			});
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"whose code loads in a process of an earlier release gives its exports, as before the gates",
		() => {
			const outcome = importAfterUpdate(runtime, { "_shared/old.js": "1.0.0" }, false);
			assert.deepEqual(outcome, { ...LOADED, ownLoaded: false });
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"whose code fails in a process of this build fails with its own error",
		() => {
			const outcome = importAfterUpdate(runtime, { "_shared/own.js": "2.0.0" }, true);
			assert.deepEqual(outcome, {
				message: "the update's code failed",
				implementationLoaded: true,
				ownLoaded: false,
			});
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"whose code loads asks nothing of the process: no release's module is loaded",
		() => {
			const outcome = importAfterUpdate(runtime, {}, false);
			assert.deepEqual(outcome, { ...LOADED, ownLoaded: false });
		},
		CHILD_TIMEOUT_MS,
	);
});

interface CallSiteOutcome {
	readonly message?: string;
	readonly cause?: string;
	readonly exported?: string;
	readonly ownLoaded: boolean;
}

/**
 * A process of this build (2.0.0), or with `held` one of an earlier release that loaded this build's caller after an
 * update, imports a module on demand through a guarded call site, as this build's own code does
 * (`import("./target.js").catch((error) => __atomicOnDemandFailed(error, "session export"))`), after the installation
 * on disk became release `installed` and the module's code became `target`.
 */
function callAfterUpdate(
	runtime: "node" | "bun",
	options: { held?: Record<string, string>; installed: string; target: "fails" | "loads" },
): CallSiteOutcome {
	const dir = makeTempDirectory("atomic-in-place-call-site-");
	dirs.push(dir);
	const dist = join(dir, "dist");
	mkdirSync(join(dist, "_shared"), { recursive: true });
	const holder = (version: string) =>
		`export const VERSION = ${JSON.stringify(version)};\nexport const APP_NAME = "atomic";\n`;
	const held = options.held ?? { "_shared/own.js": "2.0.0" };
	for (const [path, version] of Object.entries(held)) writeFileSync(join(dist, path), holder(version));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bastani/atomic", version: "2.0.0" }));
	const { probes, stubs } = releaseVersionModules(RECORDS, (path: string) => BUILD_FILES.has(path));
	for (const path of stubs) if (!(path in held)) writeFileSync(join(dist, path), RELEASE_MODULE_STUB);
	if (!("_shared/own.js" in held))
		writeFileSync(join(dist, "_shared/own.js"), `globalThis.ownLoaded = true;\n${holder("2.0.0")}`);
	writeFileSync(
		join(dist, "caller.js"),
		[
			`export const load = () => import("./target.js").catch((error) => ${CALL_SITE_GUARD}(error, "session export"));`,
			callSiteGuardSource({ root: "./", probes, version: "2.0.0", application: "atomic" }),
		].join("\n"),
	);
	const target =
		options.target === "fails"
			? 'throw new Error("the update\'s code failed");\n'
			: 'export const exportSessionToHtml = () => "html";\n';
	const script = join(dir, "process.mjs");
	writeFileSync(
		script,
		[
			'import { writeFileSync } from "node:fs";',
			`for (const path of ${JSON.stringify(Object.keys(held))}) await import(new URL("./dist/" + path, import.meta.url).href);`,
			'const { load } = await import(new URL("./dist/caller.js", import.meta.url).href);',
			// The update: the installation's release and the module's code.
			`writeFileSync(new URL("./package.json", import.meta.url), ${JSON.stringify(JSON.stringify({ name: "@bastani/atomic", version: options.installed }))});`,
			`writeFileSync(new URL("./dist/target.js", import.meta.url), ${JSON.stringify(target)});`,
			"const outcome = {};",
			"try {",
			"\toutcome.exported = (await load()).exportSessionToHtml();",
			"} catch (error) {",
			"\toutcome.message = error.message;",
			"\tif (error.cause) outcome.cause = error.cause.message;",
			"}",
			"outcome.ownLoaded = globalThis.ownLoaded === true;",
			"console.log(JSON.stringify(outcome));",
		].join("\n"),
	);
	const executable = runtime === "bun" ? bunExecutable() : process.execPath;
	const result = spawnSyncCollect([executable, script], { cwd: dir, timeout: CHILD_TIMEOUT_MS });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "{}") as CallSiteOutcome;
}

const restartedTo = (version: string) =>
	`atomic was updated to ${version} while this session was running; restart it to keep using session export.`;

describe.each(["node", "bun"] as const)("a guarded call site under %s", (runtime) => {
	test(
		"whose module fails after an update replaced the installation says to restart, with the failure as its cause",
		() => {
			assert.deepEqual(callAfterUpdate(runtime, { installed: "2.1.0", target: "fails" }), {
				message: restartedTo("2.1.0"),
				cause: "the update's code failed",
				ownLoaded: false,
			});
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"whose module loads after an update gives it, as before",
		() => {
			assert.deepEqual(callAfterUpdate(runtime, { installed: "2.1.0", target: "loads" }), {
				exported: "html",
				ownLoaded: false,
			});
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"whose module fails while the installation is its own release fails with the module's own error",
		() => {
			assert.deepEqual(callAfterUpdate(runtime, { installed: "2.0.0", target: "fails" }), {
				message: "the update's code failed",
				ownLoaded: false,
			});
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"of this build's code in a process of an earlier release says to restart when the module fails",
		() => {
			assert.deepEqual(
				callAfterUpdate(runtime, { held: { "_shared/old.js": "1.0.0" }, installed: "2.0.0", target: "fails" }),
				{ message: restartedTo("2.0.0"), cause: "the update's code failed", ownLoaded: false },
			);
		},
		CHILD_TIMEOUT_MS,
	);
});

describe("the modules that tell which release a process runs", () => {
	test("are the earlier releases' own files, as stubs where this build writes none, before this build's files", () => {
		assert.deepEqual(
			releaseVersionModules(RECORDS, (path: string) => BUILD_FILES.has(path)),
			{ probes: ["_shared/old.js", "_shared/own.js"], stubs: ["_shared/old.js"] },
		);
	});

	test("may be a file of this build for one release only: a second would load in a process holding the first", () => {
		assert.throws(
			() =>
				releaseVersionModules(
					[...RECORDS, record("1.6.0", "_shared/own2.js")],
					(path: string) => path === "_shared/own.js" || path === "_shared/own2.js" || path === "index.js",
				),
			/more than one recorded release tells its version only through a file this build writes/,
		);
	});

	test("maps an earlier release's path of a module's code back to the module", () => {
		assert.equal(moduleOfPath("core/export-html/index.impl.js"), "core/export-html/index.js");
		assert.equal(moduleOfPath(codePath("core/export-html/index.js")), "core/export-html/index.js");
		assert.equal(moduleOfPath("core/export-html/index.js"), "core/export-html/index.js");
	});
});

describe("the built package", () => {
	const root = join(moduleDir(import.meta.url), "..", "..");
	const dist = join(root, "packages", "coding-agent", "dist");
	/** Atomic's own packages, which an update replaces: the workspace packages the application depends on, and itself. */
	const ownPackages = (() => {
		const application = JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8")) as {
			name: string;
			dependencies: Record<string, string>;
		};
		const workspace = readdirSync(join(root, "packages"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => {
				try {
					return [
						(
							JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")) as {
								name: string;
							}
						).name,
					];
				} catch {
					return [];
				}
			});
		return new Set([application.name, ...workspace.filter((name) => name in application.dependencies)]);
	})();
	const packageOf = (specifier: string) =>
		specifier
			.split("/")
			.slice(0, specifier.startsWith("@") ? 2 : 1)
			.join("/");

	test("guards every import on demand of its own code and Atomic's packages at the call site", () => {
		assert.ok(ownPackages.has("@bastani/atomic-agent-core"), "the workspace names Atomic's packages");
		const unguarded: string[] = [];
		let guarded = 0;
		for (const file of readdirSync(dist, { recursive: true }).map(String)) {
			const path = file.split("\\").join("/");
			// The builtin extensions load through the extension loader, and the standalone binary bundles its entry's imports.
			if (!path.endsWith(".js") || path.startsWith("builtin/") || path.startsWith("bun/")) continue;
			const source = readFileSync(join(dist, path), "utf8");
			// A gate or stub is for a process of an earlier release, which imports it by its path.
			if (source.startsWith(GATE_FILE_MARK)) continue;
			ancestor(parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }), {
				ImportExpression(node: Node, _state: unknown, ancestors: Node[]) {
					const specifier = (node as Node & { source: { type: string; value?: unknown } }).source;
					if (specifier.type !== "Literal" || typeof specifier.value !== "string") return;
					const value = specifier.value;
					if (!value.startsWith("./") && !value.startsWith("../") && !ownPackages.has(packageOf(value))) return;
					const parent = ancestors.at(-2) as (Node & { property?: { name?: string } }) | undefined;
					const call = ancestors.at(-3) as (Node & { arguments?: Node[] }) | undefined;
					const handler = call?.arguments?.[0] ? source.slice(call.arguments[0].start, call.arguments[0].end) : "";
					if (
						parent?.type === "MemberExpression" &&
						parent.property?.name === "catch" &&
						handler.includes(`${CALL_SITE_GUARD}(error,`)
					)
						guarded++;
					else unguarded.push(`${path}: import(${JSON.stringify(value)})`);
				},
			});
		}
		assert.deepEqual(unguarded, []);
		assert.ok(guarded > 0);
	});
});
