import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBuiltinPackagePaths } from "../src/core/builtin-packages.ts";
import { extensionsCanDecideProjectTrust } from "../src/core/project-trust-electorate.ts";
import { projectTrustedBeforeExtensions } from "../src/core/project-trust-state.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
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
