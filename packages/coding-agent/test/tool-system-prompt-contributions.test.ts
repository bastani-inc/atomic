import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readTextSync } from "../../../test/helpers/runtime.js";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import {
	askUserQuestionToolSystemPromptContribution,
	createAskUserQuestionToolDefinition,
} from "../src/core/tools/ask-user-question/ask-user-question.ts";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import { createSearchToolDefinition, searchToolSystemPromptContribution } from "../src/core/tools/search.ts";
import { createTodoToolDefinition, todoToolSystemPromptContribution } from "../src/core/tools/todos.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";

// The ask_user_question definition reads machine-local guidance overrides from
// ~/.config/rpiv-ask-user-question/config.json. Pin loadConfig to an empty
// config so the alignment assertions below observe the module constant rather
// than whatever happens to live on the host running the suite.
const askUserQuestionConfig = vi.hoisted(
	(): { guidance?: { promptSnippet?: string; promptGuidelines?: string[] } } => ({}),
);

vi.mock("../src/core/tools/ask-user-question/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/ask-user-question/config.ts")>();
	return { ...actual, loadConfig: () => askUserQuestionConfig };
});

/** Prompt-contribution surface shared by all nine built-in tool modules. */
interface ToolPromptContribution {
	readonly snippet?: string;
	readonly guidelines: readonly string[];
}

interface DefinitionWithPromptText {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

type DefinitionFactory = () => DefinitionWithPromptText;

const cases: ReadonlyArray<readonly [string, ToolPromptContribution, DefinitionFactory]> = [
	["read", readToolSystemPromptContribution, () => createReadToolDefinition("/workspace")],
	["bash", bashToolSystemPromptContribution, () => createBashToolDefinition("/workspace")],
	["edit", editToolSystemPromptContribution, () => createEditToolDefinition("/workspace")],
	["write", writeToolSystemPromptContribution, () => createWriteToolDefinition("/workspace")],
	["find", findToolSystemPromptContribution, () => createFindToolDefinition("/workspace")],
	["search", searchToolSystemPromptContribution, () => createSearchToolDefinition("/workspace")],
	["ls", lsToolSystemPromptContribution, () => createLsToolDefinition("/workspace")],
	["ask_user_question", askUserQuestionToolSystemPromptContribution, () => createAskUserQuestionToolDefinition()],
	["todo", todoToolSystemPromptContribution, () => createTodoToolDefinition("/workspace")],
];

afterEach(() => {
	askUserQuestionConfig.guidance = undefined;
});

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its immutable contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition();

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
			const definition = createDefinition();
			const prompt = buildSystemPrompt({
				selectedTools: [definition.name],
				toolSnippets: definition.promptSnippet ? { [definition.name]: definition.promptSnippet } : {},
				promptGuidelines: definition.promptGuidelines,
				contextFiles: [],
				skills: [],
				cwd: "/workspace",
			});

			if (contribution.snippet !== undefined) {
				expect(prompt.split(contribution.snippet)).toHaveLength(2);
			}
			for (const guideline of contribution.guidelines) expect(prompt.split(guideline)).toHaveLength(2);
		},
	);

	test("keeps bash session-environment guidance conditional", () => {
		const definition = createBashToolDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});

	test("keeps ask_user_question machine-config guidance overriding the contribution", () => {
		askUserQuestionConfig.guidance = {
			promptSnippet: "Custom ask_user_question snippet from machine config",
			promptGuidelines: ["Custom ask_user_question guideline from machine config"],
		};

		const definition = createAskUserQuestionToolDefinition();

		expect(definition.promptSnippet).toBe("Custom ask_user_question snippet from machine config");
		expect(definition.promptGuidelines).toEqual(["Custom ask_user_question guideline from machine config"]);
	});

	test("keeps the ask_user_question and todo contributions out of the public surface", () => {
		const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

		for (const entry of ["index.ts", "index-extensions.ts"]) {
			const source = readTextSync(join(srcDir, entry), "utf8");
			expect(source, entry).not.toContain("askUserQuestionToolSystemPromptContribution");
			expect(source, entry).not.toContain("todoToolSystemPromptContribution");
		}

		// Sanity check that the entries are actually read: the seven upstream-facing
		// contributions predate this change and stay exported from src/index.ts.
		const indexSource = readTextSync(join(srcDir, "index.ts"), "utf8");
		expect(indexSource).toContain("bashToolSystemPromptContribution");
	});
});
