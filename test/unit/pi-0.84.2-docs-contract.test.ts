import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

/**
 * L21 doc contract for the pi 0.84.2 migration: the docs must describe every
 * door the stack shipped, must never offer a renderer mode Atomic deleted, and
 * the [Unreleased] changelog sections must carry the user-visible outcome of
 * L1–L20. A broken link between shipped behavior and shipped docs is exactly
 * the regression this suite exists to catch.
 */

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const docsDir = join(repoRoot, "packages/coding-agent/docs");

/** Every markdown file this layer shipped or touched, discovered not hardcoded. */
const docFiles = [
	...readdirSync(docsDir)
		.filter((name) => name.endsWith(".md"))
		.map((name) => [`packages/coding-agent/docs/${name}`, join(docsDir, name)] as const),
	["packages/workflows/README.md", join(repoRoot, "packages/workflows/README.md")] as const,
];

function doc(name: string): string {
	return readFileSync(join(docsDir, name), "utf8");
}

function packageFile(...parts: string[]): string {
	return readFileSync(join(repoRoot, "packages", ...parts), "utf8");
}

/** The section between one `## [` heading and the next, failing loudly when absent. */
function changelogSection(changelog: string, heading: string): string {
	const start = changelog.indexOf(`## [${heading}]`);
	assert.ok(start !== -1, `changelog must still contain a "## [${heading}]" section`);
	const end = changelog.indexOf("\n## [", start + 1);
	return changelog.slice(start, end === -1 ? undefined : end);
}

/** One `### <name>` subsection inside an already-extracted changelog section. */
function changelogSubsection(sectionText: string, name: string): string {
	const start = sectionText.indexOf(`### ${name}`);
	assert.ok(start !== -1, `the changelog section must contain a "### ${name}" subsection`);
	const end = sectionText.indexOf("\n### ", start + 1);
	return sectionText.slice(start, end === -1 ? undefined : end);
}

interface FenceMarker {
	line: number;
	length: number;
}

interface FenceScan {
	markers: FenceMarker[];
	open: FenceMarker | undefined;
}

function scanFences(lines: readonly string[]): FenceScan {
	const markers: FenceMarker[] = [];
	let open: FenceMarker | undefined;
	for (const [index, line] of lines.entries()) {
		const match = /^\s*(`{3,})/u.exec(line);
		const run = match?.[1];
		if (run === undefined) continue;
		const marker = { line: index + 1, length: run.length };
		if (open === undefined) {
			open = marker;
			markers.push(marker);
		} else if (marker.length >= open.length) {
			markers.push(marker);
			open = undefined;
		}
	}
	return { markers, open };
}
describe("pi 0.84.2 docs contract — markdown structure", () => {
	test("every fenced code block in every doc file is closed (fence parity)", () => {
		assert.ok(docFiles.length > 20, "the doc corpus was discovered, not hardcoded");
		for (const [name, path] of docFiles) {
			const lines = readFileSync(path, "utf8").split("\n");
			// A fence closes only when its backtick run is at least as long as the
			// opener. A shorter run can be literal content inside a longer wrapper.
			const scan = scanFences(lines);
			const fenceLines = scan.markers;
			const firstFenceLines = fenceLines
				.slice(0, 5)
				.map(({ line }) => line)
				.join(", ");
			assert.equal(
				scan.open,
				undefined,
				`${name} has an unclosed ${scan.open?.length ?? "unknown"}-backtick fence (markers ${fenceLines.length}, lines ${firstFenceLines}…): an unclosed code block inverts the rendering of everything after it`,
			);
		}
	});

	test("permits a four-backtick wrapper around a literal three-backtick example", () => {
		const scan = scanFences(["````markdown", "```ts", "const answer = 42;", "```", "````"]);
		assert.equal(scan.open, undefined);
		assert.equal(scan.markers.length, 2);
	});

	test("rejects a three-backtick close for a four-backtick opener", () => {
		const scan = scanFences(["````markdown", "const answer = 42;", "```"]);
		assert.deepEqual(scan.open, { line: 1, length: 4 });
	});
});

describe("pi 0.84.2 docs contract — no renderer-mode machinery", () => {
	test("no doc mentions tuiMode, --tui-mode, or a regular renderer mode", () => {
		assert.ok(docFiles.length > 20, "the doc corpus was discovered, not hardcoded");
		for (const [name, path] of docFiles) {
			const text = readFileSync(path, "utf8");
			// Atomic is fullscreen-only: the setting, the flag, and every sentence
			// offering a "regular" mode were deliberately deleted and must not return.
			for (const pattern of [/\btuiMode\b/u, /--?tui-mode/iu, /regular TUI/iu, /regular mode/iu]) {
				assert.doesNotMatch(
					text,
					pattern,
					`${name} must not mention ${String(pattern)}; Atomic is fullscreen-only`,
				);
			}
		}
	});
});

describe("pi 0.84.2 docs contract — every shipped door is documented", () => {
	test("settings.md documents fullscreenExitOutput, defaultTools, and Windows path escaping", () => {
		const settings = doc("settings.md");
		assert.match(settings, /`fullscreenExitOutput`/u);
		assert.match(settings, /"transcript"/u);
		assert.match(settings, /"resume-hint"/u);
		assert.match(settings, /`defaultTools`/u);
		assert.match(settings, /### Tools/u);
		// 46bb9a2c: both JSON spellings of a Windows path.
		assert.match(settings, /C:\/Program Files\/Git\/bin\/bash\.exe/u);
		assert.match(settings, /C:\\\\Program Files\\\\Git\\\\bin\\\\bash\.exe/u);
		// The documented settings exist in the shipped settings schema.
		const settingsTypes = packageFile("coding-agent", "src/core/settings-types.ts");
		assert.match(settingsTypes, /fullscreenExitOutput\?:/u);
		assert.match(settingsTypes, /defaultTools\?:/u);
	});

	test("themes.md documents the search colors and --use-theme", () => {
		const themes = doc("themes.md");
		assert.match(themes, /### Initial Theme/u);
		assert.match(themes, /--use-theme light\/dark/u);
		assert.match(themes, /`searchMatchBg`/u);
		assert.match(themes, /`searchMatchText`/u);
		// Fallbacks are stated where the optional tokens are described.
		assert.match(themes, /falls back to `selectedBg`/u);
		assert.match(themes, /falls back to `text`/u);
	});

	test("usage.md documents --use-theme and the exit output setting", () => {
		const usage = doc("usage.md");
		assert.match(usage, /\| `--use-theme <name\[\/name\]>` \|/u);
		assert.match(usage, /`fullscreenExitOutput`/u);
		assert.match(usage, /"resume-hint"/u);
	});

	test("keybindings.md documents the search and single-line viewport actions", () => {
		const keybindings = doc("keybindings.md");
		for (const action of [
			"tui.altScreen.lineUp",
			"tui.altScreen.lineDown",
			"tui.altScreen.search",
			"tui.altScreen.searchNext",
			"tui.altScreen.searchPrevious",
			"tui.altScreen.searchClose",
		]) {
			assert.ok(
				keybindings.includes(`| \`${action}\``),
				`keybindings.md must still document the ${action} viewport action row`,
			);
		}
		assert.match(keybindings, /`ctrl\+shift\+f` opens a find box/u);
		// The stage-chat cross-reference removed by 35f377fa5b belongs to this layer.
		assert.match(keybindings, /An attached workflow stage chat does exactly that/u);
		assert.match(keybindings, /\[Terminal setup\]\(\/terminal-setup\)/u);
		// The renderer reference tracks the installed version.
		assert.match(keybindings, /pi-tui 0\.84\.2/u);
	});

	test("environment-variables.md documents PI_TUI_ESC_TIMEOUT, the AI_AGENT marker, and the experimental gate", () => {
		const env = doc("environment-variables.md");
		assert.match(env, /`PI_TUI_ESC_TIMEOUT`/u);
		assert.match(env, /`100` over SSH and `10` otherwise/u);
		assert.match(env, /`AI_AGENT=atomic`/u);
		// The strict-sampling feature is reachable only through this gate, so the
		// gate itself must be documented where the other app variables live.
		assert.match(env, /\| `ATOMIC_EXPERIMENTAL` \| `PI_EXPERIMENTAL` \|/u);
		assert.match(env, /strict JSON-schema constrained sampling/u);
	});

	test("json.md and rpc.md document usage and endTurn on message_update", () => {
		const json = doc("json.md");
		assert.match(json, /\{"type":"message_update","usage":\{\.\.\.\}/u);
		assert.match(json, /`endTurn`/u);
		assert.match(json, /cumulative provider-reported `usage`/u);

		const rpc = doc("rpc.md");
		const streaming = rpc.slice(rpc.indexOf("### message_update"), rpc.indexOf("### tool_execution_start"));
		assert.ok(streaming.includes('"usage"'), "rpc message_update must show the usage field");
		assert.match(streaming, /"usage":\{\.\.\.\}/u);
		assert.match(streaming, /`endTurn`/u);
	});

	test("extensions.md documents expandPromptTemplates on sendUserMessage", () => {
		const extensions = doc("extensions.md");
		const send = extensions.slice(
			extensions.indexOf("### pi.sendUserMessage(content, options?)"),
			extensions.indexOf("### pi.appendEntry"),
		);
		assert.ok(send.includes("expandPromptTemplates"), "sendUserMessage must document expandPromptTemplates");
		assert.match(send, /Defaults to `false`/u);
		assert.match(send, /\/review src\/index\.ts/u);
	});

	test("terminal-setup.md documents terminal-specific fullscreen mouse behavior", () => {
		const terminal = doc("terminal-setup.md");
		// 2a9b4ebc, adapted: iTerm2 fast-trackpad workaround without a regular-mode heading.
		assert.match(terminal, /Trackpad scrolls fast\?/u);
		assert.match(terminal, /## iTerm2/u);
		assert.doesNotMatch(terminal, /### Regular TUI mode/u);
		// Ghostty fullscreen link handling.
		assert.match(terminal, /Shift\+Command/u);
		assert.match(terminal, /hover underline/u);
	});

	test("tui.md exposes the search theme tokens to extension renderers", () => {
		const tui = doc("tui.md");
		assert.match(tui, /\| General \| `text`, `accent`, `muted`, `dim`, `searchMatchText` \|/u);
		assert.match(tui, /`selectedBg`, `searchMatchBg`,/u);
	});

	test("workflows docs document find-in-stage-chat", () => {
		const workflows = doc("workflows.md");
		assert.match(workflows, /\*\*Find in stage chat\*\*/u);
		assert.match(workflows, /whole stage transcript/u);

		const readme = packageFile("workflows", "README.md");
		assert.match(readme, /Ctrl\+Shift\+F searches the attached stage chat/u);
	});
});

describe("pi 0.84.2 docs contract — changelog covers L1–L20", () => {
	test("coding-agent [Unreleased] Added carries every shipped feature", () => {
		const unreleased = changelogSection(packageFile("coding-agent", "CHANGELOG.md"), "Unreleased");
		const added = changelogSubsection(unreleased, "Added");
		for (const needle of [
			"fullscreen transcript search",
			"`fullscreenExitOutput`",
			"`defaultTools`",
			"`--use-theme <name[/name]>`",
			"`expandPromptTemplates`",
			"strict JSON-schema constrained sampling",
			"Cloudflare AI Gateway Workers AI binding",
			"`SessionNameState`",
			"`getSessionNameState()`",
		]) {
			assert.ok(added.includes(needle), `[Unreleased] Added must mention ${needle}`);
		}
		// A new export is new public surface, not a fix: it belongs under Added.
		const fixed = changelogSubsection(unreleased, "Fixed");
		assert.ok(!fixed.includes("`getSessionNameState()`"), "new SDK exports belong under ### Added");
	});

	test("coding-agent [Unreleased] Changed carries the pi 0.84.2 adoption and the Theme constructor change", () => {
		const unreleased = changelogSection(packageFile("coding-agent", "CHANGELOG.md"), "Unreleased");
		const changed = changelogSubsection(unreleased, "Changed");
		assert.match(changed, /Adopted the pi 0\.84\.2 runtime/u);
		// §5.3: the Theme constructor signature change is a public-API change and
		// belongs under ### Changed, not ### Added.
		assert.match(changed, /`Theme` constructor/u);
		const added = changelogSubsection(unreleased, "Added");
		assert.ok(!added.includes("`Theme` constructor"), "the Theme constructor change belongs under ### Changed");
	});

	test("coding-agent [Unreleased] Fixed carries the shared core defects and fullscreen repairs", () => {
		const unreleased = changelogSection(packageFile("coding-agent", "CHANGELOG.md"), "Unreleased");
		const fixed = changelogSubsection(unreleased, "Fixed");
		for (const needle of [
			"`message_update`",
			"`usage`",
			"`endTurn`",
			"`triggerTurn: false`",
			"#7887",
			"#7979",
			"#8110",
			"#7963",
			"never-named",
		]) {
			assert.ok(fixed.includes(needle), `[Unreleased] Fixed must mention ${needle}`);
		}
	});

	test("workflows [Unreleased] carries stage-chat search", () => {
		const unreleased = changelogSection(packageFile("workflows", "CHANGELOG.md"), "Unreleased");
		assert.match(unreleased, /search inside attached workflow stage chats/iu);
	});

	test("subagents [Unreleased] carries the pi 0.84.2 parity fixes", () => {
		const unreleased = changelogSection(packageFile("subagents", "CHANGELOG.md"), "Unreleased");
		assert.match(unreleased, /array-form `tools`/u);
		assert.match(unreleased, /thinking level/u);
	});

	test("released changelog sections still carry their original headings", () => {
		// The full released-section freeze is enforced against git tags by
		// test/unit/changelog.test.ts; this pins the lighter invariant that L21
		// inserted its entries only inside [Unreleased] and reordered nothing.
		const changelog = packageFile("coding-agent", "CHANGELOG.md");
		const unreleasedAt = changelog.indexOf("## [Unreleased]");
		const alphaAt = changelog.indexOf("## [0.9.14-alpha.1]");
		const stableAt = changelog.indexOf("## [0.9.13]");
		assert.ok(unreleasedAt !== -1 && alphaAt !== -1 && stableAt !== -1);
		assert.ok(unreleasedAt < alphaAt && alphaAt < stableAt, "released sections stay in descending version order");
	});
});
