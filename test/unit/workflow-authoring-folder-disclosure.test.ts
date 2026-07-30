import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
	DEFAULT_PROMPT_GUIDANCE,
	WORKFLOW_TOOL_DESCRIPTION,
} from "../../packages/workflows/src/extension/workflow-prompts.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const disclosureMessage = "Custom workflow created. You can inspect its code at: <workflow-folder-path>";
const newCustomWorkflowScope = "only for newly created custom workflows";

async function readRepositoryFile(path: string): Promise<string> {
	return (await readText(resolve(repositoryRoot, path))).replaceAll("\r\n", "\n");
}

function expectFolderDisclosure(content: string, source: string): void {
	expect(content, source).toContain(disclosureMessage);
	expect(content, source).toContain(newCustomWorkflowScope);
}

describe("custom workflow folder disclosure", () => {
	test("keeps the tool description and prompt guidance explicit and scoped", () => {
		expectFolderDisclosure(WORKFLOW_TOOL_DESCRIPTION, "WORKFLOW_TOOL_DESCRIPTION");
		expectFolderDisclosure(DEFAULT_PROMPT_GUIDANCE.join("\n"), "DEFAULT_PROMPT_GUIDANCE");
	});

	test("keeps workflow creation docs explicit and scoped", async () => {
		for (const path of ["packages/coding-agent/docs/workflows.md", "packages/coding-agent/docs/quickstart.md"]) {
			expectFolderDisclosure(await readRepositoryFile(path), path);
		}
	});
});
