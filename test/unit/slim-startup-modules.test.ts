import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const DIST = join(ROOT, "packages/coding-agent/dist");
const CHILD_TIMEOUT_MS = 60_000;
const builtTest = existsSync(join(DIST, "main.js")) ? test : test.skip;

interface LoadAudit {
	readonly urls: string[];
	readonly byPackage: Record<string, number>;
}

function auditDistImport(entries: readonly string[], extraCode = ""): { audit: LoadAudit; extra: unknown } {
	const script = `import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const urls = [];
const byPackage = {};
registerHooks({
	load(url, ctx, next) {
		if (url.startsWith("file:")) {
			urls.push(url);
			const m = url.match(/node_modules\\/((?:@[^/]+\\/)?[^/]+)/);
			const pkg = m ? m[1] : "@bastani/atomic";
			byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
		}
		return next(url, ctx);
	},
});
const mods = [];
for (const rel of ${JSON.stringify(entries)}) {
	mods.push(await import(pathToFileURL(${JSON.stringify(DIST)} + "/" + rel).href));
}
const extra = await (async () => { ${extraCode} })();
console.log(JSON.stringify({ audit: { urls, byPackage }, extra }));
`;
	const result = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], {
		cwd: ROOT,
		env: { ...process.env, NODE_OPTIONS: "" },
		timeout: CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(result.stdout.toString()) as { audit: LoadAudit; extra: unknown };
}

builtTest(
	"startup-shell and main.js load zero highlight.js files and zero external undici files at startup",
	() => {
		const { audit: shellAudit } = auditDistImport(["modes/interactive/startup-shell.js"]);
		assert.equal(
			shellAudit.byPackage["highlight.js"] ?? 0,
			0,
			`startup-shell must not load highlight.js: ${JSON.stringify(shellAudit.byPackage)}`,
		);

		const { audit: httpAudit } = auditDistImport(
			["core/http-dispatcher.js"],
			`mods[0].configureHttpDispatcher(); return typeof globalThis.fetch;`,
		);
		assert.equal(
			httpAudit.byPackage.undici ?? 0,
			0,
			`http-dispatcher must load undici from bundled shared file instead of node_modules: ${JSON.stringify(httpAudit.byPackage)}`,
		);

		const { audit: mainAudit } = auditDistImport(["main.js"]);
		assert.equal(mainAudit.byPackage["highlight.js"] ?? 0, 0, "main.js must not eagerly load highlight.js");
		assert.equal(mainAudit.byPackage.undici ?? 0, 0, "main.js must not load external undici files");
		assert.equal(
			mainAudit.urls.some((u) => u.endsWith("/dist/modes/interactive/interactive-mode.js")),
			false,
			"main.js must load interactive-mode dynamically",
		);
		assert.equal(
			mainAudit.urls.some((u) => u.endsWith("/dist/modes/rpc/rpc-mode.js")),
			false,
			"main.js must load rpc-mode dynamically",
		);
		assert.equal(
			mainAudit.urls.some((u) => u.endsWith("/dist/package-manager-cli.js")),
			false,
			"main.js must load package-manager-cli dynamically",
		);
		assert.equal(
			mainAudit.urls.some((u) => u.endsWith("/dist/core/tools/read-url.js")),
			false,
			"main.js must load read-url (domino/turndown) dynamically",
		);
	},
	CHILD_TIMEOUT_MS,
);

builtTest(
	"highlightCode lazily loads highlight.js synchronously on first call, shares external hljs registrations, and preserves pre-registered overrides",
	() => {
		const { extra } = auditDistImport(
			["index.js"],
			`const { highlightCode, initTheme } = mods[0];
			initTheme("dark");
			const hljs = (await import("highlight.js/lib/core.js")).default;
			hljs.registerLanguage("w9-custom-lang", () => ({ keywords: "magicword" }));
			hljs.registerLanguage("python", () => ({ keywords: "overrideword" }));
			const tsLines = highlightCode("const x = 1;", "typescript");
			const customLines = highlightCode("magicword", "w9-custom-lang");
			const overrideLines = highlightCode("overrideword", "python");
			return {
				tsColored: tsLines.join("\\n").includes("\\x1b["),
				customColored: customLines.join("\\n").includes("\\x1b["),
				overrideColored: overrideLines.join("\\n").includes("\\x1b["),
			};`,
		);
		assert.deepEqual(extra, { tsColored: true, customColored: true, overrideColored: true });
	},
	CHILD_TIMEOUT_MS,
);

builtTest(
	"configureHttpDispatcher and bun dist/cli.js keep Bun's wrapped fetch instead of replacing it with npm undici",
	() => {
		const script = `import { pathToFileURL } from "node:url";
const origFetch = globalThis.fetch;
const { configureHttpDispatcher } = await import(pathToFileURL(${JSON.stringify(join(DIST, "core/http-dispatcher.js"))}).href);
configureHttpDispatcher(12345);
console.log(JSON.stringify({ changed: globalThis.fetch !== origFetch, isFunction: typeof globalThis.fetch === "function" }));
`;
		const result = spawnSyncCollect([bunExecutable(), "-e", script], {
			cwd: ROOT,
			env: { ...process.env, NODE_OPTIONS: "" },
			timeout: CHILD_TIMEOUT_MS,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString()), { changed: true, isFunction: true });

		const cliVersion = spawnSyncCollect([bunExecutable(), join(DIST, "cli.js"), "--version"], {
			cwd: ROOT,
			env: { ...process.env, NODE_OPTIONS: "" },
			timeout: CHILD_TIMEOUT_MS,
		});
		assert.equal(cliVersion.exitCode, 0, cliVersion.stderr.toString());
	},
	CHILD_TIMEOUT_MS,
);

builtTest("dist/startup-files.json omits external undici and highlight.js while covering dynamic mode entries", () => {
	const list = JSON.parse(readFileSync(join(DIST, "startup-files.json"), "utf8")) as {
		packages: [string, number][];
		files: [number, string][];
	};
	const names = new Set(list.packages.map(([name]) => name));
	assert.equal(names.has("undici"), false, "startup-files.json must not list external undici");
	assert.equal(names.has("highlight.js"), false, "startup-files.json must not list highlight.js");
	const ownFiles = new Set(
		list.files.filter(([index]) => list.packages[index]?.[0] === "@bastani/atomic").map(([, file]) => file),
	);
	assert.ok(
		ownFiles.has("dist/modes/interactive/interactive-mode.js"),
		"startup-files.json must cover dynamic interactive-mode.js",
	);
	assert.ok(ownFiles.has("dist/modes/rpc/rpc-mode.js"), "startup-files.json must cover dynamic rpc-mode.js");
	const notices = readFileSync(join(DIST, "THIRD_PARTY_NOTICES.md"), "utf8");
	assert.match(notices, /^## undici /m, "THIRD_PARTY_NOTICES.md must include undici license");
});
