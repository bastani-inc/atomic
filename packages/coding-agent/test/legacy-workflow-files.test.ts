import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness } from "./suite/harness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

test("a large recipe inventory stays bounded in the parent's prompt and is not passed to children", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-recipe-count-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd);
	for (let i = 0; i < 23; i++) put(join(agentDir, "workflows", `recipe-${i}.js`), "export default {};");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true });
	await resourceLoader.reload();
	const parent = await createHarness({ cwd, resourceLoader, settingsManager });
	try {
		assert.equal(parent.session.systemPrompt.match(/recipe-\d+\.js/g)?.length, 20);
		assert.match(parent.session.systemPrompt, /\+3 more/);
	} finally {
		await parent.cleanup();
	}
	const child = await createHarness({
		cwd,
		resourceLoader,
		settingsManager,
		subagentPolicy: {
			depth: 1,
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: true,
			inheritSkills: true,
		},
	});
	try {
		assert.doesNotMatch(child.session.systemPrompt, /<legacy_workflow_files>|recipe-\d+\.js/);
	} finally {
		await child.cleanup();
	}
});

test("helpers, old run artifacts, and declined projects do not advertise runnable recipes", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-recipe-trust-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const borrowed = join(root, "borrowed");
	put(join(agentDir, "workflows", "lib", "helper.ts"), "not a workflow entry point");
	put(join(agentDir, "workflows", "runs", "old-run", "script.js"), "old artifact");
	put(join(cwd, ".atomic", "workflows", "declined-project.ts"), "untrusted");
	put(join(borrowed, ".atomic", "workflows", "declined-borrowed.ts"), "untrusted");
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [borrowed],
	});
	await resourceLoader.reload(); // No borrowed-source trust decision has been made.
	assert.equal(resourceLoader.getLegacyWorkflowFiles()?.total, 0);
	await resourceLoader.reload({ resolveBorrowedProjectTrust: () => false });
	const harness = await createHarness({ cwd, resourceLoader, settingsManager });
	try {
		assert.equal(resourceLoader.getLegacyWorkflowFiles()?.total, 0);
		assert.doesNotMatch(harness.session.systemPrompt, /<legacy_workflow_files>/);
	} finally {
		await harness.cleanup();
	}
});

test("a parent can locate project, user and package workflow recipes without executing them", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-recipes-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const pkg = join(root, "package");
	const piPkg = join(root, "pi-package");
	const conventionPkg = join(root, "convention-package");
	const borrowed = join(root, "borrowed");
	const recipes = [
		join(cwd, ".atomic", "workflows", "check.ts"),
		join(cwd, ".pi", "workflows", "report.js"),
		join(agentDir, "workflows", "triage.mjs"),
		join(pkg, "recipes", "publish.cjs"),
		join(piPkg, "custom", "review.ts"),
		join(conventionPkg, "workflows", "verify.ts"),
		join(agentDir, "custom", "user.ts"),
		join(cwd, ".atomic", "custom", "project.ts"),
		join(borrowed, ".atomic", "workflows", "inspect.ts"),
	];
	const marker = join(root, "executed");
	for (const path of recipes) put(path, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`);
	put(join(pkg, "package.json"), JSON.stringify({ atomic: { workflows: ["recipes/publish.cjs"] } }));
	put(join(piPkg, "package.json"), JSON.stringify({ pi: { workflows: ["custom/review.ts"] } }));
	put(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [pkg, piPkg, conventionPkg], workflows: ["custom/user.ts"] }),
	);
	put(join(cwd, ".atomic", "settings.json"), JSON.stringify({ workflows: { paths: ["custom/project.ts"] } }));
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [borrowed],
	});
	await resourceLoader.reload({ resolveBorrowedProjectTrust: () => true });
	const harness = await createHarness({ cwd, resourceLoader, settingsManager });
	try {
		const prompt = harness.session.systemPrompt;
		assert.match(prompt, /<legacy_workflow_files>/);
		for (const path of recipes) assert.ok(prompt.includes(JSON.stringify(path)), path);
		assert.ok(!prompt.includes("writeFileSync"));
		assert.equal(existsSync(marker), false);
	} finally {
		await harness.cleanup();
	}
});
