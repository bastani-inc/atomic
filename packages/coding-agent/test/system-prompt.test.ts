import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

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
			expect(prompt).toContain("- ask_user_question:");
			expect(prompt).toContain("- todo:");
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

	describe("workflow guidance", () => {
		test("includes workflow guidance by default", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- **Workflows**:");
			expect(prompt).toContain("Use the `workflow` tool");
			expect(prompt).toContain("direct `task`, `tasks`, or `chain`");
			expect(prompt).toContain("create or edit a workflow");
			expect(prompt).toContain("create-spec skill when available");
			expect(prompt).toContain("clarifying questions");
			expect(prompt).toContain("implement the workflow from the created spec directly");
			expect(prompt).toContain("targeted `status`/`stages`/`stage` checks");
			expect(prompt).toContain("do not micro-manage");
			expect(prompt).toContain("sleep/status polling loops");
			expect(prompt).toContain("sessionFile`/`transcriptPath");
			expect(prompt).toContain("preserve Windows backslashes");
			expect(prompt).toContain("explicit `tail` or `limit`");
			expect(prompt).toContain("steer a stage");
			expect(prompt).toContain("If you run `ralph` or `goal`");
			expect(prompt).not.toContain("`stage` workflow call");
		});

		test("omits workflow guidance when the workflow tool is excluded", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				excludedTools: ["workflow"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("- **Workflows**:");
		});
	});
});
