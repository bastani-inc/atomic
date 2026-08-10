import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import { createSearchToolDefinition, searchToolSystemPromptContribution } from "../src/core/tools/search.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["search", searchToolSystemPromptContribution, createSearchToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its immutable contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
			expect(Object.isFrozen(contribution)).toBe(true);
			expect(Object.isFrozen(contribution.guidelines)).toBe(true);
			if (contribution.guidelines.length > 0) {
				expect(definition.promptGuidelines).not.toBe(contribution.guidelines);
				definition.promptGuidelines?.push("definition-only guideline");
				expect(contribution.guidelines).not.toContain("definition-only guideline");
			}
		},
	);

	test.each(cases)(
		"adds the %s contribution exactly once to the system prompt",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");
			const prompt = buildSystemPrompt({
				selectedTools: [definition.name],
				toolSnippets: { [definition.name]: definition.promptSnippet! },
				promptGuidelines: definition.promptGuidelines,
				contextFiles: [],
				skills: [],
				cwd: "/workspace",
			});

			expect(prompt.split(contribution.snippet)).toHaveLength(2);
			for (const guideline of contribution.guidelines) expect(prompt.split(guideline)).toHaveLength(2);
		},
	);

	test("keeps bash session-environment guidance conditional", () => {
		const definition = createBashToolDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});
});
