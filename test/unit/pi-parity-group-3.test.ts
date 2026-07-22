import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";
import { parseConfigCommand } from "../../packages/coding-agent/src/config-command-parser.ts";
import { applyHttpProxySettings, parseHttpIdleTimeoutMs } from "../../packages/coding-agent/src/core/http-dispatcher.ts";
import { loadCustomModelsFromPaths } from "../../packages/coding-agent/src/core/model-registry-custom-loader.ts";
import { DefaultPackageManager } from "../../packages/coding-agent/src/core/package-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { buildSelfUpdatePlan } from "../../packages/coding-agent/src/self-update-plan.ts";

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-group3-"));
	tempDirs.push(dir);
	return dir;
}

describe("HTTP settings parity", () => {
	test("accepts numeric strings and case-insensitive disabled values", () => {
		assert.equal(parseHttpIdleTimeoutMs(" 1250 "), 1250);
		assert.equal(parseHttpIdleTimeoutMs("DISABLED"), 0);
		assert.equal(parseHttpIdleTimeoutMs(1.9), 1);
		for (const invalid of ["", "nope", -1, Number.NaN, null]) assert.equal(parseHttpIdleTimeoutMs(invalid), undefined);
	});

	test("proxy settings trim values, preserve environment precedence, and ignore blanks", () => {
		const oldHttp = process.env.HTTP_PROXY;
		const oldHttps = process.env.HTTPS_PROXY;
		try {
			delete process.env.HTTP_PROXY;
			process.env.HTTPS_PROXY = "https://environment.example";
			applyHttpProxySettings("  http://settings.example  ");
			assert.equal(process.env.HTTP_PROXY, "http://settings.example");
			assert.equal(process.env.HTTPS_PROXY, "https://environment.example");
			delete process.env.HTTP_PROXY;
			applyHttpProxySettings("   ");
			assert.equal(process.env.HTTP_PROXY, undefined);
		} finally {
			if (oldHttp === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldHttp;
			if (oldHttps === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldHttps;
		}
	});
});

test("models.json preserves deferredToolsMode and constructs configured Radius providers", async () => {
	const dir = await tempDir();
	const path = join(dir, "models.json");
	await writeFile(path, JSON.stringify({ providers: {
		kimi: {
			baseUrl: "https://kimi.example/v1", apiKey: "key", api: "openai-completions",
			compat: { deferredToolsMode: "kimi" },
			models: [{ id: "moonshot" }],
		},
		corporate: { name: "Corporate Radius", baseUrl: "https://radius.example/v1", oauth: "radius" },
	} }));
	const loaded = loadCustomModelsFromPaths([path]);
	assert.equal(loaded.error, undefined);
	const compat = loaded.models.find((model) => model.provider === "kimi")?.compat as OpenAICompletionsCompat | undefined;
	assert.equal(compat?.deferredToolsMode, "kimi");
	const radius = loaded.configuredProviders.get("corporate");
	assert.equal(radius?.id, "corporate");
	assert.equal(radius?.name, "Corporate Radius");
	assert.equal(loaded.overrides.get("corporate")?.baseUrl, undefined);
});

test("project autoload:false is a delta over a global package including workflows", async () => {
	const root = await tempDir();
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const pkg = join(root, "package");
	await mkdir(join(cwd, ".atomic"), { recursive: true });
	await mkdir(join(pkg, "workflows"), { recursive: true });
	await mkdir(join(pkg, "extensions"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "delta-package" }));
	await writeFile(join(pkg, "workflows", "selected.ts"), "export default {}\n");
	await writeFile(join(pkg, "workflows", "other.ts"), "export default {}\n");
	await writeFile(join(pkg, "extensions", "index.ts"), "export default () => {}\n");
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
	await writeFile(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [{ source: pkg, autoload: false, workflows: ["+workflows/selected.ts"] }] }));
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resolved = await new DefaultPackageManager({ cwd, agentDir, settingsManager: manager }).resolve();
	const selected = resolved.workflows.find((entry) => entry.path.endsWith("selected.ts"));
	assert.equal(selected?.metadata.scope, "project");
	assert.ok(resolved.workflows.some((entry) => entry.path.endsWith("other.ts") && entry.metadata.scope === "user"));
	assert.ok(resolved.extensions.some((entry) => entry.path.endsWith("index.ts") && entry.metadata.scope === "user"));
});

test("config parser supports local/trust/help and rejects extra arguments", () => {
	assert.deepEqual(parseConfigCommand(["config", "-l", "--approve"]), { local: true, help: false, projectTrustOverride: true });
	assert.equal(parseConfigCommand(["config", "--help"])?.help, true);
	assert.equal(parseConfigCommand(["config", "--wat"])?.invalidOption, "--wat");
	assert.equal(parseConfigCommand(["config", "extra"])?.invalidArgument, "extra");
	assert.equal(parseConfigCommand(["list"]), undefined);
});

test("self-update plans pin the selected package and version and retain notes", () => {
	const plan = buildSelfUpdatePlan({ version: "99.1.2", packageName: "@bastani/atomic-next", note: "**Migrate** first" });
	assert.equal(plan.installSpec, "@bastani/atomic-next@99.1.2");
	assert.equal(plan.version, "99.1.2");
	assert.equal(plan.note, "**Migrate** first");
	assert.equal(plan.shouldRun, true);
});
