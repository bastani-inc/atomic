import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { loadConfigFile } from "../../packages/workflows/src/extension/config-file-loader.js";
import { loadWorkflowConfig, withWorkflowDefaults } from "../../packages/workflows/src/extension/config-loader.js";

describe("workflow environment config", () => {
	test("applies environment duration defaults only when an environment is configured", () => {
		assert.equal(withWorkflowDefaults({}).environment, undefined);

		assert.deepEqual(
			withWorkflowDefaults({
				environment: {
					deployment: "https://coder.example.com",
					templates: { "dev-large": { preset: "standard" } },
					defaultTemplate: "dev-large",
				},
			}).environment,
			{
				deployment: "https://coder.example.com",
				templates: { "dev-large": { preset: "standard" } },
				defaultTemplate: "dev-large",
				idleMinutes: 240,
				retentionHours: 12,
			},
		);
	});

	test("preserves configured environment duration overrides", () => {
		const environment = {
			deployment: "https://coder.example.com",
			organization: "default",
			templates: {
				"dev-large": { preset: "standard" },
				"dev-windows": {
					preset: "standard",
					parameters: { instance_type: "Standard_D4s_v5" },
				},
			},
			defaultTemplate: "dev-large",
			idleMinutes: 180,
			retentionHours: 8,
		};

		assert.deepEqual(withWorkflowDefaults({ environment }).environment, environment);
	});

	test("treats a project environment binding as one deployment-scoped override", async () => {
		const home = await mkdtemp(join(tmpdir(), "workflow-environment-home-"));
		const project = await mkdtemp(join(tmpdir(), "workflow-environment-project-"));
		try {
			const globalDirectory = join(home, ".atomic", "agent", "extensions", "workflow");
			const projectDirectory = join(project, ".atomic", "extensions", "workflow");
			await mkdir(globalDirectory, { recursive: true });
			await mkdir(projectDirectory, { recursive: true });
			await writeFile(
				join(globalDirectory, "config.json"),
				JSON.stringify({
					environment: {
						deployment: "https://global.coder.example",
						template: "global-template",
					},
				}),
			);
			await writeFile(
				join(projectDirectory, "config.json"),
				JSON.stringify({
					environment: {
						deployment: "https://project.coder.example",
						template: "project-template",
					},
				}),
			);

			const result = await loadWorkflowConfig({ homeDir: home, projectRoot: project });
			assert.deepEqual(result.config?.environment, {
				deployment: "https://project.coder.example",
				template: "project-template",
			});
			assert.deepEqual(result.diagnostics, []);
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(project, { recursive: true, force: true });
		}
	});

	test("rejects an expanded binding whose default is not a configured template", async () => {
		const directory = await mkdtemp(join(tmpdir(), "workflow-environment-config-"));
		const filePath = join(directory, "config.json");
		try {
			await writeFile(
				filePath,
				JSON.stringify({
					environment: {
						deployment: "https://coder.example.com",
						templates: { "dev-large": {} },
						defaultTemplate: "missing",
					},
				}),
			);

			const outcome = await loadConfigFile(filePath);
			assert.equal(outcome.kind, "error");
			if (outcome.kind === "error") {
				assert.match(outcome.diagnostic.message, /environment\.defaultTemplate/);
				assert.match(outcome.diagnostic.message, /configured template/);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects an inherited Object prototype name as the default template", async () => {
		const directory = await mkdtemp(join(tmpdir(), "workflow-environment-config-"));
		const filePath = join(directory, "config.json");
		try {
			await writeFile(
				filePath,
				JSON.stringify({
					environment: {
						deployment: "https://coder.example.com",
						templates: { "dev-large": {} },
						defaultTemplate: "toString",
					},
				}),
			);

			const outcome = await loadConfigFile(filePath);
			assert.equal(outcome.kind, "error");
			if (outcome.kind === "error") {
				assert.match(outcome.diagnostic.message, /environment\.defaultTemplate/);
				assert.match(outcome.diagnostic.message, /configured template/);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
