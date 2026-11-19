import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	FORKED_PACKAGE_LEGACY_NAMES,
	FORKED_PACKAGE_WORKSPACE_DIRS,
} from "../src/core/extensions/forked-package-names.ts";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.ts";

const REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS = 120_000;

type PiAiExports = {
	complete?: object;
	getModel?: object;
	StringEnum?: object;
};
type PiTuiLayoutExports = {
	getScrollbarGeometry?: object;
	getScrollViewBox?: object;
	renderLayoutFrame?: object;
};

// Provider-owned OAuth is exposed through provider metadata; the removed global
// OAuth registration bridge is intentionally not part of extension aliases.

describe("extension loader pi-ai compat aliases", () => {
	it(
		"keys root and compat specifiers to the same virtual module object",
		async () => {
			const modules = await extensionLoaderTestHooks.loadVirtualModules();

			expect(modules["@bastani/atomic-ai"]).toBe(modules["@bastani/atomic-ai/compat"]);
			expect(modules["@mariozechner/pi-ai"]).toBe(modules["@mariozechner/pi-ai/compat"]);
			expect(modules["@mariozechner/pi-ai"]).toBe(modules["@bastani/atomic-ai/compat"]);

			const compat = modules["@bastani/atomic-ai/compat"] as PiAiExports;
			expect(typeof compat.complete).toBe("function");
			expect(typeof compat.getModel).toBe("function");
			expect(typeof compat.StringEnum).toBe("function");
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it("maps root and compat specifiers to the same jiti alias path", async () => {
		const aliases = await extensionLoaderTestHooks.getAliases();

		expect(aliases["@bastani/atomic-ai"]).toBe(aliases["@bastani/atomic-ai/compat"]);
		expect(aliases["@mariozechner/pi-ai"]).toBe(aliases["@mariozechner/pi-ai/compat"]);
		expect(aliases["@mariozechner/pi-ai"]).toBe(aliases["@bastani/atomic-ai/compat"]);
	});

	it("maps the Codex Responses API before the broad pi-ai compat alias", async () => {
		const aliases = await extensionLoaderTestHooks.getAliases();
		const target = aliases["@bastani/atomic-ai/api/openai-codex-responses"];

		expect(target).toMatch(/[\\/]dist[\\/]api[\\/]openai-codex-responses\.js$/);
		expect(fs.existsSync(target!)).toBe(true);
		expect(target).not.toBe(aliases["@bastani/atomic-ai"]);
	});

	it("maps the llama.cpp classifier API before the broad pi-ai compat alias", async () => {
		// The llama.cpp provider imports this subpath, and jiti re-evaluates host sources when a
		// loaded extension imports `@bastani/atomic`; without its own key it resolves as compat.js/api/...
		const aliases = await extensionLoaderTestHooks.getAliases();
		const target = aliases["@bastani/atomic-ai/api/llama-cpp-classify.lazy"];

		expect(target).toMatch(/[\\/]dist[\\/]api[\\/]llama-cpp-classify\.lazy\.js$/);
		expect(fs.existsSync(target!)).toBe(true);
		expect(target).not.toBe(aliases["@bastani/atomic-ai"]);
	});

	it("shares the image provider catalog with binary extensions (#4590)", async () => {
		const modules = await extensionLoaderTestHooks.loadVirtualModules();
		const providers = await import("@bastani/atomic-ai/providers/all");
		assert.equal(modules["@bastani/atomic-ai/providers/all"], providers);
	});

	it("registers provider environment helpers for binary extension imports", async () => {
		// #3129: binaries use virtual modules instead of the filesystem aliases.
		const modules = await extensionLoaderTestHooks.loadVirtualModules();
		const providerEnv = await import("@bastani/atomic-ai/utils/provider-env");
		assert.equal(modules["@bastani/atomic-ai/utils/provider-env"], providerEnv);
	});

	it(
		"loads provider environment helpers through transformed extension imports",
		async () => {
			// #3129: the broad pi-ai alias must not resolve this as compat.js/utils/provider-env.
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-provider-env-extension-"));
			try {
				const extensionPath = path.join(directory, "extension.ts");
				fs.writeFileSync(
					extensionPath,
					`
import { getProviderEnvValue } from "@bastani/atomic-ai/utils/provider-env";
if (getProviderEnvValue("ATOMIC_ALIAS_PROBE", { ATOMIC_ALIAS_PROBE: "scoped" }) !== "scoped") {
  throw new Error("extension lost the scoped provider environment");
}
export default function extension() {}
`,
				);
				const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(extensionPath);
				assert.equal(typeof factory, "function");
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it(
		"loads the lightweight models entry through transformed extension imports",
		async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-models-entry-extension-"));
			try {
				for (const [index, specifier] of [
					"@bastani/atomic-ai/models",
					"@bastani/pi-ai/models",
					"@earendil-works/pi-ai/models",
					"@mariozechner/pi-ai/models",
				].entries()) {
					const extensionPath = path.join(directory, `extension-${index}.ts`);
					fs.writeFileSync(
						extensionPath,
						`
import { createModels } from ${JSON.stringify(specifier)};
const models = createModels();
if (models.getProviders().length !== 0) throw new Error("models entry loaded implicit providers");
export default function extension() {}
`,
					);
					const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(extensionPath);
					assert.equal(typeof factory, "function");
				}
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it(
		"shares every forked package's host instance with an extension importing its new and legacy names (#5174)",
		async () => {
			// One export per forked package, imported under Atomic's name and each legacy pi name.
			const probes = [
				{
					export: "StringEnum",
					names: ["@bastani/atomic-ai", "@bastani/pi-ai", "@earendil-works/pi-ai", "@mariozechner/pi-ai"],
				},
				{ export: "Text", names: ["@bastani/atomic-tui", "@earendil-works/pi-tui", "@mariozechner/pi-tui"] },
				{
					export: "Agent",
					names: ["@bastani/atomic-agent-core", "@earendil-works/pi-agent-core", "@mariozechner/pi-agent-core"],
				},
				{ export: "toCodemodeIdentifier", names: ["@bastani/atomic-codemode", "@earendil-works/pi-codemode"] },
				{ export: "compile", names: ["@bastani/atomic-schema", "@earendil-works/pi-schema"] },
				{ export: "NOOP_TELEMETRY_CONTEXT", names: ["@bastani/atomic-telemetry", "@earendil-works/pi-telemetry"] },
			] as const;
			const imports = probes.flatMap((probe, probeIndex) =>
				probe.names.map((name, nameIndex) => ({
					local: `p${probeIndex}_${nameIndex}`,
					statement: `import { ${probe.export} as p${probeIndex}_${nameIndex} } from ${JSON.stringify(name)};`,
				})),
			);
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-forked-names-extension-"));
			try {
				const extensionPath = path.join(directory, "extension.ts");
				fs.writeFileSync(
					extensionPath,
					`${imports.map((entry) => entry.statement).join("\n")}
(globalThis as { forkedNamesProbe?: object }).forkedNamesProbe = { ${imports.map((entry) => entry.local).join(", ")} };
export default function extension() {}
`,
				);
				const probeHolder = globalThis as { forkedNamesProbe?: Record<string, object> };
				delete probeHolder.forkedNamesProbe;
				const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(extensionPath);
				assert.equal(typeof factory, "function");
				const imported = probeHolder.forkedNamesProbe;
				assert.ok(imported, "extension module exposes its imports");
				const modules = await extensionLoaderTestHooks.loadVirtualModules();
				for (const [probeIndex, probe] of probes.entries()) {
					const host = (modules[probe.names[0]] as Record<string, object>)[probe.export];
					assert.ok(host, `${probe.names[0]} exports ${probe.export}`);
					for (const [nameIndex, name] of probe.names.entries()) {
						assert.equal(imported[`p${probeIndex}_${nameIndex}`], host, `${name} resolves to the host instance`);
						assert.equal(modules[name], modules[probe.names[0]], `${name} is a host virtual module`);
					}
				}
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it(
		"resolves every exported subpath of every forked package, under each of its names, through jiti (#5174)",
		async () => {
			const packagesDir = path.resolve(import.meta.dirname, "../..");
			// A wildcard export is checked through one real module below its directory.
			const wildcardSamples: Record<string, string> = {
				"@bastani/atomic-ai/providers/*": "@bastani/atomic-ai/providers/openrouter",
				"@bastani/atomic-ai/api/*": "@bastani/atomic-ai/api/transform-messages",
				"@bastani/atomic-ai/utils/*": "@bastani/atomic-ai/utils/provider-env",
			};
			// Not loadable in Node: the Cloudflare entry imports `cloudflare:workers`, and the worker entry
			// installs a worker-thread message handler. Their aliases must still name the exported file.
			const aliasOnly = new Set(["@bastani/atomic-codemode/cloudflare", "@bastani/atomic-codemode/worker"]);
			const specifiers: string[] = [];
			for (const [name, legacyNames] of Object.entries(FORKED_PACKAGE_LEGACY_NAMES)) {
				const manifest = JSON.parse(
					fs.readFileSync(path.join(packagesDir, FORKED_PACKAGE_WORKSPACE_DIRS[name]!, "package.json"), "utf8"),
				) as { exports?: Record<string, object | string> };
				const subpaths = manifest.exports ? Object.keys(manifest.exports) : [".", "./dist/layout.js"];
				for (const subpath of subpaths) {
					if (subpath === "./package.json") continue;
					const declared = subpath === "." ? name : `${name}${subpath.slice(1)}`;
					const specifier = wildcardSamples[declared] ?? declared;
					assert.ok(!specifier.includes("*"), `${declared} needs a wildcard sample`);
					for (const prefix of [name, ...legacyNames]) specifiers.push(`${prefix}${specifier.slice(name.length)}`);
				}
			}
			const aliases = await extensionLoaderTestHooks.getAliases();
			const loadable = specifiers.filter((specifier) => {
				const canonical = Object.entries(FORKED_PACKAGE_LEGACY_NAMES).reduce(
					(value, [name, legacyNames]) =>
						legacyNames.reduce(
							(current, legacy) => current.replace(new RegExp(`^${legacy}(?=/|$)`), name),
							value,
						),
					specifier,
				);
				if (!aliasOnly.has(canonical)) return true;
				assert.ok(aliases[specifier], `${specifier} has a loader alias`);
				assert.ok(fs.existsSync(aliases[specifier]!), `${specifier} aliases an existing file`);
				return false;
			});
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-forked-subpaths-extension-"));
			try {
				const extensionPath = path.join(directory, "extension.ts");
				fs.writeFileSync(
					extensionPath,
					`${loadable.map((specifier, index) => `import * as m${index} from ${JSON.stringify(specifier)};`).join("\n")}
// Some entries, such as \`@bastani/atomic-ai/oauth\`, export types only: loading each one is the check.
export const loaded = [${loadable.map((_, index) => `m${index}`).join(", ")}];
export default function extension() {}
`,
				);
				const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(extensionPath);
				assert.equal(typeof factory, "function");
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it(
		"maps pi-tui layout helpers through both loader resolution paths",
		async () => {
			const specifiers = [
				"@bastani/atomic-tui/dist/layout.js",
				"@earendil-works/pi-tui/dist/layout.js",
				"@mariozechner/pi-tui/dist/layout.js",
			] as const;
			const aliases = await extensionLoaderTestHooks.getAliases();
			const modules = await extensionLoaderTestHooks.loadVirtualModules();
			for (const specifier of specifiers) {
				expect(aliases[specifier]).toMatch(/[\\/]layout\.js$/);
				expect(fs.existsSync(aliases[specifier]!)).toBe(true);
				const layout = modules[specifier] as PiTuiLayoutExports;
				expect(typeof layout.getScrollbarGeometry).toBe("function");
				expect(typeof layout.getScrollViewBox).toBe("function");
				expect(typeof layout.renderLayoutFrame).toBe("function");
			}
			expect(modules[specifiers[0]]).toBe(modules[specifiers[1]]);
			expect(modules[specifiers[0]]).toBe(modules[specifiers[2]]);
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it(
		"loads the widget layout-node module through both extension resolution paths",
		async () => {
			// PR #3022: a root pi-tui alias must not turn this subpath into index.js/dist/...
			const specifier = "@earendil-works/pi-tui/dist/layout-node.js";
			const native = await import("@bastani/atomic-tui/dist/layout-node.js");
			const aliases = await extensionLoaderTestHooks.getAliases();
			assert.match(aliases[specifier]!, /[\\/]dist[\\/]layout-node\.js$/);
			assert.equal(fs.existsSync(aliases[specifier]!), true);
			const modules = await extensionLoaderTestHooks.loadVirtualModules();
			assert.equal(modules[specifier], native);
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it(
		"maps the Cloudflare gateway binding transport through both loader resolution paths",
		async () => {
			// Re-exported from `@bastani/atomic`, so jiti-loaded extensions that import
			// the host entry reach this specifier; without its own alias key it falls
			// through to the compat/root prefix alias and fails to load.
			const specifiers = [
				"@bastani/atomic-ai/api/cloudflare-gateway-binding",
				"@mariozechner/pi-ai/api/cloudflare-gateway-binding",
			] as const;
			const aliases = await extensionLoaderTestHooks.getAliases();
			const modules = await extensionLoaderTestHooks.loadVirtualModules();
			for (const specifier of specifiers) {
				expect(aliases[specifier]).toMatch(/[\\/]cloudflare-gateway-binding\.js$/);
				expect(fs.existsSync(aliases[specifier]!)).toBe(true);
				const binding = modules[specifier] as { createGatewayBindingFetch?: object };
				expect(typeof binding.createGatewayBindingFetch).toBe("function");
			}
			expect(modules[specifiers[0]]).toBe(modules[specifiers[1]]);
		},
		REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
	);

	it("confirms compat is the legacy API surface while root stays core-only", async () => {
		const root = (await import("@bastani/atomic-ai")) as PiAiExports;
		const compat = (await import("@bastani/atomic-ai/compat")) as PiAiExports;

		expect(root.complete).toBeUndefined();
		expect(root.getModel).toBeUndefined();
		expect(typeof root.StringEnum).toBe("function");
		expect(typeof compat.complete).toBe("function");
		expect(typeof compat.getModel).toBe("function");
		expect(compat.StringEnum).toBe(root.StringEnum);
	});
});

describe("extension loader package-root resolution", () => {
	it("locates a package root without consulting its exports map", async () => {
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

			const resolved = await extensionLoaderTestHooks.findPackageRoot("@scope/esm-only", [
				path.join(tmp, "node_modules"),
			]);

			expect(resolved).toBe(packageRoot);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("resolves the real pi-ai package root from the loader's node_modules chain", async () => {
		const root = await extensionLoaderTestHooks.findPackageRoot("@bastani/atomic-ai");

		expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
		expect(fs.existsSync(path.join(root, "dist", "compat.js"))).toBe(true);
		expect(fs.existsSync(path.join(root, "dist", "oauth.js"))).toBe(true);
	});

	it("throws a descriptive error for unknown packages", async () => {
		await expect(extensionLoaderTestHooks.findPackageRoot("@scope/definitely-missing", [])).rejects.toThrow(
			/Cannot locate package directory/,
		);
	});

	it("maps every alias to an existing file (installed-fallback contract)", async () => {
		const aliases = await extensionLoaderTestHooks.getAliases();

		for (const [specifier, target] of Object.entries(aliases)) {
			// When running from src/, the host-package alias uses the TypeScript
			// ESM convention (.js specifier resolved to the .ts source by jiti).
			const exists = fs.existsSync(target) || fs.existsSync(target.replace(/\.js$/, ".ts"));
			expect(exists, `alias ${specifier} -> ${target} does not exist`).toBe(true);
		}
	});

	it("creates the versioned jiti fsCache directory before extension imports", async () => {
		const cacheDir = await extensionLoaderTestHooks.getTranspileCacheDir();

		expect(fs.existsSync(cacheDir)).toBe(true);
		expect(fs.statSync(cacheDir).isDirectory()).toBe(true);
	});
});
