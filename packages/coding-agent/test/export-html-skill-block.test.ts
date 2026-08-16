import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML skill block rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const treeScript = readFileSync(
		new URL("../src/core/export-html/template-js/tree-filter-render.js", import.meta.url),
		"utf-8",
	);

	it("strips skill wrapper XML from user message rendering", () => {
		// Skill commands store a structural wrapper in the raw user message:
		//   <skill name="..." location="...">\n...\n</skill>\n\nactual prompt
		// The export renderer must detect that wrapper and render only the user-visible prompt,
		// not the Pi-generated <skill>...</skill> XML tags.
		expect(templateJs).toMatch(/parseSkillBlock/);
		expect(templateJs).toMatch(/skillBlock\.userMessage/);
	});

	it("parses source-qualified skill blocks with stable candidate identity", () => {
		const parserSource = treeScript.slice(
			treeScript.indexOf("function parseSkillBlock"),
			treeScript.indexOf("function getSearchableText"),
		);
		const parse = Function(`${parserSource}; return parseSkillBlock;`)() as (text: string) => {
			name: string;
			location: string;
			candidateId?: string;
			content: string;
			userMessage?: string;
		};

		expect(
			parse(
				'<skill name="tdd@builtin" location="/skills/tdd/SKILL.md" candidate="skill_0123456789abcdef0123">\nBuiltin body\n</skill>\n\nrun tests',
			),
		).toEqual({
			name: "tdd@builtin",
			location: "/skills/tdd/SKILL.md",
			candidateId: "skill_0123456789abcdef0123",
			content: "Builtin body",
			userMessage: "run tests",
		});
	});

	it("renders skill invocation and user message as separate sibling blocks", () => {
		// The skill block and user message should render as separate entry-level elements,
		// matching the TUI layout where SkillInvocationMessageComponent and
		// UserMessageComponent are siblings, not nested.
		expect(templateJs).toMatch(/skill-invocation/);

		// When a skill block has a userMessage, the user-message div must be emitted
		// as a separate block after the skill-invocation div, containing the user-authored text.
		// Verify the code checks hasUserContent so the user-message div is only omitted
		// when the skill block has no user prompt and no images.
		expect(templateJs).toMatch(/hasUserContent/);
	});

	it("renders skill content as markdown, not raw text", () => {
		// The skill block body is markdown (from the SKILL.md file).
		// It should be rendered through safeMarkedParse, not escaped as raw text.
		expect(templateJs).toMatch(/safeMarkedParse\(skillBlock\.content\)/);
	});

	it("shows skill name and user message in the sidebar tree", () => {
		// The sidebar tree should display both the skill name and the user prompt,
		// not just one or the other.
		expect(templateJs).toMatch(/tree-role-skill/);
	});
});
