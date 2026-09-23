import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getDocsPath } from "../src/config.js";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
};

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
					find: "Find filesystem paths",
					search: "Search file contents",
					ask_user_question: "Ask structured user questions",
					todo: "Manage file-based todos",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
			expect(prompt).toContain("- find:");
			expect(prompt).toContain("- search:");
			expect(prompt).toContain("- ask_user_question:");
			expect(prompt).toContain("- todo:");
		});
	});

	describe("shell-only file operations", () => {
		test.each([
			{
				tools: ["bash"],
				expected: "Use bash for file operations like ls, rg, find",
			},
			{
				tools: ["powershell"],
				expected: "Use PowerShell for file operations like listing, searching, and finding files",
			},
			{
				tools: ["bash", "powershell"],
				expected: "Use bash or PowerShell for file operations like listing, searching, and finding files",
			},
		])("adds guidance for $tools", ({ tools, expected }) => {
			const prompt = buildSystemPrompt({
				selectedTools: tools,
				toolSnippets: { bash: "Execute bash commands", powershell: "Execute PowerShell commands" },
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("model attribution", () => {
		test("includes selected model name and reasoning level before date and working directory", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				selectedModel: {
					provider: "anthropic",
					id: "claude-sonnet-4-5",
					name: "Claude Sonnet 4.5",
				},
				selectedThinkingLevel: "high",
			});

			const modelLine = "Model name (used for commit attribution): Claude Sonnet 4.5";
			const reasoningLine = "Model reasoning level: high";
			expect(prompt).toContain(modelLine);
			expect(prompt).toContain(reasoningLine);
			expect(prompt.indexOf(modelLine)).toBeLessThan(prompt.indexOf(reasoningLine));
			expect(prompt.indexOf(reasoningLine)).toBeLessThan(prompt.indexOf("Current date:"));
			expect(prompt.indexOf("Current date:")).toBeLessThan(prompt.indexOf("Current working directory:"));
		});

		test("falls back to selected model id when no display name is available", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "Custom prompt",
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				selectedModel: {
					provider: "openai",
					id: "gpt-5.1-codex",
				},
			});

			expect(prompt).toContain("Model name (used for commit attribution): gpt-5.1-codex");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	test("renders exactly the default guidelines and nothing else", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		const guidelines = prompt.slice(prompt.indexOf("Guidelines:\n"), prompt.indexOf("\n</rules>"));

		expect(guidelines).toBe(`Guidelines:
- Write self-describing code and do not add comments unless the user explicitly asks for them or the task instructions call for them. Code that needs a comment to be understood is a smell: restructure it with clearer names, smaller units, or explicit types instead
- Be concise in your responses
- Show file paths clearly when working with files`);
	});

	test("renders custom guidelines before the exact default guidelines", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			promptGuidelines: ["**Workflows**: Workflow-specific sentinel."],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});
		const guidelines = prompt.slice(prompt.indexOf("Guidelines:\n"), prompt.indexOf("\n</rules>"));

		expect(guidelines).toBe(`Guidelines:
- **Workflows**: Workflow-specific sentinel.
- Write self-describing code and do not add comments unless the user explicitly asks for them or the task instructions call for them. Code that needs a comment to be understood is a smell: restructure it with clearer names, smaller units, or explicit types instead
- Be concise in your responses
- Show file paths clearly when working with files`);
	});

	describe("workflow guidance", () => {
		test("does not inject workflow guidance directly from system-prompt", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("- **Workflows**:");
		});
	});

	test("routes bundled extension questions to readable guides under the docs root", () => {
		const prompt = buildSystemPrompt({ cwd: process.cwd(), contextFiles: [], skills: [] });
		assert.ok(prompt.includes(`Additional docs: ${getDocsPath()}`));
		for (const topic of ["mcp-servers", "intercom", "web-access", "subagents", "workflows"]) {
			assert.ok(prompt.includes(`docs/${topic}.md`), `Missing documentation route for ${topic}`);
			assert.match(readFileSync(join(getDocsPath(), `${topic}.md`), "utf8"), /^# /m);
		}
	});

	test("routes model advice and automation requests to evidence and domain-specific tools", () => {
		const prompt = buildSystemPrompt({ cwd: process.cwd(), contextFiles: [], skills: [] });
		assert.match(prompt, /When the user asks which model to choose for a task/);
		assert.match(prompt, /models\/model-selection\.md/);
		assert.match(prompt, /models\/evals\.md/);
		assert.match(prompt, /https:\/\/artificialanalysis\.ai\//);
		assert.match(prompt, /relevant benchmark charts and methodology/);
		assert.match(prompt, /If live evidence is unavailable, label the dated docs snapshot/);
		assert.match(
			prompt,
			/CUA\) on desktop apps, simulators and emulators, use Cua Driver through the cua-driver skill/,
		);
		assert.match(prompt, /one-shot `cua-driver call <tool>` commands/);
		assert.match(
			prompt,
			/when a model chooses the next action[\s\S]*use the CLI; when workflow TypeScript code owns the sequence and postcondition, use the @trycua\/cua-driver TypeScript SDK inside ctx\.tool/,
		);
		assert.match(
			prompt,
			/If `cua-driver --version` fails, make one bounded attempt with upstream's one-line installer/,
		);
		assert.match(prompt, /never run `cua-driver skills install`/);
		assert.match(prompt, /CUA_DRIVER_RS_TELEMETRY_ENABLED=false/);
		assert.match(prompt, /computer-use\.md/);
		assert.doesNotMatch(prompt, /PyAutoGUI|pyautogui/i);
		assert.doesNotMatch(prompt, /uv run --with pyautogui/);
		assert.doesNotMatch(prompt, /CUA_DRIVER_RS_UPDATE_CHECK=false/);
		assert.match(
			prompt,
			/Prefer the agent-browser skill for what it covers: websites and web apps in Chrome\/Chromium, Electron desktop apps/,
		);
		assert.match(
			prompt,
			/Use cua-driver for everything else \(native desktop apps, iOS simulators, Android emulators[\s\S]*whenever agent-browser hits a limitation/,
		);
		assert.match(prompt, /terminal automation\/testing, prefer herdr on macOS, Linux and Windows/);
		assert.match(prompt, /install it if missing/);
		assert.match(prompt, /fall back to tmux or native Windows psmux/);
		assert.match(prompt, /explicit-request and HERDR_ENV=1 requirements/);
		assert.match(prompt, /skills do not grant tools or authorization/);
	});

	describe("skills", () => {
		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});
			assert.match(prompt, /<available_skills>/);
			assert.match(prompt, /<name>test-skill<\/name>/);
			assert.match(prompt, /Use bash to load a skill's file/);
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});
			assert.doesNotMatch(prompt, /<available_skills>/);
		});
	});

	describe("repository intent", () => {
		test("teaches repository-intent inference when a shell tool is available", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("**Repository intent**");
			expect(prompt).toContain("review recent commits, open and merged PRs, issues and their comments");
			expect(prompt).toContain("identify the requesting user");
			expect(prompt).toContain("interpret ambiguous requests the way they would");
		});

		test("teaches recording and mining execution history when a shell tool is available", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("**Execution history**");
			expect(prompt).toContain("`Assistant-workflow: inline` when no workflow was used");
			expect(prompt).toContain("`Assistant-duration: 42m converged, estimated 30m`");
			expect(prompt).toContain("`User-preference: <one line, in the user's terms>`");
			expect(prompt).toContain("never record secrets, credentials");
			expect(prompt).toContain("Treat fewer than five comparable records as anecdotal");
			expect(prompt).toContain("This history is a guide, not the decision");
			expect(prompt).toContain("using the repository's version control system and its hosting CLI");
			expect(prompt).toContain("`gh pr list --state all --search 'Assistant-workflow in:body'` on GitHub");
			expect(prompt).toContain("tie it to the requesting user with a `Co-authored-by: <name> <email>` trailer");
			expect(prompt).toContain("Prioritize preferences tied to the requesting user");
			expect(prompt).toContain("fall back to other contributors' relevant preferences as repository conventions");
		});

		test("omits repository-intent guidance without a shell tool", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "edit"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("**Repository intent**");
			expect(prompt).not.toContain("**Execution history**");
		});
	});

	describe("ask_user_question fallback", () => {
		test.each([
			{ selectedTools: ["read", "bash"] },
			{ selectedTools: ["read", "ask_question"] },
			{ selectedTools: ["read", "ask_question", "ask_user_question"], excludedTools: ["ask_user_question"] },
			{ excludedTools: ["ask_user_question"] },
		])("uses equivalent question tools or autonomous best judgment: %j", (tools) => {
			const prompt = buildSystemPrompt({
				...tools,
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("If an equivalent user-question tool is available, use it for all questions");
			expect(prompt).toContain("instead of plain text, including confirmations and approvals");
			expect(prompt).toContain("When no usable question tool or human-input channel exists, do not stall");
			expect(prompt).toContain("continue fully autonomously on best judgment");
			expect(prompt).toContain("Tool unavailability alone is not a blocker");
			expect(prompt).not.toContain("ask_user_question");
		});

		test("omits the fallback guideline when ask_user_question is selected", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "ask_user_question"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("If an equivalent user-question tool is available");
		});
	});
});
