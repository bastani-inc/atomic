import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../../../test/helpers/detached-broker.js";
import { type PtyProgram, startPtyProgram } from "../../../test/helpers/pty-program.js";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.ts";
import { cliPath } from "./cli-test-helpers.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.js";

// Real interactive CLI, including an isolated engine child and two independent startup trust decisions.
const STARTUP_TIMEOUT_MS = 60_000;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function withPendingProject(
	run: (cli: PtyProgram, approveProject: () => Promise<void>) => Promise<void>,
	setup?: ((project: string, agentDir: string) => void) | ((project: string, agentDir: string) => Promise<string[]>),
) {
	const root = mkdtempSync(join(tmpdir(), "atomic-trust-disclosure-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const source = join(root, "source");
	write(join(cwd, ".atomic/prompts/projectapproved.md"), "---\ndescription: Approved prompt\n---\nHello\n");
	write(join(cwd, ".atomic/prompts/global.md"), "---\ndescription: Project exact match\n---\nHello\n");
	write(
		join(cwd, ".atomic/skills/projectskill/SKILL.md"),
		"---\nname: projectskill\ndescription: Project skill\n---\nHello\n",
	);
	write(join(source, "extensions/source.ts"), "export default function() {}");
	write(join(source, ".atomic/prompts/source.md"), "Hello\n");
	for (const name of ["globalone", "globaltwo"]) {
		write(join(agentDir, `prompts/${name}.md`), `---\ndescription: ${name} example\n---\nHello\n`);
	}
	write(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(cwd)]: true }));
	write(join(agentDir, "settings.json"), JSON.stringify({ lastChangelogVersion: "0.0.0", onboardedVersion: "0.0.0" }));
	const approve = join(root, "approve-project");
	const sourceAsked = join(root, "checking-source");
	const finish = join(root, "finish-source");
	write(
		join(agentDir, "extensions/policy.ts"),
		`
		import { existsSync, writeFileSync } from 'node:fs';
		import { relative } from 'node:path';
		export default function(pi) {
			pi.on('project_trust', async (event) => {
				const project = relative(process.cwd(), event.cwd) === '';
				if (!project) writeFileSync(${JSON.stringify(sourceAsked)}, '');
				const release = project ? ${JSON.stringify(approve)} : ${JSON.stringify(finish)};
				while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 50));
				return { trusted: project ? 'yes' : 'no' };
			});
		}
	`,
	);
	const sessionArgs = (await setup?.(cwd, agentDir)) ?? ["--no-session"];
	linkSharedTranspileCache(agentDir);
	const cli = startPtyProgram({
		executable: bunExecutable(),
		args: [cliPath, "--offline", ...sessionArgs, "-e", source],
		cwd,
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, HOME: root, USERPROFILE: root, TERM: "xterm-256color", CI: "0" },
		cols: 160,
		rows: 60,
		timeoutMs: 2 * STARTUP_TIMEOUT_MS,
	});
	try {
		await cli.waitForScreen((screen) => screen.includes("/globaltwo"), STARTUP_TIMEOUT_MS, "the first disclosure");
		assert.doesNotMatch(cli.screen(), /projectapproved|projectskill/);
		await run(cli, async () => {
			write(approve, "");
			await cli.waitForScreen(
				(screen) =>
					existsSync(sourceAsked) && screen.includes("/projectapproved") && screen.includes("projectskill"),
				STARTUP_TIMEOUT_MS,
				"the approved project prompt and skill while the source waits",
			);
		});
	} finally {
		write(approve, "");
		write(finish, "");
		cli.kill();
		await cli.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

test(
	"lists and Tab-completes an approved project's resources while an -e source still awaits trust (#5693)",
	() =>
		withPendingProject(async (cli, approveProject) => {
			await approveProject();
			cli.write("/projectapp");
			await cli.waitForScreen(
				(screen) => /❯\s*\/projectapp\s*$/m.test(screen),
				STARTUP_TIMEOUT_MS,
				"the typed prefix",
			);
			cli.write("\t");
			await cli.waitForScreen(
				(screen) => /❯\s*\/projectapproved\s*$/m.test(screen),
				STARTUP_TIMEOUT_MS,
				"Tab completion",
			);
		}),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"offers approved project themes in Settings without a reload (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject) => {
				await approveProject();
				cli.write("/settings\r");
				await cli.waitForScreen((screen) => screen.includes("Search settings"), STARTUP_TIMEOUT_MS, "Settings");
				cli.write("theme");
				await cli.waitForScreen(
					(screen) => screen.includes("⌕ theme"),
					STARTUP_TIMEOUT_MS,
					"the filtered settings",
				);
				cli.write("\r");
				await cli.waitForScreen(
					(screen) => screen.includes("Select a theme"),
					STARTUP_TIMEOUT_MS,
					"the theme picker",
				);
				assert.match(cli.screen(), /○ approved-theme/);
			},
			(project) => {
				const theme = JSON.parse(
					readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
				);
				write(
					join(project, ".atomic/themes/approved-theme.json"),
					JSON.stringify({ ...theme, name: "approved-theme" }),
				);
			},
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"an open theme picker gains the approved project theme without losing its selection (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject) => {
				cli.write("/settings\r");
				await cli.waitForScreen((screen) => screen.includes("Search settings"), STARTUP_TIMEOUT_MS, "Settings");
				cli.write("theme");
				await cli.waitForScreen(
					(screen) => screen.includes("⌕ theme"),
					STARTUP_TIMEOUT_MS,
					"the filtered settings",
				);
				cli.write("\r");
				await cli.waitForScreen(
					(screen) => screen.includes("Select a theme"),
					STARTUP_TIMEOUT_MS,
					"the theme picker",
				);
				cli.write("\x1b[A");
				await cli.waitForScreen(
					(screen) => /❯ ○ catppuccin-mocha/.test(screen),
					STARTUP_TIMEOUT_MS,
					"the highlighted theme",
				);
				await approveProject();
				assert.match(cli.screen(), /○ approved-theme/);
				assert.match(cli.screen(), /❯ ○ catppuccin-mocha/);
			},
			(project) => {
				const theme = JSON.parse(
					readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
				);
				write(
					join(project, ".atomic/themes/approved-theme.json"),
					JSON.stringify({ ...theme, name: "approved-theme" }),
				);
			},
		),
	3 * STARTUP_TIMEOUT_MS,
);

test.each(["decision", "compaction"] as const)(
	"an open %s model picker reads and writes the approved project setting (#5693)",
	async (kind) => {
		const key = `${kind}Model`;
		let projectSettings = "";
		let globalSettings = "";
		await withPendingProject(
			async (cli, approveProject) => {
				cli.write("/settings\r");
				await cli.waitForScreen((s) => s.includes("Search settings"), STARTUP_TIMEOUT_MS, "Settings");
				cli.write(`${kind} model`);
				await cli.waitForScreen((s) => s.includes(`⌕ ${kind} model`), STARTUP_TIMEOUT_MS, "the filtered setting");
				cli.write("\r");
				await cli.waitForScreen(
					(s) => s.includes("Saves to global settings."),
					STARTUP_TIMEOUT_MS,
					"the model picker",
				);
				await approveProject();
				assert.match(cli.screen(), /Saves to project settings\./);
				assert.match(cli.screen(), /❯ ● fixture\/project/);
				cli.write("Auto");
				await cli.waitForScreen((s) => /❯ ○ Auto/.test(s), STARTUP_TIMEOUT_MS, "the automatic option");
				cli.write("\r");
				await cli.waitForScreen(
					() => JSON.parse(readFileSync(projectSettings, "utf8"))[key] === "",
					STARTUP_TIMEOUT_MS,
					"the choice saved to project settings",
				);
				assert.equal(JSON.parse(readFileSync(globalSettings, "utf8"))[key], undefined);
			},
			(project, agentDir) => {
				projectSettings = join(project, ".atomic/settings.json");
				globalSettings = join(agentDir, "settings.json");
				write(projectSettings, JSON.stringify({ [key]: "fixture/project" }));
			},
		);
	},
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"applies the project's editor padding and visible completion count at approval (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject) => {
				await approveProject();
				cli.write("/global");
				await cli.waitForScreen(
					(screen) => screen.includes("Project exact match"),
					STARTUP_TIMEOUT_MS,
					"the approved prompt in the menu",
				);
				assert.match(cli.screen(), /❯ {4}\/global\s*$/m);
				assert.match(cli.screen(), /↓ 4 more/);
			},
			(project, agentDir) => {
				write(
					join(project, ".atomic/settings.json"),
					JSON.stringify({ editorPaddingX: 3, autocompleteMaxVisible: 3 }),
				);
				for (let i = 0; i < 4; i++) write(join(agentDir, `prompts/globalextra${i}.md`), "Hello\n");
			},
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"applies project rendering settings to resumed messages already on screen (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject) => {
				await cli.waitForScreen(
					(screen) => screen.includes("saved reply text"),
					STARTUP_TIMEOUT_MS,
					"the restored messages",
				);
				assert.match(cli.screen(), /saved thinking text/);
				await approveProject();
				assert.doesNotMatch(cli.screen(), /saved thinking text/);
				assert.match(cli.screen(), /^ {6}indent-mark\s*$/m);
				assert.match(cli.screen(), /^LaTeX \$\\alpha\$/m);
			},
			async (project, agentDir) => {
				write(
					join(project, ".atomic/settings.json"),
					JSON.stringify({
						outputPad: 0,
						hideThinkingBlock: true,
						markdown: { latex: false, codeBlockIndent: "      " },
					}),
				);
				const storePath = join(agentDir, "saved.sqlite");
				const store = await resolveSessionStore(project, { agentDir, sessionStorePath: storePath });
				try {
					const manager = await SessionManager.create(store, project);
					await manager.appendMessage({
						role: "user",
						content: "```\nindent-mark\n```\n\nLaTeX $\\alpha$",
						timestamp: 1,
					});
					await manager.appendMessage({
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "saved thinking text" },
							{ type: "text", text: "saved reply text" },
						],
						api: "openai-completions",
						provider: "example",
						model: "example",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					});
					return ["--session-store", storePath, "--session", manager.getSessionId()];
				} finally {
					await store.close();
				}
			},
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"delivers a click on Prompts even when approval adds prompts before the click settles (#5693)",
	() =>
		withPendingProject(async (cli, approveProject) => {
			const row =
				cli
					.screen()
					.split("\n")
					.findIndex((line) => line.trim() === "[Prompts]") + 1;
			assert.ok(row > 0);
			cli.write(`\x1b[<0;5;${row}M\x1b[<0;5;${row}m`);
			await approveProject();
			await cli.waitForScreen(
				(screen) => /\[Prompts\]\s+project\s/.test(screen),
				5000,
				"the expanded approved prompts",
			);
		}),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"keeps expanded resource sections when project approval updates their contents (#5693)",
	() =>
		withPendingProject(async (cli, approveProject) => {
			const open = async (name: string, expanded: RegExp) => {
				const row =
					cli
						.screen()
						.split("\n")
						.findIndex((line) => line.trim() === `[${name}]`) + 1;
				assert.ok(row > 0);
				cli.write(`\x1b[<0;5;${row}M\x1b[<0;5;${row}m`);
				await cli.waitForScreen((screen) => expanded.test(screen), STARTUP_TIMEOUT_MS, `expanded ${name}`);
			};
			const extensionPath = /extensions[/\\]policy\.ts/;
			await open("Extensions", extensionPath);
			await open("Prompts", /\[Prompts\]\s+user\s/);
			await approveProject();
			assert.match(cli.screen(), extensionPath);
			assert.match(cli.screen(), /\[Prompts\]\s+project\s/);
		}),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"keeps the selected completion when project approval adds a better match (#5693)",
	() =>
		withPendingProject(async (cli, approveProject) => {
			cli.write("/global");
			const highlighted = (screen: string) => /❯ (globalone|globaltwo)\s/.exec(screen)?.[1];
			await cli.waitForScreen((screen) => !!highlighted(screen), STARTUP_TIMEOUT_MS, "the open menu");
			// These two matches have equal scores; either file can be discovered first.
			const second = highlighted(cli.screen()) === "globalone" ? "globaltwo" : "globalone";
			cli.write("\x1b[B");
			await cli.waitForScreen(
				(screen) => highlighted(screen) === second,
				STARTUP_TIMEOUT_MS,
				"the second completion",
			);
			await approveProject();
			await cli.waitForScreen(
				(screen) => screen.includes("Project exact match"),
				STARTUP_TIMEOUT_MS,
				"the new completion",
			);
			assert.equal(highlighted(cli.screen()), second);
			cli.write("\t");
			await cli.waitForScreen(
				(screen) => screen.split("\n").some((line) => line.trim() === `❯ /${second}`),
				STARTUP_TIMEOUT_MS,
				"the selected completion in the editor",
			);
		}),
	3 * STARTUP_TIMEOUT_MS,
);
