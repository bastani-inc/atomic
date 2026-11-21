import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBuiltinPackagePaths } from "../src/core/builtin-packages.ts";
import type { InlineExtension, LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { engineExtensionsCanDecide, extensionsCanDecideProjectTrust } from "../src/core/project-trust-electorate.ts";
import { projectTrustedBeforeExtensions } from "../src/core/project-trust-state.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { prepareDefaultResourceLoaderReload } from "../src/core/resource-loader-reload.ts";
import { projectSettingsChooseSessionStorage, sessionStorageSettingsDiffer } from "../src/core/session-storage.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.ts";

// Loading every bundled package is a structural cost of the builtin check.
const BUILTIN_LOAD_TIMEOUT_MS = 120_000;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-trust-before-extensions-")));
	roots.push(root);
	return root;
}

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

describe("project trust before any extension runs (#5693)", () => {
	const decide = (overrides: Partial<Parameters<typeof projectTrustedBeforeExtensions>[0]>) =>
		projectTrustedBeforeExtensions({
			override: undefined,
			hasTrustInputs: true,
			saved: true,
			defaultProjectTrust: "ask",
			extensionsCanDecide: false,
			...overrides,
		});

	it("trusts a saved Trust only when no extension could answer project_trust ahead of it (#5693)", () => {
		expect(decide({})).toBe(true);
		expect(decide({ extensionsCanDecide: true })).toBe(false);
		expect(decide({ saved: null, defaultProjectTrust: "always" })).toBe(true);
		expect(decide({ saved: null, defaultProjectTrust: "always", extensionsCanDecide: true })).toBe(false);
		expect(decide({ saved: null })).toBe(false);
		expect(decide({ saved: false })).toBe(false);
		expect(decide({ override: true, extensionsCanDecide: true })).toBe(true);
		expect(decide({ override: false })).toBe(false);
		expect(decide({ hasTrustInputs: false, saved: null, extensionsCanDecide: true })).toBe(true);
	});

	it("counts every extension source that loads before the decision, and nothing else (#5693)", async () => {
		const agentDir = join(tempRoot(), "agent");
		mkdirSync(agentDir, { recursive: true });
		const electorate = (overrides: Partial<Parameters<typeof extensionsCanDecideProjectTrust>[0]>) =>
			extensionsCanDecideProjectTrust({
				cliExtensionPaths: undefined,
				sdkExtensionFactoryCount: 0,
				customBuiltinPackagePaths: undefined,
				noExtensions: false,
				globalExtensions: undefined,
				globalPackages: undefined,
				agentDir,
				...overrides,
			});
		expect(await electorate({})).toBe(false);
		write(join(agentDir, "extensions", "README.md"), "notes");
		write(join(agentDir, "extensions", ".hidden.ts"), "export default function() {}");
		expect(await electorate({})).toBe(false);
		expect(await electorate({ globalExtensions: ["!builtin:llama.cpp"] })).toBe(false);
		expect(await electorate({ cliExtensionPaths: ["./policy.ts"] })).toBe(true);
		expect(await electorate({ sdkExtensionFactoryCount: 1 })).toBe(true);
		expect(await electorate({ customBuiltinPackagePaths: ["/packages/policy"] })).toBe(true);
		expect(await electorate({ globalPackages: ["npm:policy"] })).toBe(true);
		expect(await electorate({ globalPackages: ["npm:policy"], noExtensions: true })).toBe(false);
		expect(await electorate({ globalExtensions: ["~/policy.ts"] })).toBe(true);
		write(join(agentDir, "extensions", "policy.ts"), "export default function() {}");
		expect(await electorate({})).toBe(true);
		expect(await electorate({ noExtensions: true })).toBe(false);
	});

	it("an engine decides with what its host found for the folder, and checks itself when the host sent nothing", async () => {
		const cwd = tempRoot();
		let checks = 0;
		const check = async () => {
			checks += 1;
			return true;
		};
		expect(await engineExtensionsCanDecide({ cwd, extensionsCanDecide: false }, cwd, check)).toBe(false);
		expect(await engineExtensionsCanDecide({ cwd, extensionsCanDecide: true }, cwd, check)).toBe(true);
		expect(checks).toBe(0);
		// An older host sends nothing; a restarted engine in another folder is not what the host checked for.
		expect(await engineExtensionsCanDecide(undefined, cwd, check)).toBe(true);
		expect(await engineExtensionsCanDecide({ cwd: join(cwd, "other"), extensionsCanDecide: false }, cwd, check)).toBe(
			true,
		);
		expect(checks).toBe(2);
	});

	describe("the extensions that load before the decision", () => {
		/** A folder whose user extension answers project_trust, one bundled package and named inline factories. */
		const fixture = () => {
			const root = tempRoot();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			const bundled = join(root, "bundled");
			const loaded: string[] = [];
			mkdirSync(cwd, { recursive: true });
			write(
				join(agentDir, "extensions", "policy.ts"),
				"export default function(pi) { pi.on('project_trust', () => ({ trusted: 'no' })); }",
			);
			write(
				join(bundled, "package.json"),
				JSON.stringify({ name: "bundled", atomic: { extensions: ["./index.ts"] } }),
			);
			write(join(bundled, "index.ts"), "export default function() {}");
			linkSharedTranspileCache(agentDir);
			const inline = (name: string, bundledMark: boolean): InlineExtension => ({
				name,
				bundled: bundledMark,
				factory: (pi) => {
					loaded.push(name);
					pi.registerCommand(`${name}-${loaded.length}`, { handler: async () => {} });
				},
			});
			const load = async (preTrustExtensions: "bundled" | "voters") => {
				const loader = new DefaultResourceLoader({
					cwd,
					agentDir,
					builtinPackagePaths: [bundled],
					extensionFactories: [inline("twin", true), inline("sdk", false), inline("twin", true)],
				});
				let electorate: string[] = [];
				const complete = await prepareDefaultResourceLoaderReload(loader, {
					preTrustExtensions,
					resolveProjectTrust: ({ extensionsResult }: { extensionsResult: LoadExtensionsResult }) => {
						electorate = extensionsResult.extensions.map((extension) => extension.path);
						return true;
					},
				});
				const atDecision = [...loaded];
				await complete();
				return {
					electorate,
					atDecision,
					// Atomic's built-in factories load by name in the final set; they are not part of this choice.
					final: loader
						.getExtensions()
						.extensions.map((extension) => extension.path)
						.filter((path) => !path.startsWith("builtin:")),
					commands: loader
						.getExtensions()
						.extensions.filter((extension) => extension.path.startsWith("<inline:"))
						.flatMap((extension) => [...extension.commands.keys()]),
				};
			};
			return { load };
		};
		const name = (path: string) => path.replace(/\\/g, "/").split("/").slice(-2).join("/");

		it("are only the bundled ones after a startup check that found no other, and the rest load after it", async () => {
			const { load } = fixture();
			const { electorate, final } = await load("bundled");
			expect(electorate.map(name)).toEqual(["bundled/index.ts", "<inline:twin>", "<inline:sdk>", "<inline:twin>"]);
			expect(final.map(name)).toContain("extensions/policy.ts");
		});

		it("leave out the bundled ones for a decision made before its session opens, which load after it in their places", async () => {
			const { load } = fixture();
			const { electorate, atDecision, final, commands } = await load("voters");
			expect(electorate.map(name)).toEqual(["extensions/policy.ts", "<inline:sdk>"]);
			expect(atDecision).toEqual(["sdk"]);
			expect(final.map(name)).toEqual([
				"extensions/policy.ts",
				"bundled/index.ts",
				"<inline:twin>",
				"<inline:sdk>",
				"<inline:twin>",
			]);
			// Each factory ran once, so two inline extensions with one name stay two.
			expect(commands).toEqual(["twin-2", "sdk-1", "twin-3"]);
		});
	});

	it(
		"Atomic's own extensions and bundled packages register no project_trust handler (#5693)",
		async () => {
			const root = tempRoot();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			linkSharedTranspileCache(agentDir);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				builtinPackagePaths: getBuiltinPackagePaths(),
				extensionFactories: builtInExtensions,
			});
			await loader.reload();
			const extensions = loader.getExtensions().extensions;
			expect(extensions.length).toBeGreaterThan(builtInExtensions.length);
			expect(
				extensions
					.filter((extension) => (extension.handlers.get("project_trust")?.length ?? 0) > 0)
					.map((e) => e.path),
			).toEqual([]);
		},
		BUILTIN_LOAD_TIMEOUT_MS,
	);

	it("compares the store a folder's settings choose with the global one as written, without resolving it (#5693)", () => {
		const global = { sessions: { storage: { dir: "/stores/global" } } };
		expect(sessionStorageSettingsDiffer(global, [])).toBe(false);
		expect(sessionStorageSettingsDiffer(global, [{ theme: "light", sessions: {} }])).toBe(false);
		expect(sessionStorageSettingsDiffer({}, [{ sessions: {} }])).toBe(false);
		expect(sessionStorageSettingsDiffer(global, [{ sessions: { storage: { dir: "/stores/global" } } }])).toBe(false);
		expect(sessionStorageSettingsDiffer(global, [{ sessions: { storage: { dir: "/stores/project" } } }])).toBe(true);
		expect(sessionStorageSettingsDiffer({}, [{ storage: { memory: true } }])).toBe(true);
		// The .atomic layer is higher than the legacy .pi one.
		expect(
			sessionStorageSettingsDiffer(global, [
				{ sessions: { storage: { dir: "/stores/global" } } },
				{ sessions: { storage: { dir: "/stores/project" } } },
			]),
		).toBe(false);
		expect(sessionStorageSettingsDiffer(global, [{}, { sessions: { storage: { dir: "/stores/project" } } }])).toBe(
			true,
		);
	});

	it("reads the folder's settings files as plain JSON, and an unreadable one counts as a different store (#5693)", () => {
		const root = tempRoot();
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const global = { sessions: { storage: { dir: join(root, "global-sessions") } } };
		expect(projectSettingsChooseSessionStorage(cwd, global)).toBe(false);
		write(join(cwd, ".atomic", "settings.json"), JSON.stringify({ sessions: {} }));
		expect(projectSettingsChooseSessionStorage(cwd, global)).toBe(false);
		write(join(cwd, ".pi", "settings.json"), JSON.stringify({ storage: { memory: true } }));
		expect(projectSettingsChooseSessionStorage(cwd, global)).toBe(true);
		write(join(cwd, ".pi", "settings.json"), "{ not json");
		expect(projectSettingsChooseSessionStorage(cwd, global)).toBe(true);
	});
});
