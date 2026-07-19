import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.ts";

type PiAiExports = {
	complete?: object;
	getModel?: object;
	StringEnum?: object;
};

type OAuthCompatExports = {
	getOAuthApiKey?: object;
	getOAuthProvider?: object;
	getOAuthProviders?: object;
	registerOAuthProvider?: object;
	resetOAuthProviders?: object;
};

describe("extension loader pi-ai compat aliases", () => {
	it("keys root and compat specifiers to the same virtual module object", async () => {
		const modules = await extensionLoaderTestHooks.loadVirtualModules();

		expect(modules["@earendil-works/pi-ai"]).toBe(modules["@earendil-works/pi-ai/compat"]);
		expect(modules["@mariozechner/pi-ai"]).toBe(modules["@mariozechner/pi-ai/compat"]);
		expect(modules["@mariozechner/pi-ai"]).toBe(modules["@earendil-works/pi-ai/compat"]);

		const compat = modules["@earendil-works/pi-ai/compat"] as PiAiExports;
		expect(typeof compat.complete).toBe("function");
		expect(typeof compat.getModel).toBe("function");
		expect(typeof compat.StringEnum).toBe("function");
	});

	it("provides legacy OAuth runtime helpers through both extension aliases", async () => {
		const modules = await extensionLoaderTestHooks.loadVirtualModules();
		const earendil = modules["@earendil-works/pi-ai/oauth"] as OAuthCompatExports;
		const mario = modules["@mariozechner/pi-ai/oauth"] as OAuthCompatExports;

		expect(mario).toBe(earendil);
		for (const name of [
			"getOAuthApiKey",
			"getOAuthProvider",
			"getOAuthProviders",
			"registerOAuthProvider",
			"resetOAuthProviders",
		] as const) {
			expect(typeof earendil[name]).toBe("function");
		}
	});

	it("maps root and compat specifiers to the same jiti alias path", () => {
		const aliases = extensionLoaderTestHooks.getAliases();

		expect(aliases["@earendil-works/pi-ai"]).toBe(aliases["@earendil-works/pi-ai/compat"]);
		expect(aliases["@mariozechner/pi-ai"]).toBe(aliases["@mariozechner/pi-ai/compat"]);
		expect(aliases["@mariozechner/pi-ai"]).toBe(aliases["@earendil-works/pi-ai/compat"]);
	});

	it("maps both OAuth specifiers to Atomic's populated compatibility entry", () => {
		const aliases = extensionLoaderTestHooks.getAliases();
		expect(aliases["@mariozechner/pi-ai/oauth"]).toBe(aliases["@earendil-works/pi-ai/oauth"]);
		expect(aliases["@earendil-works/pi-ai/oauth"]).toMatch(/oauth-compat\.js$/);
	});

	it("confirms compat is the legacy API surface while root stays core-only", async () => {
		const root = (await import("@earendil-works/pi-ai")) as PiAiExports;
		const compat = (await import("@earendil-works/pi-ai/compat")) as PiAiExports;

		expect(root.complete).toBeUndefined();
		expect(root.getModel).toBeUndefined();
		expect(typeof root.StringEnum).toBe("function");
		expect(typeof compat.complete).toBe("function");
		expect(typeof compat.getModel).toBe("function");
		expect(compat.StringEnum).toBe(root.StringEnum);
	});
});

describe("extension loader package-root resolution", () => {
	it("locates a package root without consulting its exports map", () => {
		// Regression guard for #1600/#1609: pi-ai does not export
		// "./package.json", so require.resolve("<pkg>/package.json") throws
		// ERR_PACKAGE_PATH_NOT_EXPORTED under Node and broke every builtin
		// extension for npm installs. findPackageRoot must scan node_modules
		// directories directly, ignoring the exports map entirely.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-pkg-root-"));
		try {
			const packageRoot = path.join(tmp, "node_modules", "@scope", "esm-only");
			fs.mkdirSync(packageRoot, { recursive: true });
			fs.writeFileSync(
				path.join(packageRoot, "package.json"),
				JSON.stringify({
					name: "@scope/esm-only",
					version: "1.0.0",
					type: "module",
					exports: { ".": "./dist/index.js" },
				}),
			);

			const resolved = extensionLoaderTestHooks.findPackageRoot("@scope/esm-only", [
				path.join(tmp, "node_modules"),
			]);

			expect(resolved).toBe(packageRoot);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("resolves the real pi-ai package root from the loader's node_modules chain", () => {
		const root = extensionLoaderTestHooks.findPackageRoot("@earendil-works/pi-ai");

		expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
		expect(fs.existsSync(path.join(root, "dist", "compat.js"))).toBe(true);
		expect(fs.existsSync(path.join(root, "dist", "oauth.js"))).toBe(true);
	});

	it("throws a descriptive error for unknown packages", () => {
		expect(() => extensionLoaderTestHooks.findPackageRoot("@scope/definitely-missing", [])).toThrow(
			/Cannot locate package directory/,
		);
	});

	it("maps every alias to an existing file (installed-fallback contract)", () => {
		const aliases = extensionLoaderTestHooks.getAliases();

		for (const [specifier, target] of Object.entries(aliases)) {
			// When running from src/, the host-package alias uses the TypeScript
			// ESM convention (.js specifier resolved to the .ts source by jiti).
			const exists = fs.existsSync(target) || fs.existsSync(target.replace(/\.js$/, ".ts"));
			expect(exists, `alias ${specifier} -> ${target} does not exist`).toBe(true);
		}
	});

	it("creates the versioned jiti fsCache directory before extension imports", () => {
		const cacheDir = extensionLoaderTestHooks.getTranspileCacheDir();

		expect(fs.existsSync(cacheDir)).toBe(true);
		expect(fs.statSync(cacheDir).isDirectory()).toBe(true);
	});
});
