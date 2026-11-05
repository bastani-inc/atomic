import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readTextSync } from "../../../test/helpers/runtime.js";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import {
	askUserQuestionToolSystemPromptContribution,
	createAskUserQuestionToolDefinition,
} from "../src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionParamsSchema } from "../src/core/tools/ask-user-question/tool/types.ts";
import { validateQuestionnaire } from "../src/core/tools/ask-user-question/tool/validate-questionnaire.ts";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import {
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.ts";
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

/** Prompt-contribution surface shared by all ten built-in tool modules. */
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
	["powershell", powershellToolSystemPromptContribution, () => createPowerShellToolDefinition("/workspace")],
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
		(name, contribution, createDefinition) => {
			const definition = createDefinition();

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
			// edit and write keep upstream pi's `as const` contributions verbatim (#4328).
			if (name !== "edit" && name !== "write") {
				expect(Object.isFrozen(contribution)).toBe(true);
				expect(Object.isFrozen(contribution.guidelines)).toBe(true);
			}
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

	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("keeps %s session-environment guidance conditional", (_name, createDefinition) => {
		const definition = createDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});

	test("routes every user question through the tool, including approval and unavailable-input cases", () => {
		const definition = createAskUserQuestionToolDefinition();
		const guidelines = definition.promptGuidelines?.join("\n") ?? "";
		for (const text of [definition.description, guidelines]) {
			expect(text).toContain("When ask_user_question or an equivalent question tool is available");
			expect(text).toContain("all questions to the user must use that tool instead of plain text");
			expect(text).toContain("Prefer ask_user_question when available");
			expect(text).toContain("Proceed?");
			expect(text).toContain("explicit proceed and decline options");
			expect(text).toContain("A cancelled or unanswered question is not approval");
			expect(text).toContain("If no usable question tool is available, continue autonomously using best judgment");
		}
		expect(guidelines).toContain("do not seek approval again for already-authorized work");
		expect(guidelines).toContain("Tool unavailability alone is not a blocker");
		expect(definition.promptSnippet).toContain("Ask all user questions through this tool");
	});

	test.each(["LF", "CRLF"])(
		"documents a schema-valid scoped approval with an explicit decline option (%s)",
		(lineEnding) => {
			const docs = readTextSync(join(dirname(fileURLToPath(import.meta.url)), "../docs/tools.md"), "utf8").replace(
				/\r?\n/g,
				lineEnding === "CRLF" ? "\r\n" : "\n",
			);
			const section = docs.split("## `ask_user_question`")[1]?.split("## Persisted tool output")[0] ?? "";
			const example = section.match(/```json\r?\n([\s\S]*?)\r?\n```/)?.[1];
			expect(example).toBeDefined();
			const params = Value.Parse(QuestionParamsSchema, JSON.parse(example ?? "null"));
			expect(validateQuestionnaire(params)).toEqual({ ok: true });
			expect(params.questions[0]?.question).toContain(
				"same seven PRs in dependency order without changing repository protections",
			);
			expect(params.questions[0]?.options.map((option) => option.label)).toEqual(["Proceed", "Do not proceed"]);
			expect(section).toContain("identify the target PRs");
			expect(section).toContain("A cancelled or unanswered question is not approval");
		},
	);

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
