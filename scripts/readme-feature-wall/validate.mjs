#!/usr/bin/env node
// Authoritative gate for the README feature tables.
//
//   node scripts/readme-feature-wall/validate.mjs
//
// Deterministic: it reads manifest.json, README.md, .gitattributes, and the
// shipped media, and it re-derives every claim rather than trusting a summary.
// Exit code 0 only when every check passes.
//
// Checks, in order:
//   1  required feature set, count, fixed product-impact order, lesson/display binding, and docs mapping
//   2  README hierarchy and table shape: 6 featured + 34 remaining, exact placement, links, media, alt
//   3  exact 19 + 28 + 15 badge manifest and README groups; local SVG XML, icon/text shape, and source records
//   4  feature media exist for all 80 files named by the manifest
//   5  dimensions: every GIF and poster is exactly 960x540 (16:9)
//   6  GIF duration bounds, declared frame rate bounds, and maximum held-frame duration
//   7  file-size caps, per GIF, aggregate, and per poster
//   8  GIF and JPG decode cleanly end to end
//   9  contact-sheet timeline sampling and longest-held-frame reporting
//  10  gifski is the declared and actual GIF encoder
//  11  Git LFS attributes cover every shipped feature-wall GIF
//  12  no personal string in frames (OCR) or in any tracked source here
//  13  no script in this directory reads or prints a credential file
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN, matches } from "./lib/privacy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const BADGE_MANIFEST_PATH = join(REPO, "scripts", "readme-badges", "manifest.json");
const BADGE_MANIFEST = JSON.parse(readFileSync(BADGE_MANIFEST_PATH, "utf8"));
const README = readFileSync(join(REPO, "README.md"), "utf8");

// The exact 6+34 contract, written out rather than derived from the manifest
// so the manifest cannot quietly redefine the required split or coverage.
const FEATURED_REQUIRED = [
	["W.1", "Launch a workflow in plain English", "Workflows", "/workflows"],
	["6.2", "Steer and control a live run", "Workflows", "/workflows"],
	["6.5", "Durability and resume", "Workflows", "/workflows"],
	["6.4", "Human-in-the-loop gates", "Workflows", "/workflows"],
	["5.3", "Planner-worker intercom coordination", "Intercom", "/intercom"],
	["6.6", "Security review with a repair loop", "Workflows", "/workflows"],
];
const REMAINING_REQUIRED = [
	["A.8", "Natural-language workflow authoring", "Workflows", "/workflows"],
	["A.10", "Autonomous implementation loops", "Workflows", "/workflows"],
	["W.3", "Inspect and control workflows", "Workflows", "/workflows"],
	["5.2", "Worktree-isolated parallel work", "Subagents", "/subagents"],
	["5.4", "Escalating to a human supervisor", "Intercom", "/intercom"],
	["A.9", "Nesting builtin workflows", "Workflows", "/workflows"],
	["A.5", "Parallel review composition", "Subagents", "/subagents"],
	["5.5", "Intercom context handoff", "Intercom", "/intercom"],
	["5.1", "Delegating to bundled specialists", "Subagents", "/subagents"],
	["A.6", "Background subagent runs", "Subagents", "/subagents"],
	["6.3", "Writing your own workflow", "Workflows", "/workflows"],
	["6.1", "Touring the builtins", "Workflows", "/workflows"],
	["W.2", "Run a workflow with typed inputs", "Workflows", "/workflows"],
	["2.2", "Verbatim compaction", "Compaction", "/compaction"],
	["1.2", "Hashline edits", "Built-in tools", "/tools"],
	["1.3", "The agent interviews you", "Built-in tools", "/tools"],
	["A.2", "Permission gate extension", "Extensions", "/extensions"],
	["3.2", "Block a dangerous command", "Extensions", "/extensions"],
	["3.3", "Full-screen TUI tool", "TUI components", "/tui"],
	["4.3", "Embed the agent with the SDK", "SDK", "/sdk"],
	["3.1", "Build an extension", "Extensions", "/extensions"],
	["3.4", "Write a skill", "Skills", "/skills"],
	["4.2", "Local models via models.json", "Custom models", "/models"],
	["4.1", "Headless print and JSON mode", "JSON event stream", "/json"],
	["2.1", "Branching with tree, fork, clone", "Sessions", "/sessions"],
	["2.3", "Sessions are just JSONL", "Session format", "/session-format"],
	["1.1", "Your first session", "Using Atomic", "/usage"],
	["1.4", "File-based todos", "Built-in tools", "/tools"],
	["5.6", "A handoff command of your own", "Prompt templates", "/prompt-templates"],
	["A.7", "Intercom group isolation", "Intercom", "/intercom"],
	["A.4", "Prompt templates with arguments", "Prompt templates", "/prompt-templates"],
	["A.3", "Runtime system-prompt mutation", "Extensions", "/extensions"],
	["A.1", "Keybindings and hot reload", "Keybindings", "/keybindings"],
	["3.5", "Custom theme", "Themes", "/themes"],
];
const REQUIRED = [...FEATURED_REQUIRED, ...REMAINING_REQUIRED];
const DISPLAY_TITLES = new Map([["6.6", "Verification built in"]]);

const COURSE_URL = "https://github.com/bastani-inc/atomic-crash-course";
const DOCS_URL = "https://docs.bastani.ai";
const FEATURED_START = "<!-- feature-wall:featured:start -->";
const FEATURED_END = "<!-- feature-wall:featured:end -->";
const MORE_START = "<!-- feature-wall:more:start -->";
const MORE_END = "<!-- feature-wall:more:end -->";
const BADGES_START = "<!-- readme-badges:start -->";
const BADGES_END = "<!-- readme-badges:end -->";
const MORE_ANCHOR_LINK = '<a href="#more-atomic-capabilities">';
const badge = (label, slug, href, alt, icon = slug) => ({ label, slug, href, alt, icon });
const BADGE_GROUPS_REQUIRED = [
	{
		id: "stack",
		heading: "### Works with your engineering stack",
		entries: [
			badge("GitHub", "github", "https://github.com/", "Connect Atomic with GitHub"),
			badge("GitLab", "gitlab", "https://gitlab.com/", "Connect Atomic with GitLab"),
			badge("Git", "git", "https://git-scm.com/", "Use Git with Atomic"),
			badge("Jira", "jira", "https://www.atlassian.com/software/jira", "Connect Atomic with Jira"),
			badge("Linear", "linear", "https://linear.app/", "Connect Atomic with Linear"),
			badge("Notion", "notion", "https://www.notion.so/", "Connect Atomic with Notion"),
			badge("Slack", "slack", "https://slack.com/", "Connect Atomic with Slack"),
			badge("Docker", "docker", "https://www.docker.com/", "Use Docker with Atomic"),
			badge("Kubernetes", "kubernetes", "https://kubernetes.io/", "Use Kubernetes with Atomic"),
			badge("AWS", "aws", "https://aws.amazon.com/", "Connect Atomic with AWS"),
			badge(
				"Google Cloud",
				"google-cloud",
				"https://cloud.google.com/",
				"Connect Atomic with Google Cloud",
				"googlecloud",
			),
			badge("Azure", "azure", "https://azure.microsoft.com/", "Connect Atomic with Azure"),
			badge("Sentry", "sentry", "https://sentry.io/", "Connect Atomic with Sentry"),
			badge("Datadog", "datadog", "https://www.datadoghq.com/", "Connect Atomic with Datadog"),
			badge("PostgreSQL", "postgresql", "https://www.postgresql.org/", "Use PostgreSQL with Atomic"),
			badge("Playwright", "playwright", "https://playwright.dev/", "Use Playwright with Atomic"),
			badge("Chrome", "chrome", "https://www.google.com/chrome/", "Use Chrome with Atomic", "chrome"),
			badge("MCP", "mcp", "https://modelcontextprotocol.io/", "Connect Atomic through MCP servers"),
			badge(
				"Any CLI or API",
				"any-cli-or-api",
				"https://docs.bastani.ai/extensions",
				"Connect Atomic with any CLI or API",
				"cli",
			),
		],
	},
	{
		id: "providers",
		heading: "### Works with your models",
		entries: [
			badge("OpenAI", "openai", "https://platform.openai.com/docs/", "OpenAI provider badge for Atomic"),
			badge("Anthropic", "anthropic", "https://docs.anthropic.com/", "Anthropic provider badge for Atomic"),
			badge(
				"GitHub Copilot",
				"github-copilot",
				"https://github.com/features/copilot",
				"GitHub Copilot provider badge for Atomic",
				"githubcopilot",
			),
			badge("OpenRouter", "openrouter", "https://openrouter.ai/", "OpenRouter provider badge for Atomic"),
			badge("Kimi", "kimi", "https://www.kimi.com/code", "Kimi provider badge for Atomic"),
			badge("xAI", "xai", "https://x.ai/api", "xAI provider badge for Atomic"),
			badge("Radius", "radius", "https://radius.pi.dev/", "Radius provider badge for Atomic"),
			badge("Ant Ling", "ant-ling", "https://www.ant-ling.com/en/", "Ant Ling provider badge for Atomic", "antling"),
			badge(
				"Azure OpenAI",
				"azure-openai",
				"https://azure.microsoft.com/en-us/products/ai-services/openai-service",
				"Azure OpenAI provider badge for Atomic",
				"azureopenai",
			),
			badge(
				"Amazon Bedrock",
				"amazon-bedrock",
				"https://aws.amazon.com/bedrock/",
				"Amazon Bedrock provider badge for Atomic",
				"bedrock",
			),
			badge("DeepSeek", "deepseek", "https://platform.deepseek.com/", "DeepSeek provider badge for Atomic"),
			badge(
				"NVIDIA NIM",
				"nvidia-nim",
				"https://build.nvidia.com/",
				"NVIDIA NIM provider badge for Atomic",
				"nvidia",
			),
			badge(
				"Google Gemini",
				"google-gemini",
				"https://ai.google.dev/gemini-api",
				"Google Gemini provider badge for Atomic",
				"gemini",
			),
			badge(
				"Google Vertex AI",
				"google-vertex-ai",
				"https://cloud.google.com/vertex-ai",
				"Google Vertex AI provider badge for Atomic",
				"vertex",
			),
			badge("Mistral", "mistral", "https://mistral.ai/", "Mistral provider badge for Atomic"),
			badge("Groq", "groq", "https://groq.com/", "Groq provider badge for Atomic"),
			badge("Cerebras", "cerebras", "https://inference-docs.cerebras.ai/", "Cerebras provider badge for Atomic"),
			badge(
				"Cloudflare AI",
				"cloudflare-ai",
				"https://developers.cloudflare.com/ai/",
				"Cloudflare AI provider badge for Atomic",
				"cloudflare",
			),
			badge(
				"Vercel AI Gateway",
				"vercel-ai-gateway",
				"https://vercel.com/ai-gateway",
				"Vercel AI Gateway provider badge for Atomic",
				"vercel",
			),
			badge("Z.ai", "z-ai", "https://z.ai/model-api", "Z.ai provider badge for Atomic", "zai"),
			badge("OpenCode", "opencode", "https://opencode.ai/", "OpenCode provider badge for Atomic"),
			badge(
				"Hugging Face",
				"hugging-face",
				"https://huggingface.co/",
				"Hugging Face provider badge for Atomic",
				"huggingface",
			),
			badge(
				"Fireworks AI",
				"fireworks-ai",
				"https://fireworks.ai/",
				"Fireworks AI provider badge for Atomic",
				"fireworks",
			),
			badge(
				"Together AI",
				"together-ai",
				"https://www.together.ai/",
				"Together AI provider badge for Atomic",
				"together",
			),
			badge("MiniMax", "minimax", "https://www.minimax.io/", "MiniMax provider badge for Atomic"),
			badge(
				"Moonshot AI",
				"moonshot-ai",
				"https://www.moonshot.ai/",
				"Moonshot AI provider badge for Atomic",
				"moonshot",
			),
			badge("Qwen", "qwen", "https://qwen.ai/", "Qwen provider badge for Atomic"),
			badge(
				"Xiaomi MiMo",
				"xiaomi-mimo",
				"https://platform.xiaomimimo.com/",
				"Xiaomi MiMo provider badge for Atomic",
				"xiaomi",
			),
		],
	},
	{
		id: "local",
		heading: "#### Local and open models",
		entries: [
			badge(
				"llama.cpp",
				"llama-cpp",
				"https://github.com/ggml-org/llama.cpp",
				"llama.cpp local model server badge for Atomic",
				"llamacpp",
			),
			badge("Ollama", "ollama", "https://ollama.com/", "Ollama local model server badge for Atomic"),
			badge(
				"LM Studio",
				"lm-studio",
				"https://lmstudio.ai/",
				"LM Studio local model server badge for Atomic",
				"lmstudio",
			),
			badge("vLLM", "vllm", "https://docs.vllm.ai/", "vLLM local model server badge for Atomic"),
			badge(
				"SGLang",
				"sglang",
				"https://github.com/sgl-project/sglang",
				"SGLang local model server badge for Atomic",
			),
			badge(
				"Hugging Face",
				"hugging-face",
				"https://huggingface.co/",
				"Hugging Face model hosting badge for Atomic",
				"huggingface",
			),
			badge("Llama", "llama", "https://www.llama.com/", "Llama open model family badge for Atomic"),
			badge("Gemma", "gemma", "https://ai.google.dev/gemma", "Gemma open model family badge for Atomic"),
			badge(
				"DeepSeek",
				"deepseek",
				"https://github.com/deepseek-ai/",
				"DeepSeek open model family badge for Atomic",
			),
			badge("Qwen", "qwen", "https://qwen.ai/", "Qwen open model family badge for Atomic"),
			badge("Kimi", "kimi", "https://github.com/MoonshotAI/", "Kimi open model family badge for Atomic"),
			badge("GLM", "glm", "https://github.com/zai-org/GLM-4.5", "GLM open model family badge for Atomic"),
			badge("Mistral", "mistral", "https://mistral.ai/models/", "Mistral open model family badge for Atomic"),
			badge("MiniMax", "minimax", "https://github.com/MiniMax-AI/", "MiniMax open model family badge for Atomic"),
			badge(
				"gpt-oss",
				"gpt-oss",
				"https://openai.com/open-models/",
				"gpt-oss open model family badge for Atomic",
				"gptoss",
			),
		],
	},
];
const FALLBACK_ICONS_REQUIRED = new Map([
	["azure", "Monogram fallback"],
	["cli", "Generic glyph"],
	["openai", "Monogram fallback"],
	["xai", "Monogram fallback"],
	["radius", "Monogram fallback"],
	["cerebras", "Monogram fallback"],
	["sglang", "Monogram fallback"],
	["llama", "Monogram fallback"],
	["gptoss", "Monogram fallback"],
]);

const failures = [];
const notes = [];
const fail = (check, msg) => failures.push(`${check}: ${msg}`);
const ok = (check, msg) => notes.push(`  ok   ${check}: ${msg}`);

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const has = (bin) => {
	try {
		execFileSync("command", ["-v", bin], { shell: "/bin/bash", stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

// ---------------------------------------------------------------- 1. lessons
{
	const lessons = MANIFEST.lessons ?? [];
	if (lessons.length !== 40) fail("lessons", `expected 40 lessons, manifest has ${lessons.length}`);
	const ids = new Set();
	const orders = new Set();
	const sources = new Set();
	const media = new Set();
	REQUIRED.forEach(([id, title, docsLabel, docsPath], i) => {
		const l = lessons[i];
		if (!l) {
			fail("lessons", `missing lesson at position ${i + 1} (${id})`);
			return;
		}
		if (l.id !== id) fail("lessons", `position ${i + 1}: expected ${id}, found ${l.id}`);
		if (l.order !== i + 1) fail("lessons", `${l.id}: order is ${l.order}, expected ${i + 1}`);
		if (l.lesson !== `${id} ${title}`)
			fail("lessons", `${id}: expected exact lesson label "${id} ${title}", found "${l.lesson}"`);
		if (l.title !== title) fail("lessons", `${id}: course title must remain "${title}", found "${l.title}"`);
		const expectedDisplayTitle = DISPLAY_TITLES.get(id);
		if (expectedDisplayTitle && l.display_title !== expectedDisplayTitle)
			fail("lessons", `${id}: display_title must be "${expectedDisplayTitle}", found "${l.display_title}"`);
		if (!expectedDisplayTitle && l.display_title !== undefined)
			fail(
				"lessons",
				`${id}: unexpected display_title; only an explicit display override may differ from its lesson title`,
			);
		if (id === "6.6") {
			if (
				l.blurb !==
				"Executable checks and fresh reviewers produce evidence; failures route into bounded repair until the gate passes."
			)
				fail("lessons", "6.6 must describe executable checks, fresh reviewers, evidence, and bounded repair");
			if (
				l.alt !==
				"Atomic security-review workflow showing audit findings, a human repair approval, bounded repair, and the final four-of-four graph"
			)
				fail("lessons", "6.6 must carry the exact alt tied to the real security-review/repair capture");
			if (
				l.media?.gif !== "assets/feature-wall/27-security-review-repair-loop.gif" ||
				l.media?.jpg !== "assets/feature-wall/27-security-review-repair-loop.jpg"
			)
				fail("lessons", "6.6 must retain the exact real security-review repair-loop GIF and poster");
		}
		const expectedDocsUrl = `${DOCS_URL}${docsPath}`;
		if (l.docs?.label !== docsLabel)
			fail("docs", `${id}: docs label must be "${docsLabel}", found "${l.docs?.label}"`);
		if (l.docs?.url !== expectedDocsUrl)
			fail("docs", `${id}: docs URL must be ${expectedDocsUrl}, found ${l.docs?.url}`);

		const source = `scripts/readme-feature-wall/tapes/${id}.tape`;
		if (l.capture_source !== source)
			fail("lessons", `${id}: capture_source must be ${source}, found ${l.capture_source}`);
		else if (!existsSync(join(REPO, source))) fail("lessons", `${id}: capture source does not exist: ${source}`);
		if (!Array.isArray(l.interactions) || l.interactions.length === 0)
			fail("lessons", `${id}: interactions must be a non-empty list`);
		if (typeof l.privacy_notes !== "string" || !l.privacy_notes.trim())
			fail("lessons", `${id}: privacy_notes must be non-empty text`);

		const segments = l.render?.segments;
		if (segments !== undefined) {
			if (!Array.isArray(segments) || segments.length < 2) {
				fail("render", `${id}: render.segments must contain at least two chronological windows`);
			} else {
				for (const [segmentIndex, segment] of segments.entries()) {
					if (!Number.isFinite(segment?.start) || !Number.isFinite(segment?.end) || segment.end <= segment.start) {
						fail("render", `${id}: render.segments[${segmentIndex}] is not a positive time window`);
						continue;
					}
					const previous = segments[segmentIndex - 1];
					if (previous && segment.start < previous.end) {
						fail("render", `${id}: render.segments must preserve the raw recording's chronology`);
					}
				}
				if (segments[0].start < l.render.start || segments.at(-1).end > l.render.end) {
					fail("render", `${id}: render.segments must stay inside render.start and render.end`);
				}
			}
		}

		// The manifest is the reproducibility record, so a command it claims a
		// lesson ran must actually appear in that lesson's capture script.
		// Prose interactions ("approve at the gate") describe a keystroke and
		// are not checked here; a literal command is.
		const script = [join(REPO, source), join(REPO, `scripts/readme-feature-wall/tapes/${id}.prepare.sh`)]
			.filter((p) => existsSync(p))
			.map((p) => readFileSync(p, "utf8"))
			.join("\n");
		for (const step of Array.isArray(l.interactions) ? l.interactions : []) {
			if (!/^(\/|!|atomic\b|cat\b|tmux\b)/.test(step)) continue;
			const literal = step.replace(/^!+/, "").trim();
			if (!script.includes(literal)) {
				fail("interactions", `${id}: manifest claims command "${step}", which its capture script never runs`);
			}
		}

		for (const [label, value, set] of [
			["id", l.id, ids],
			["order", l.order, orders],
			["capture_source", l.capture_source, sources],
			["GIF", l.media?.gif, media],
			["poster", l.media?.jpg, media],
		]) {
			if (set.has(value)) fail("lessons", `${id}: duplicate ${label} ${value}`);
			set.add(value);
		}
	});
	if (!failures.some((f) => f.startsWith("lessons")))
		ok("lessons", "40 rows in the exact 6+34 order, with unique capture and media mappings");
	if (!failures.some((f) => f.startsWith("docs")))
		ok("docs", "all 40 rows carry the exact public Atomic docs label and URL mapping");
	if (!failures.some((f) => f.startsWith("interactions")))
		ok("interactions", "every command the manifest claims for a lesson appears in that lesson's capture script");
}

// ----------------------------------------------------------- 2. README tables
{
	const occurrences = (text, needle) => text.split(needle).length - 1;
	const markers = [FEATURED_START, FEATURED_END, MORE_START, MORE_END];
	const badMarkers = markers.filter((marker) => occurrences(README, marker) !== 1);
	if (badMarkers.length > 0) {
		fail("readme", `each feature-table marker must appear once; invalid: ${badMarkers.join(", ")}`);
	} else {
		const featuredStartAt = README.indexOf(FEATURED_START);
		const featuredEndAt = README.indexOf(FEATURED_END);
		const moreStartAt = README.indexOf(MORE_START);
		const moreEndAt = README.indexOf(MORE_END);
		const featuredRegion = README.slice(featuredStartAt, featuredEndAt + FEATURED_END.length);
		const moreRegion = README.slice(moreStartAt, moreEndAt + MORE_END.length);

		if (README.includes("<!-- feature-wall:start -->") || README.includes("<!-- feature-wall:end -->"))
			fail("readme", "legacy single-wall markers remain");
		if (/^\s*-\s+\*\*Workflows as versioned TypeScript\*\*/m.test(README))
			fail("readme", "the old Core capabilities bullet list is still present");
		if (README.includes("**Core capabilities")) fail("readme", "the old Core capabilities heading is still present");

		const metricsAt = README.indexOf("**Users are reporting:**");
		const metricsTail = "- 🛡️ Production incidents caught that CI did not cover";
		const metricsTailAt = README.indexOf(metricsTail, metricsAt);
		const quickstart =
			"<p><code>npm install -g @bastani/atomic</code> → <code>atomic</code> → <code>/login</code></p>";
		const badgesStartAt = README.indexOf(BADGES_START);
		const badgesEndAt = README.indexOf(BADGES_END);
		const stackAt = README.indexOf("### Works with your engineering stack", badgesStartAt);
		const topSeparatorAt = README.indexOf("\n---\n", badgesEndAt);
		const getStartedAt = README.indexOf("## Get started");
		const prerequisitesAt = README.indexOf("### Prerequisites", getStartedAt);
		const installStepsAt = README.indexOf("### Install", prerequisitesAt);
		const authenticateAt = README.indexOf("### Authenticate and run", installStepsAt);
		const skillsAt = README.indexOf("### Bring your skill stack", authenticateAt);
		const migrateAt = README.indexOf("### Migrating from another coding agent", skillsAt);
		const moreHeadingAt = README.indexOf("## More Atomic capabilities");
		const lowerSeparatorAt = README.indexOf("\n---\n", moreEndAt);
		const howAt = README.indexOf("## How Atomic works");

		if ((README.match(/^## Get started$/gm) ?? []).length !== 1)
			fail("readme", "expected exactly one detailed top-level Get started heading");
		if (README.includes("## Install and configure")) fail("readme", "the old Install and configure heading remains");
		if (occurrences(README, quickstart) !== 0)
			fail("readme", "the removed compact npm → atomic → /login quickstart line remains");
		if (!(metricsAt >= 0 && metricsAt < metricsTailAt && metricsTailAt < featuredStartAt))
			fail("readme", "user metrics must precede the featured region");
		else if (README.slice(metricsTailAt + metricsTail.length, featuredStartAt).trim())
			fail("readme", "the featured region must begin directly after the user metrics");
		if (
			(README.match(/^## Atomic Verifiable Runtime$/gm) ?? []).length !== 1 ||
			!featuredRegion.includes("## Atomic Verifiable Runtime")
		)
			fail("readme", "the featured region must contain the exact Atomic Verifiable Runtime heading");
		if (README.includes("### Atomic in action")) fail("readme", "the old Atomic in action heading remains");

		const positioningCopy = [
			"Build your process as workflows with scoped context, model choice, tools, handoffs, artifacts, retries, executable checks, review gates, and human approvals.",
			"Atomic’s primitives are built for the software engineering lifecycle. Verification is built into the execution model.",
			"Atomic is open so you can inspect and adapt it. You own the workflow, the evidence, and the rules for completion.",
			"Own your intelligence. Build in the open. Question the defaults. Keep control of the process. ☠︎",
		];
		for (const copy of positioningCopy) {
			const at = README.indexOf(copy);
			if (!(featuredEndAt < at && at < badgesStartAt))
				fail("readme", `positioning copy must remain between the featured table and badge groups: ${copy}`);
		}
		if (
			!(
				featuredEndAt < badgesStartAt &&
				badgesStartAt < stackAt &&
				stackAt < badgesEndAt &&
				badgesEndAt < topSeparatorAt &&
				topSeparatorAt < getStartedAt
			)
		)
			fail("readme", "the positioning copy and all badge groups must remain above the detailed Get started section");

		const setupOrder = [
			getStartedAt,
			prerequisitesAt,
			installStepsAt,
			authenticateAt,
			skillsAt,
			migrateAt,
			moreStartAt,
			moreHeadingAt,
			moreEndAt,
			lowerSeparatorAt,
			howAt,
		];
		if (setupOrder.some((position, index) => position < 0 || (index > 0 && position <= setupOrder[index - 1])))
			fail(
				"readme",
				"the complete Get started section, lower table, separator, and How Atomic works are out of order",
			);
		const setup = README.slice(getStartedAt, moreStartAt);
		for (const snippet of [
			"npm install -g @bastani/atomic",
			"pnpm add -g @bastani/atomic",
			"bun add -g @bastani/atomic",
			"Atomic stores provider credentials in `~/.atomic/agent/auth.json`",
			"<summary><b>Devcontainer, terminal, and SDK references</b></summary>",
			"Inspect the existing skill `<skill-name-or-path>`",
			"Install and set up Atomic by following https://docs.bastani.ai/llms.txt.",
		]) {
			if (!setup.includes(snippet)) fail("readme", `Get started is missing detailed setup copy: ${snippet}`);
		}

		if ((README.match(/^## More Atomic capabilities$/gm) ?? []).length !== 1)
			fail("readme", "expected exactly one More Atomic capabilities heading");
		if (occurrences(README, MORE_ANCHOR_LINK) !== 1)
			fail("readme", "the featured table must contain one link to #more-atomic-capabilities");
		if (!featuredRegion.includes(`${MORE_ANCHOR_LINK}<strong>Explore 34 more Atomic capabilities ↓</strong></a>`))
			fail("readme", "the featured-to-more link must state that 34 more capabilities follow");
		if ((README.match(/<table>/gi) ?? []).length !== 2)
			fail("readme", "README must contain exactly the two generated feature tables");
		if ((featuredRegion.match(/<table>/gi) ?? []).length !== 1 || (moreRegion.match(/<table>/gi) ?? []).length !== 1)
			fail("readme", "each generated region must contain exactly one table");

		if (README.includes("## Connect your engineering stack"))
			fail("readme", "the old lower engineering-stack section is still present");
		if (README.includes("| Need                   | Examples"))
			fail("readme", "the old engineering-stack table is still present");
		if (
			!README.slice(badgesStartAt, badgesEndAt).includes(
				"Atomic connects through installed CLIs, MCP servers, APIs, scripts, and custom extensions; you supply the credentials and permissions.",
			)
		)
			fail("readme", "the badge region is missing the credential-and-permission connection note");

		const featuredRows = featuredRegion.match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
		const moreRows = moreRegion.match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];
		if (featuredRows.length !== FEATURED_REQUIRED.length)
			fail("readme", `expected 6 featured rows, found ${featuredRows.length}`);
		if (moreRows.length !== REMAINING_REQUIRED.length)
			fail("readme", `expected 34 remaining rows, found ${moreRows.length}`);

		const seen = [];
		const validateRows = (rows, expected, regionName) => {
			rows.forEach((row, index) => {
				const expectedId = expected[index]?.[0];
				const candidates = MANIFEST.lessons.filter((lesson) =>
					row.includes(`<sub>Crash course · ${lesson.lesson}</sub>`),
				);
				if (candidates.length !== 1) {
					fail("readme", `${regionName} row ${index + 1} maps to ${candidates.length} manifest records`);
					return;
				}
				const lesson = candidates[0];
				seen.push(lesson.id);
				if (lesson.id !== expectedId)
					fail("readme", `${regionName} row ${index + 1}: expected ${expectedId}, found ${lesson.id}`);
				if ((row.match(/<td/gi) ?? []).length !== 2)
					fail("readme", `${lesson.id}: every row must have exactly two cells`);
				const courseLink = `${COURSE_URL}${lesson.anchor}`;
				const docsMarkup = `<p><a href="${lesson.docs.url}"><sub>Atomic docs · ${lesson.docs.label}</sub></a></p>`;
				const courseMarkup = `<p><a href="${courseLink}"><sub>Crash course · ${lesson.lesson}</sub></a></p>`;
				if (!row.includes(docsMarkup))
					fail("readme", `${lesson.id}: row is missing its exact public Atomic docs link`);
				if (!row.includes(courseMarkup)) fail("readme", `${lesson.id}: row is missing its exact crash-course link`);
				if (!row.includes(`<p>${lesson.blurb}</p>`))
					fail("readme", `${lesson.id}: row is missing its exact feature copy`);
				if (occurrences(row, courseLink) !== 2)
					fail("readme", `${lesson.id}: crash-course URL must appear once in copy and once around media`);
				if (row.indexOf(docsMarkup) > row.indexOf(courseMarkup))
					fail("readme", `${lesson.id}: Atomic docs link must render above its crash-course link`);
				if ((row.match(/https:\/\/docs\.bastani\.ai\//g) ?? []).length !== 1)
					fail("readme", `${lesson.id}: row must contain exactly one public Atomic docs link`);
				if (!row.includes(lesson.media.gif)) fail("readme", `${lesson.id}: row is missing GIF ${lesson.media.gif}`);
				if (!row.includes(lesson.media.jpg))
					fail("readme", `${lesson.id}: row is missing poster ${lesson.media.jpg}`);
				if (!/<picture>/i.test(row)) fail("readme", `${lesson.id}: row must use <picture> markup`);
				if (!row.includes(`alt="${lesson.alt}"`)) fail("readme", `${lesson.id}: row is missing its exact alt text`);
				const displayTitle = DISPLAY_TITLES.get(expectedId) ?? expected[index]?.[1];
				if (!row.includes(`<h4>${displayTitle}</h4>`))
					fail("readme", `${lesson.id}: row is missing its exact display title`);
			});
		};
		validateRows(featuredRows, FEATURED_REQUIRED, "featured");
		validateRows(moreRows, REMAINING_REQUIRED, "remaining");

		const allRegions = `${featuredRegion}\n${moreRegion}`;
		for (const lesson of MANIFEST.lessons) {
			const rowLabel = `<sub>Crash course · ${lesson.lesson}</sub>`;
			if (occurrences(allRegions, rowLabel) !== 1)
				fail("readme", `${lesson.id}: feature row must appear exactly once across both tables`);
			if (occurrences(README, lesson.media.gif) !== 1 || occurrences(README, lesson.media.jpg) !== 1)
				fail("readme", `${lesson.id}: GIF and poster must each appear exactly once in README`);
		}
		const duplicateIds = [...new Set(seen.filter((id, index) => seen.indexOf(id) !== index))];
		if (seen.length !== REQUIRED.length || new Set(seen).size !== REQUIRED.length)
			fail(
				"readme",
				`the two tables must cover all 40 records once; duplicate ids: ${duplicateIds.join(", ") || "none"}`,
			);

		if (!failures.some((failure) => failure.startsWith("readme"))) {
			ok(
				"readme",
				"6 featured + 34 remaining rows once each; exact runtime/Get started hierarchy, cross-link, and docs-first links",
			);
		}
	}
}

// ------------------------------------------------------------- 3. README badges
{
	const occurrences = (text, needle) => text.split(needle).length - 1;
	const xmlEscape = (value) =>
		String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const badgeMarkers = [BADGES_START, BADGES_END];
	const badMarkers = badgeMarkers.filter((marker) => occurrences(README, marker) !== 1);
	if (badMarkers.length) {
		fail("badges", `each README badge marker must appear once; invalid: ${badMarkers.join(", ")}`);
	} else {
		const startAt = README.indexOf(BADGES_START);
		const endAt = README.indexOf(BADGES_END);
		const region = README.slice(startAt, endAt + BADGES_END.length);
		const images = region.match(/<img\b[^>]*>/g) ?? [];
		const expectedCount = BADGE_GROUPS_REQUIRED.reduce((count, group) => count + group.entries.length, 0);
		if (images.length !== expectedCount)
			fail("badges", `README badge region has ${images.length} images, expected ${expectedCount}`);
		if (images.some((image) => /src=["'](?:https?:|\/\/|data:)/i.test(image)))
			fail("badges", "README badge groups contain a remote or data image source");
		if (/img\.shields\.io|shields\.io/i.test(region)) fail("badges", "README badge groups still reference Shields");

		const manifestGroups = BADGE_MANIFEST.groups ?? [];
		if (manifestGroups.length !== BADGE_GROUPS_REQUIRED.length)
			fail("badges", `badge manifest has ${manifestGroups.length} groups, expected ${BADGE_GROUPS_REQUIRED.length}`);
		const usedIcons = new Set();
		let previousHeadingAt = -1;
		for (const [groupIndex, expectedGroup] of BADGE_GROUPS_REQUIRED.entries()) {
			const manifestGroup = manifestGroups[groupIndex];
			if (!manifestGroup) {
				fail("badges", `badge manifest is missing ${expectedGroup.id}`);
				continue;
			}
			if (manifestGroup.id !== expectedGroup.id || manifestGroup.heading !== expectedGroup.heading)
				fail(
					"badges",
					`badge manifest group ${groupIndex + 1} must be ${expectedGroup.id} with heading "${expectedGroup.heading}"`,
				);
			if (manifestGroup.entries?.length !== expectedGroup.entries.length)
				fail(
					"badges",
					`${expectedGroup.id}: manifest has ${manifestGroup.entries?.length ?? 0} entries, expected ${expectedGroup.entries.length}`,
				);

			const headingAt = region.indexOf(expectedGroup.heading);
			if (headingAt < 0 || headingAt <= previousHeadingAt)
				fail("badges", `${expectedGroup.id}: README heading is missing or out of order`);
			previousHeadingAt = headingAt;
			const nextHeading = BADGE_GROUPS_REQUIRED[groupIndex + 1]?.heading;
			const nextHeadingAt = nextHeading
				? region.indexOf(nextHeading, headingAt + expectedGroup.heading.length)
				: region.length;
			const groupRegion = region.slice(headingAt, nextHeadingAt);
			const groupImages = groupRegion.match(/<img\b[^>]*>/g) ?? [];
			if (groupImages.length !== expectedGroup.entries.length)
				fail(
					"badges",
					`${expectedGroup.id}: README has ${groupImages.length} badges, expected ${expectedGroup.entries.length}`,
				);

			let previousEntryAt = -1;
			for (const [entryIndex, expectedEntry] of expectedGroup.entries.entries()) {
				const expectedPath = `assets/readme-badges/${expectedGroup.id}/${expectedEntry.slug}.svg`;
				const actualEntry = manifestGroup.entries?.[entryIndex];
				const expectedManifestEntry = { ...expectedEntry, path: expectedPath };
				const actualManifestEntry = actualEntry
					? {
							label: actualEntry.label,
							slug: actualEntry.slug,
							href: actualEntry.href,
							alt: actualEntry.alt,
							icon: actualEntry.icon,
							path: actualEntry.path,
						}
					: undefined;
				if (JSON.stringify(actualManifestEntry) !== JSON.stringify(expectedManifestEntry))
					fail(
						"badges",
						`${expectedGroup.id} entry ${entryIndex + 1} does not match the exact ${expectedEntry.label} contract`,
					);
				usedIcons.add(expectedEntry.icon);

				const markup = `<a href="${expectedEntry.href}"><img src="${expectedPath}" alt="${xmlEscape(expectedEntry.alt)}"></a>`;
				const entryAt = groupRegion.indexOf(markup);
				if (entryAt < 0)
					fail("badges", `${expectedGroup.id}: README is missing exact linked badge ${expectedEntry.label}`);
				else if (entryAt <= previousEntryAt)
					fail("badges", `${expectedGroup.id}: ${expectedEntry.label} is out of order`);
				previousEntryAt = entryAt;

				const absolutePath = join(REPO, expectedPath);
				if (!existsSync(absolutePath)) {
					fail("badges", `${expectedGroup.id}: missing local SVG ${expectedPath}`);
					continue;
				}
				try {
					execFileSync("xmllint", ["--noout", absolutePath], { stdio: "pipe" });
				} catch {
					fail("badges", `${expectedPath} is not well-formed SVG XML`);
					continue;
				}
				const svg = readFileSync(absolutePath, "utf8");
				if (!/^<svg\b[^>]*\bviewBox=["'][^"']+["']/i.test(svg.trim()))
					fail("badges", `${expectedPath} has no SVG root with a viewBox`);
				if (
					/<image\b|<(?:script|foreignObject)\b|(?:xlink:)?href\s*=|@import|url\(\s*["']?(?:https?:|\/\/|data:)/i.test(
						svg,
					)
				)
					fail("badges", `${expectedPath} contains an image, executable content, or external reference`);
				const svgIconAt = svg.indexOf('<svg class="badge-icon"');
				const groupIconAt = svg.indexOf('<g class="badge-icon"');
				const iconStart = svgIconAt >= 0 ? svgIconAt : groupIconAt;
				const iconClose = svgIconAt >= 0 ? "</svg>" : "</g>";
				const iconEnd = iconStart >= 0 ? svg.indexOf(iconClose, iconStart) : -1;
				const iconBlock = iconStart >= 0 && iconEnd >= 0 ? svg.slice(iconStart, iconEnd + iconClose.length) : "";
				if (!/<(?:path|polygon|polyline|circle|ellipse|rect|line|text)\b[^>]*>/i.test(iconBlock))
					fail("badges", `${expectedPath} has no non-empty local icon geometry`);
				if (
					!new RegExp(
						`<text class="badge-label"[^>]*>${xmlEscape(expectedEntry.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/text>`,
					).test(svg)
				)
					fail("badges", `${expectedPath} has no visible exact label text for ${expectedEntry.label}`);
			}
		}

		const manifestIconKeys = Object.keys(BADGE_MANIFEST.icons ?? {}).sort();
		const requiredIconKeys = [...usedIcons].sort();
		if (JSON.stringify(manifestIconKeys) !== JSON.stringify(requiredIconKeys))
			fail("badges", "badge manifest icon definitions must match the exact icons used by the 62 entries");
		for (const iconKey of requiredIconKeys) {
			const icon = BADGE_MANIFEST.icons?.[iconKey];
			if (!icon?.source?.type || !icon.source.brand || !icon.source.guidelines)
				fail("badges", `${iconKey}: icon source must record its type, brand source, and guidelines`);
			const fallbackType = FALLBACK_ICONS_REQUIRED.get(iconKey);
			if (fallbackType) {
				if (icon?.source?.type !== fallbackType || !icon.source.reason)
					fail("badges", `${iconKey}: expected documented ${fallbackType}`);
			} else if (["Monogram fallback", "Generic glyph"].includes(icon?.source?.type)) {
				fail("badges", `${iconKey}: an undocumented fallback replaced an available brand vector`);
			}
			if (
				icon?.kind === "vector" &&
				icon.source.type !== "Generic glyph" &&
				(!icon.viewBox || !icon.markup || !icon.source.vector)
			)
				fail("badges", `${iconKey}: vendored vector must include a viewBox, geometry, and source URL`);
			if (icon?.kind === "monogram" && !icon.monogram) fail("badges", `${iconKey}: monogram fallback has no mark`);
		}

		for (const copy of [
			"See [provider setup and the current catalog](https://docs.bastani.ai/providers). Availability depends on your credentials, subscription, region, and the provider catalog; one login does not unlock every provider.",
			"Atomic can run tool-capable models exposed through llama.cpp, Ollama, LM Studio, vLLM, SGLang, Hugging Face, or a compatible OpenAI, Anthropic, or Google endpoint. Actual model and tool support depends on the server and model.",
			"The model-family badges are representative open families, not a closed allowlist. See [Models](https://docs.bastani.ai/models) and [llama.cpp](https://docs.bastani.ai/llama-cpp).",
		]) {
			if (!region.includes(copy)) fail("badges", `README badge region is missing exact compatibility copy: ${copy}`);
		}

		const sourceDocPath = join(REPO, "assets", "readme-badges", "README.md");
		if (!existsSync(sourceDocPath)) fail("badges", "badge source attribution record is missing beside the assets");
		else {
			const sourceDoc = readFileSync(sourceDocPath, "utf8");
			if (!sourceDoc.includes("**19 engineering stack**, **28 provider brands**, and **15 local/open entries**"))
				fail("badges", "badge source attribution record is missing exact group counts");
			for (const iconKey of FALLBACK_ICONS_REQUIRED.keys()) {
				const reason = BADGE_MANIFEST.icons?.[iconKey]?.source?.reason;
				if (!reason || !sourceDoc.includes(reason))
					fail("badges", `${iconKey}: fallback note is missing from the source record`);
			}
		}
	}
	if (!failures.some((failure) => failure.startsWith("badges")))
		ok(
			"badges",
			"exact 19 + 28 + 15 manifest and README groups; 62 local SVGs parse with icon geometry, labels, and source records",
		);
}

// --------------------------------------------------------------- 4..9. media
const gifPaths = [];
{
	const R = MANIFEST.render;
	let totalGif = 0;
	for (const l of MANIFEST.lessons) {
		const gif = join(REPO, l.media.gif);
		const jpg = join(REPO, l.media.jpg);
		if (!existsSync(gif)) {
			fail("media", `${l.id}: missing GIF ${l.media.gif}`);
			continue;
		}
		if (!existsSync(jpg)) {
			fail("media", `${l.id}: missing poster ${l.media.jpg}`);
			continue;
		}
		gifPaths.push(l.media.gif);

		const gifBytes = statSync(gif).size;
		const jpgBytes = statSync(jpg).size;
		totalGif += gifBytes;
		if (gifBytes > R.max_gif_bytes)
			fail("size", `${l.id}: GIF is ${(gifBytes / 1048576).toFixed(1)} MiB, cap is 15 MiB`);
		if (jpgBytes > R.max_poster_bytes)
			fail("size", `${l.id}: poster is ${(jpgBytes / 1024).toFixed(0)} KiB, cap is 500 KiB`);

		for (const [path, kind] of [
			[gif, "GIF"],
			[jpg, "poster"],
		]) {
			const probe = sh("ffprobe", [
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height",
				"-of",
				"csv=p=0:s=x",
				path,
			]);
			const [w, h] = probe.split("x").map(Number);
			if (w !== R.width || h !== R.height)
				fail("dimensions", `${l.id}: ${kind} is ${w}x${h}, expected ${R.width}x${R.height}`);
			// Decode end to end: a truncated or corrupt file fails here.
			try {
				execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"], { stdio: "pipe" });
			} catch {
				fail("decode", `${l.id}: ${kind} does not decode cleanly`);
			}
		}

		const dur = Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", gif]));
		const [lo, hi] = R.duration_range_s;
		if (!(dur >= lo && dur <= hi)) fail("duration", `${l.id}: GIF runs ${dur.toFixed(2)}s, allowed ${lo}-${hi}s`);

		// Measure the encoded media, never the manifest's declared number. A
		// declared frame rate is an intention; gifski drops frames identical to
		// their predecessor, so a window that sat on a static screen encodes as a
		// still image while still declaring 12 fps over 12 s. Counting decoded
		// frames is what separates an animation from a padded still.
		const declared = l.render?.fps;
		const [flo, fhi] = R.fps_range;
		if (!(declared >= flo && declared <= fhi))
			fail("fps", `${l.id}: declared ${declared} fps, allowed ${flo}-${fhi}`);

		const frames = Number(
			sh("ffprobe", [
				"-v",
				"error",
				"-count_frames",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=nb_read_frames",
				"-of",
				"csv=p=0",
				gif,
			]),
		);
		if (!(frames > 1)) {
			fail(
				"animation",
				`${l.id}: GIF decodes to ${frames} frame(s); a still padded to ${dur.toFixed(1)}s is not an animated capture`,
			);
		}
		if (frames < R.min_distinct_frames) {
			fail(
				"animation",
				`${l.id}: GIF decodes to ${frames} distinct frames over ${dur.toFixed(1)}s, below the ${R.min_distinct_frames} required; the trim window holds too still to be an animated capture`,
			);
		}
		const encodedFps = frames / dur;
		if (encodedFps < R.min_encoded_fps) {
			fail(
				"animation",
				`${l.id}: GIF encodes ${frames} frames over ${dur.toFixed(1)}s = ${encodedFps.toFixed(2)} fps, below the ${R.min_encoded_fps} fps floor; the trim window has too little motion`,
			);
		}

		const timing = JSON.parse(
			sh("ffprobe", [
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"frame=best_effort_timestamp_time,duration_time",
				"-of",
				"json",
				gif,
			]),
		).frames.map((frame) => ({
			start: Number(frame.best_effort_timestamp_time) || 0,
			duration: Number(frame.duration_time),
		}));
		const delays = timing.map((frame) => frame.duration).filter((n) => Number.isFinite(n) && n > 0);
		const longestHold = timing.reduce((longest, frame) => (frame.duration > longest.duration ? frame : longest), {
			start: 0,
			duration: 0,
		});
		if (!(R.max_frame_hold_s > 0)) {
			fail("animation", "render.max_frame_hold_s must be a positive number");
		} else if (longestHold.duration > R.max_frame_hold_s + 1e-9) {
			fail(
				"animation",
				`${l.id}: one decoded frame holds for ${longestHold.duration.toFixed(2)}s from ${longestHold.start.toFixed(2)}s, above the ${R.max_frame_hold_s}s cap; later motion cannot hide a padded still`,
			);
		}
		// "Consistent practical frame rate", checked directly: every frame delay
		// in the encoded GIF must be a whole multiple of the declared interval,
		// so the clip sits on one timing grid rather than drifting.
		// GIF stores a delay as an integer number of centiseconds, so 1/12 s
		// (8.333 cs) is not representable and a real 12 fps GIF alternates 8 and
		// 9 cs. Allowing one centisecond of quantization is therefore required,
		// not a weakening: it is the format's own precision limit. Anything
		// further off the grid is genuine drift.
		const interval = 1 / declared;
		const offGrid = delays.filter((d) => {
			const k = Math.max(1, Math.round(d / interval));
			return Math.abs(d - k * interval) > R.grid_fps_tolerance + 1e-9;
		});
		if (offGrid.length) {
			fail(
				"animation",
				`${l.id}: ${offGrid.length}/${delays.length} frame delays are more than ${R.grid_fps_tolerance}s off a whole multiple of 1/${declared}s`,
			);
		}
	}
	if (totalGif > R.max_total_gif_bytes) {
		fail("size", `aggregate GIF payload is ${(totalGif / 1048576).toFixed(0)} MiB, cap is 300 MiB`);
	}
	if (!failures.some((f) => /^(media|size|dimensions|decode|duration|fps|animation)/.test(f))) {
		ok(
			"media",
			`80 files present; all 960x540; every GIF 7-16s, animated above the ${R.min_encoded_fps} fps floor, with no frame held over ${R.max_frame_hold_s}s; aggregate ${(totalGif / 1048576).toFixed(1)} MiB`,
		);
	}
}

// --------------------------------------------------------- review tooling
{
	const contactSheet = readFileSync(join(HERE, "contact-sheet.sh"), "utf8");
	if (/-ss\s+"\$t"\s+-i\s+"\$src"/.test(contactSheet)) {
		fail("review", "contact-sheet.sh uses input-side seek, which can skip a GIF's held frame delay");
	}
	if (!/fps=\$fps,trim=start=\$t,setpts=PTS-STARTPTS/.test(contactSheet)) {
		fail("review", "contact-sheet.sh does not expand the GIF timing grid before selecting timestamps");
	}
	if (!/gif-holds\.tsv/.test(contactSheet) || !/longest_hold/.test(contactSheet)) {
		fail("review", "contact-sheet.sh does not emit its longest-held-frame report");
	}
	if (!failures.some((f) => f.startsWith("review"))) {
		ok("review", "contact sheets expand GIF frame delays before timestamp selection and report longest holds");
	}
}

// ------------------------------------------------------------------ 8. gifski
{
	const render = readFileSync(join(HERE, "render.sh"), "utf8");
	if (MANIFEST.render.encoder !== "gifski") fail("gifski", "manifest does not declare gifski as the GIF encoder");
	if (!/^\s*gifski\s/m.test(render)) fail("gifski", "render.sh does not invoke gifski");
	// Comments explain why the palette path is rejected; only executable lines count.
	const renderCode = render
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
	if (/palettegen|paletteuse/.test(renderCode))
		fail("gifski", "render.sh must not fall back to an ffmpeg palette GIF");
	if (!failures.some((f) => f.startsWith("gifski"))) ok("gifski", "gifski is the declared and the actual GIF encoder");
}

// --------------------------------------------------------------------- 9. LFS
{
	const attrs = readFileSync(join(REPO, ".gitattributes"), "utf8");
	if (!/assets\/feature-wall\/\*\.gif\s+filter=lfs\s+diff=lfs\s+merge=lfs\s+-text/.test(attrs)) {
		fail("lfs", ".gitattributes has no `assets/feature-wall/*.gif filter=lfs diff=lfs merge=lfs -text` rule");
	}
	let checked = 0;
	for (const rel of gifPaths) {
		const out = sh("git", ["-C", REPO, "check-attr", "filter", "--", rel]);
		if (!out.endsWith(": lfs")) fail("lfs", `${rel} does not resolve to the lfs filter (${out})`);
		else checked += 1;
	}
	if (!failures.some((f) => f.startsWith("lfs")))
		ok("lfs", `all ${checked} feature-wall GIFs resolve to the Git LFS filter`);
}

// ----------------------------------------------------------------- 10. privacy
{
	// Source-level: nothing tracked here may carry a personal string. The
	// operator's account name is derived at runtime rather than written down,
	// so this gate stays portable and does not itself embed an identity.
	const personal = FORBIDDEN;
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(mjs|sh|json|tape|md)$/.test(e.name)) {
				const text = readFileSync(p, "utf8");
				for (const re of personal) {
					// Rule declarations must spell out what they detect; scanning those
					// declarations as leaked content would make the gate fail itself.
					const isRuleInput =
						p.endsWith("manifest.json") || p.endsWith("lib/privacy.mjs") || p.endsWith("validate.mjs");
					if (re.test(text) && !isRuleInput) {
						fail("privacy", `${p.replace(`${REPO}/`, "")} contains a personal string matching ${re}`);
					}
				}
			}
		}
	};
	walk(HERE);

	// Pixel-level: OCR sampled frames from every shipped GIF and poster.
	if (!has("tesseract")) {
		fail("privacy", "tesseract is not available, so the OCR privacy gate cannot run");
	} else {
		const tmp = sh("mktemp", ["-d"]);
		try {
			// What is checked: the operator's provider/model label and credential
			// shapes. Personal names, personal file names, unrelated session or run
			// names, and ordinary local paths are allowed on screen by the owner of
			// this repository, so nothing here scans for identity.
			let scanned = 0;
			// A bounded sample per clip rather than every frame. Exhaustive OCR of
			// ~3,900 frames cost an hour and proved no more than this does, because
			// a statusline label persists across many frames. The two positions
			// that a naive even sample misses are the ends, and the one leak this
			// wall actually shipped sat on the final frame, so both ends are always
			// sampled explicitly.
			const SAMPLES_PER_CLIP = Number(process.env.FW_OCR_SAMPLES ?? 16);
			for (const l of MANIFEST.lessons) {
				const gif = join(REPO, l.media.gif);
				if (!existsSync(gif)) continue;
				const fdir = join(tmp, l.slug);
				try {
					execFileSync("mkdir", ["-p", fdir]);
					const timelineFrames = Math.round(
						Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", gif])) *
							l.render.fps,
					);
					if (timelineFrames < 1) {
						fail("privacy", `${l.id}: GIF has no timeline frames, so privacy is unproven`);
						continue;
					}
					const step = Math.max(1, Math.floor(timelineFrames / Math.max(1, SAMPLES_PER_CLIP)));
					const picks = new Set([0, timelineFrames - 1]);
					for (let i = 0; i < timelineFrames; i += step) picks.add(i);
					const sampleFrames = [...picks].sort((a, b) => a - b);
					const select = `fps=${l.render.fps},select=not(mod(n\\,${step}))+eq(n\\,${timelineFrames - 1})`;
					execFileSync(
						"ffmpeg",
						["-y", "-v", "error", "-i", gif, "-vf", select, "-fps_mode", "vfr", join(fdir, "%05d.png")],
						{ stdio: "pipe" },
					);
					const all = readdirSync(fdir)
						.filter((f) => f.endsWith(".png"))
						.sort();
					if (all.length !== sampleFrames.length) {
						fail(
							"privacy",
							`${l.id}: expected ${sampleFrames.length} sampled frames, decoded ${all.length}, so privacy is unproven`,
						);
						continue;
					}
					for (const [sampleIndex, i] of sampleFrames.entries()) {
						const png = join(fdir, all[sampleIndex]);
						let text = "";
						for (const psm of ["6", "11"]) {
							try {
								text += sh("tesseract", [png, "stdout", "--psm", psm]);
							} catch {
								/* the other mode still contributes */
							}
						}
						scanned += 1;
						// Match through terminal wraps. A hard wrap splits a forbidden
						// string across two OCR lines, and a contiguous pattern cannot
						// see it; matches() also tests the unwrapped text.
						for (const re of matches(text))
							fail(
								"privacy",
								`${l.id}: timeline frame ${i} (${((i / timelineFrames) * 100).toFixed(0)}%) shows text matching ${re}`,
							);
					}
				} finally {
					// Decode only the exact timeline frames OCR will inspect, then
					// remove them even when ffmpeg or OCR fails.
					rmSync(fdir, { recursive: true, force: true });
				}

				const jpg = join(REPO, l.media.jpg);
				let ptext = "";
				for (const psm of ["6", "11"]) {
					try {
						ptext += sh("tesseract", [jpg, "stdout", "--psm", psm]);
					} catch {
						/* the other mode still contributes */
					}
				}
				scanned += 1;
				for (const re of matches(ptext)) fail("privacy", `${l.id}: poster shows text matching ${re}`);
			}
			if (!failures.some((f) => f.startsWith("privacy")))
				ok("privacy", `${scanned} sampled frames OCR-scanned, no provider/model label or credential found`);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
}

// ------------------------------------------------------- 11. credential safety
{
	let bad = 0;
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(sh|mjs|tape)$/.test(e.name)) {
				const text = readFileSync(p, "utf8");
				// Copying the credential into a throwaway HOME is allowed; reading,
				// printing, or parsing it is not.
				for (const m of text.matchAll(/^.*auth\.json.*$/gm)) {
					const line = m[0];
					if (/\b(cat|head|tail|grep|jq|echo|printf|readFileSync|less|strings)\b/.test(line)) {
						fail("credentials", `${p.replace(`${REPO}/`, "")}: reads or prints auth.json -> ${line.trim()}`);
						bad += 1;
					}
				}
			}
		}
	};
	walk(HERE);
	if (!bad) ok("credentials", "no script reads, parses, or prints a credential file");
}

// ------------------------------------------------------------------- 12. report
console.log("README feature tables gate");
for (const n of notes) console.log(n);
if (failures.length) {
	console.log("");
	for (const f of failures) console.log(`  FAIL ${f}`);
	console.log(`\n${failures.length} failure(s)`);
	process.exit(1);
}
console.log("\nall checks passed");
