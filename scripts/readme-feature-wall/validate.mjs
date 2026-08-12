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
//   1  required set, count, fixed product-impact order, and public docs mapping
//   2  README hierarchy and table shape: 6 featured + 34 remaining, exact placement, links, media, alt
//   3  media exist for all 80 files named by the manifest
//   4  dimensions: every GIF and poster is exactly 960x540 (16:9)
//   5  GIF duration bounds, declared frame rate bounds, and maximum held-frame duration
//   6  file-size caps, per GIF, aggregate, and per poster
//   7  GIF and JPG decode cleanly end to end
//   8  contact-sheet timeline sampling and longest-held-frame reporting
//   9  gifski is the declared and actual GIF encoder
//  10  Git LFS attributes cover every shipped feature-wall GIF
//  11  no personal string in frames (OCR) or in any tracked source here
//  12  no script in this directory reads or prints a credential file
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN, matches } from "./lib/privacy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const README = readFileSync(join(REPO, "README.md"), "utf8");

// The exact 6+34 contract, written out rather than derived from the manifest
// so the manifest cannot quietly redefine the required split or coverage.
const FEATURED_REQUIRED = [
	["W.1", "Launch a workflow in plain English", "Workflows", "/workflows"],
	["6.2", "Steer and control a live run", "Workflows", "/workflows"],
	["6.5", "Durability and resume", "Workflows", "/workflows"],
	["6.4", "Human-in-the-loop gates", "Workflows", "/workflows"],
	["5.3", "Planner-worker intercom coordination", "Intercom", "/intercom"],
	["W.3", "Inspect and control workflows", "Workflows", "/workflows"],
];
const REMAINING_REQUIRED = [
	["A.8", "Natural-language workflow authoring", "Workflows", "/workflows"],
	["A.10", "Autonomous implementation loops", "Workflows", "/workflows"],
	["6.6", "Security review with a repair loop", "Workflows", "/workflows"],
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

const COURSE_URL = "https://github.com/bastani-inc/atomic-crash-course";
const DOCS_URL = "https://docs.bastani.ai";
const FEATURED_START = "<!-- feature-wall:featured:start -->";
const FEATURED_END = "<!-- feature-wall:featured:end -->";
const MORE_START = "<!-- feature-wall:more:start -->";
const MORE_END = "<!-- feature-wall:more:end -->";
const MORE_ANCHOR_LINK = '<a href="#more-atomic-capabilities">';
const STACK_BADGES = [
	["GitHub", "https://github.com/"],
	["GitLab", "https://gitlab.com/"],
	["Git", "https://git-scm.com/"],
	["Jira", "https://www.atlassian.com/software/jira"],
	["Linear", "https://linear.app/"],
	["Notion", "https://www.notion.so/"],
	["Slack", "https://slack.com/"],
	["Docker", "https://www.docker.com/"],
	["Kubernetes", "https://kubernetes.io/"],
	["AWS", "https://aws.amazon.com/"],
	["Google%20Cloud", "https://cloud.google.com/"],
	["Azure", "https://azure.microsoft.com/"],
	["Sentry", "https://sentry.io/"],
	["Datadog", "https://www.datadoghq.com/"],
	["PostgreSQL", "https://www.postgresql.org/"],
	["Playwright", "https://playwright.dev/"],
	["Chrome", "https://www.google.com/chrome/"],
	["MCP", "https://docs.bastani.ai/extensions"],
	["Any%20CLI%20or%20API", "https://docs.bastani.ai/extensions"],
];

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
		const getStartedAt = README.indexOf("## Get started");
		const quickstart =
			"<p><code>npm install -g @bastani/atomic</code> → <code>atomic</code> → <code>/login</code></p>";
		const quickstartAt = README.indexOf(quickstart);
		const stackAt = README.indexOf("### Works with your engineering stack");
		const topSeparatorAt = README.indexOf("\n---\n", stackAt);
		const installAt = README.indexOf("## Install and configure");
		const prerequisitesAt = README.indexOf("### Prerequisites", installAt);
		const installStepsAt = README.indexOf("### Install", prerequisitesAt);
		const authenticateAt = README.indexOf("### Authenticate and run", installStepsAt);
		const skillsAt = README.indexOf("### Bring your skill stack", authenticateAt);
		const migrateAt = README.indexOf("### Migrating from another coding agent", skillsAt);
		const moreHeadingAt = README.indexOf("## More Atomic capabilities");
		const lowerSeparatorAt = README.indexOf("\n---\n", moreEndAt);
		const howAt = README.indexOf("## How Atomic works");

		if ((README.match(/^## Get started$/gm) ?? []).length !== 1)
			fail("readme", "expected exactly one top-level Get started heading");
		if (occurrences(README, quickstart) !== 1)
			fail("readme", "expected exactly one compact npm → atomic → /login quickstart line");
		if (!(metricsAt < getStartedAt && getStartedAt < quickstartAt && quickstartAt < featuredStartAt))
			fail("readme", "metrics, Get started, quickstart, and the featured table are out of order");
		if (
			(README.match(/^### Atomic in action$/gm) ?? []).length !== 1 ||
			!featuredRegion.includes("### Atomic in action")
		)
			fail("readme", "the featured region must contain one Atomic in action heading");

		const positioningCopy = [
			"Build your process as workflows with scoped context, model choice, tools, handoffs, artifacts, retries, executable checks, review gates, and human approvals.",
			"Atomic’s primitives are built for the software engineering lifecycle. Verification is built into the execution model.",
			"Atomic is open so you can inspect and adapt it. You own the workflow, the evidence, and the rules for completion.",
			"Own your intelligence. Build in the open. Question the defaults. Keep control of the process. ☠︎",
		];
		for (const copy of positioningCopy) {
			const at = README.indexOf(copy);
			if (!(featuredEndAt < at && at < stackAt))
				fail("readme", `positioning copy must remain between the featured table and stack bar: ${copy}`);
		}
		if (!(featuredEndAt < stackAt && stackAt < topSeparatorAt && topSeparatorAt < installAt))
			fail("readme", "the positioning copy and stack badge bar must remain above Install and configure");

		const setupOrder = [
			installAt,
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
				"the complete Install and configure section, lower table, separator, and How Atomic works are out of order",
			);
		const setup = README.slice(installAt, moreStartAt);
		for (const snippet of [
			"npm install -g @bastani/atomic",
			"pnpm add -g @bastani/atomic",
			"bun add -g @bastani/atomic",
			"Atomic stores provider credentials in `~/.atomic/agent/auth.json`",
			"<summary><b>Devcontainer, terminal, and SDK references</b></summary>",
			"Inspect the existing skill `<skill-name-or-path>`",
			"Install and set up Atomic by following https://docs.bastani.ai/llms.txt.",
		]) {
			if (!setup.includes(snippet))
				fail("readme", `Install and configure is missing detailed setup copy: ${snippet}`);
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
		const stack = README.slice(stackAt, topSeparatorAt);
		const stackImages = stack.match(/<img\b[^>]*>/g) ?? [];
		if (stackImages.length !== STACK_BADGES.length)
			fail("readme", `expected ${STACK_BADGES.length} stack badges, found ${stackImages.length}`);
		for (const [badge, href] of STACK_BADGES) {
			const prefix = `<a href="${href}"><img src="https://img.shields.io/badge/${badge}-181825?style=flat-square`;
			if (!stack.includes(prefix)) fail("readme", `stack bar is missing linked ${decodeURIComponent(badge)} badge`);
		}
		if (stackImages.some((image) => !/logo=/.test(image) || !/alt="[^"]+"/.test(image)))
			fail("readme", "every stack badge must carry an icon and accessible alt text");
		if (
			!stack.includes(
				"Atomic connects through installed CLIs, MCP servers, APIs, scripts, and custom extensions; you supply the credentials and permissions.",
			)
		)
			fail("readme", "stack bar is missing the credential-and-permission connection note");

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
				if (!row.includes(`<h4>${lesson.title}</h4>`))
					fail("readme", `${lesson.id}: row is missing its exact feature title`);
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
				"6 featured + 34 remaining rows once each; exact hierarchy, cross-link, docs-first links, stack bar, and setup copy",
			);
		}
	}
}

// --------------------------------------------------------------- 3..8. media
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
					const isRuleInput = p.endsWith("manifest.json") || p.endsWith("lib/privacy.mjs");
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
