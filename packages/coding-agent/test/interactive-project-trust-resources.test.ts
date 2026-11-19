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
	run: (cli: PtyProgram, approveProject: () => Promise<void>, settleSource: () => void) => Promise<void>,
	setup?: ((project: string, agentDir: string) => void) | ((project: string, agentDir: string) => Promise<string[]>),
	host: "isolated" | "in-process" = "isolated",
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
	write(
		join(agentDir, "settings.json"),
		JSON.stringify({
			lastChangelogVersion: "0.0.0",
			onboardedVersion: "0.0.0",
			...(host === "in-process" ? { sessions: { storage: { memory: true } } } : {}),
		}),
	);
	const projectAsked = join(root, "checking-project");
	const approve = join(root, "approve-project");
	const sourceAsked = join(root, "checking-source");
	const finish = join(root, "finish-source");
	// No screen element has to change at approval. Observe the host's existing notification so a negative assertion
	// cannot pass just because the engine answered before its host processed the decision.
	const published = join(root, "host-published");
	const observe = join(root, "observe.mjs");
	write(
		observe,
		`import { writeFileSync } from 'node:fs';
		import { IsolatedInteractiveRuntime } from ${JSON.stringify(new URL("../src/modes/interactive-engine/isolated-runtime.ts", import.meta.url).href)};
		const proto = IsolatedInteractiveRuntime.prototype;
		const subscribe = proto.onProjectTrustChanged;
		proto.onProjectTrustChanged = function(listener) {
			return subscribe.call(this, (...args) => { listener(...args);
				if (this.session.settingsManager.isProjectTrusted()) queueMicrotask(() => writeFileSync(${JSON.stringify(published)}, ''));
			});
		};`,
	);
	write(
		join(agentDir, "extensions/policy.ts"),
		`
		import { existsSync, writeFileSync } from 'node:fs';
		import { relative } from 'node:path';
		export default function(pi) {
			pi.on('project_trust', async (event) => {
				const project = relative(process.cwd(), event.cwd) === '';
				writeFileSync(project ? ${JSON.stringify(projectAsked)} : ${JSON.stringify(sourceAsked)}, '');
				const release = project ? ${JSON.stringify(approve)} : ${JSON.stringify(finish)};
				while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 50));
				return { trusted: project ? 'yes' : 'no' };
			});
		}
	`,
	);
	const sessionArgs = (await setup?.(cwd, agentDir)) ?? (host === "in-process" ? [] : ["--no-session"]);
	linkSharedTranspileCache(agentDir);
	const cli = startPtyProgram({
		executable: bunExecutable(),
		args: ["--preload", observe, cliPath, "--offline", ...sessionArgs, "-e", source],
		cwd,
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, HOME: root, USERPROFILE: root, TERM: "xterm-256color", CI: "0" },
		cols: 160,
		rows: 60,
		timeoutMs: 2 * STARTUP_TIMEOUT_MS,
	});
	try {
		await cli.waitForScreen(
			(s) => (host === "isolated" ? s.includes("/globaltwo") : existsSync(projectAsked) && s.includes("❯")),
			STARTUP_TIMEOUT_MS,
			"the pending interface",
		);
		assert.doesNotMatch(cli.screen(), /projectapproved|projectskill/);
		await run(
			cli,
			async () => {
				write(approve, "");
				await cli.waitForScreen(
					() => existsSync(sourceAsked) && (host === "in-process" || existsSync(published)),
					STARTUP_TIMEOUT_MS,
					"the host's folder decision while the independent source waits",
				);
			},
			() => write(finish, ""),
		);
	} finally {
		write(approve, "");
		write(finish, "");
		cli.kill();
		await cli.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

test(
	"the workflow migration notice waits for the engine's trusted inventory",
	() =>
		withPendingProject(
			async (cli, approveProject, settleSource) => {
				assert.doesNotMatch(cli.screen(), /Found \d+ legacy workflow files?/);
				await approveProject();
				settleSource();
				await cli.waitForScreen(
					(screen) => screen.includes("Found 2 legacy workflow files"),
					STARTUP_TIMEOUT_MS,
					"the migration hint for the approved project and package",
				);
			},
			(project) => {
				write(join(project, ".atomic/workflows/check.ts"), "export default {};");
				const source = join(dirname(project), "source");
				write(join(source, "workflows/packaged.ts"), "export default {};");
				write(join(source, ".atomic/workflows/declined.ts"), "export default {};");
			},
		),
	3 * STARTUP_TIMEOUT_MS,
);

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

test.each(["isolated", "in-process"] as const)(
	"a newly opened light-theme picker in an existing automatic-theme form reads the %s host's eligible themes (#5693)",
	(host) =>
		withPendingProject(
			async (cli, approveProject, settleSource) => {
				cli.write("/settings\r");
				await cli.waitForScreen((s) => s.includes("Search settings"), STARTUP_TIMEOUT_MS, "Settings");
				cli.write("theme");
				await cli.waitForScreen((s) => s.includes("⌕ theme"), STARTUP_TIMEOUT_MS, "the theme setting");
				cli.write("\r");
				await cli.waitForScreen((s) => /❯ Light theme +light/.test(s), STARTUP_TIMEOUT_MS, "the automatic pair");
				await approveProject();
				if (host === "in-process") {
					settleSource();
					await cli.waitForScreen(
						(s) => s.includes("/projectapproved"),
						STARTUP_TIMEOUT_MS,
						"the theme inventory",
					);
				}
				assert.match(cli.screen(), /❯ Light theme +light/);
				cli.write("\r");
				await cli.waitForScreen(
					(s) => s.includes("Select the theme to use for light terminal appearance"),
					STARTUP_TIMEOUT_MS,
					"the light-theme picker",
				);
				assert.match(cli.screen(), /❯ ● catppuccin-latte/);
				assert.match(cli.screen(), /○ folder-extra/);
			},
			(project, agentDir) => {
				const settingsFile = join(agentDir, "settings.json");
				write(
					settingsFile,
					JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, "utf8")), theme: "light/dark" }),
				);
				write(
					join(project, ".atomic/settings.json"),
					JSON.stringify({ theme: "catppuccin-latte/catppuccin-mocha" }),
				);
				const theme = JSON.parse(
					readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
				);
				write(
					join(project, ".atomic/themes/folder-extra.json"),
					JSON.stringify({ ...theme, name: "folder-extra" }),
				);
			},
			host,
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"an already open theme picker keeps its choices and selection when the project is approved (#5693)",
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
				assert.doesNotMatch(cli.screen(), /approved-theme/);
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
	"a %s picker saves to its original scope, and the next picker uses the approved project (#5693)",
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
				assert.match(cli.screen(), /Saves to global settings\./);
				assert.doesNotMatch(cli.screen(), /fixture\/project/);
				cli.write("\r");
				await cli.waitForScreen(
					(s) => s.includes(`⌕ ${kind} model`) && JSON.parse(readFileSync(globalSettings, "utf8"))[key] === "",
					STARTUP_TIMEOUT_MS,
					"the original choice saved to global settings",
				);
				assert.equal(JSON.parse(readFileSync(projectSettings, "utf8"))[key], "fixture/project");
				cli.write("\r");
				await cli.waitForScreen(
					(s) => s.includes("Saves to project settings."),
					STARTUP_TIMEOUT_MS,
					"the new picker",
				);
				assert.match(cli.screen(), /❯ ● fixture\/project/);
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
	"a scoped model list opened while trust was pending retains its enabled rows when the catalog finishes (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject, settleSource) => {
				cli.write("/scoped-models\r");
				await cli.waitForScreen((s) => s.includes("all enabled"), STARTUP_TIMEOUT_MS, "the scoped model list");
				await approveProject();
				settleSource();
				await cli.waitForScreen(
					(s) => s.includes("Model catalogs refreshed"),
					STARTUP_TIMEOUT_MS,
					"the catalog response",
				);
				assert.match(cli.screen(), /all enabled/);
				assert.doesNotMatch(cli.screen(), /\[✓\] fixture\/project-only/);
				cli.write("\x1b");
				await cli.waitForScreen((s) => !s.includes("Scoped models"), STARTUP_TIMEOUT_MS, "the editor");
				cli.write("/scoped-models\r");
				await cli.waitForScreen(
					(s) => /\[✓\] fixture\/project-only/.test(s),
					STARTUP_TIMEOUT_MS,
					"the new scoped model list",
				);
			},
			(project) =>
				write(join(project, ".atomic/settings.json"), JSON.stringify({ enabledModels: ["fixture/project-only"] })),
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"an open model picker keeps its effort and default; a later picker reads the project (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject, settleSource) => {
				cli.write("/model\r");
				await cli.waitForScreen(
					(s) => /○ fixture\/project-model +medium/.test(s),
					STARTUP_TIMEOUT_MS,
					"the initial effort",
				);
				await approveProject();
				settleSource();
				await cli.waitForScreen(
					(s) => s.includes("Model catalogs refreshed"),
					STARTUP_TIMEOUT_MS,
					"the catalog response",
				);
				assert.match(cli.screen(), /○ fixture\/project-model +medium/);
				cli.write("\x1b");
				await cli.waitForScreen((s) => !s.includes("Select model"), STARTUP_TIMEOUT_MS, "the editor");
				cli.write("/model\r");
				await cli.waitForScreen(
					(s) => /fixture\/project-model +high/.test(s) && s.includes("Select model"),
					STARTUP_TIMEOUT_MS,
					"the new model picker",
				);
			},
			(project, agentDir) => {
				const settingsFile = join(agentDir, "settings.json");
				write(
					settingsFile,
					JSON.stringify({
						...JSON.parse(readFileSync(settingsFile, "utf8")),
						defaultProvider: "fixture",
						defaultModel: "global-model",
					}),
				);
				write(
					join(project, ".atomic/settings.json"),
					JSON.stringify({
						defaultProvider: "fixture",
						defaultModel: "project-model",
						modelThinkingLevels: { "fixture/project-model": "high" },
					}),
				);
				write(
					join(agentDir, "models.json"),
					JSON.stringify({
						providers: {
							fixture: {
								baseUrl: "http://127.0.0.1:9",
								api: "openai-completions",
								apiKey: "fixture",
								models: ["global-model", "project-model"].map((id) => ({
									id,
									name: id,
									reasoning: true,
									contextWindow: 32000,
									maxTokens: 1000,
								})),
							},
						},
					}),
				);
			},
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"approving the folder is not a reload of the user's settings file (#5693)",
	async () => {
		let userSettings = "";
		const updateTreeFilter = (value: string) =>
			write(
				userSettings,
				JSON.stringify({ ...JSON.parse(readFileSync(userSettings, "utf8")), treeFilterMode: value }),
			);
		await withPendingProject(
			async (cli, approveProject) => {
				updateTreeFilter("user-only");
				await approveProject();
				cli.write("/settings\r");
				await cli.waitForScreen((s) => s.includes("Search settings"), STARTUP_TIMEOUT_MS, "Settings");
				cli.write("tree filter");
				await cli.waitForScreen((s) => s.includes("⌕ tree filter"), STARTUP_TIMEOUT_MS, "the tree setting");
				assert.match(cli.screen(), /❯ Tree filter mode +all/);
			},
			(_project, agentDir) => {
				userSettings = join(agentDir, "settings.json");
				updateTreeFilter("all");
			},
		);
	},
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"the user's thinking visibility wins over a project setting loaded later (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject) => {
				cli.write("/settings\r");
				await cli.waitForScreen((s) => s.includes("Search settings"), STARTUP_TIMEOUT_MS, "Settings");
				cli.write("hide thinking");
				await cli.waitForScreen((s) => /❯ Hide thinking +false/.test(s), STARTUP_TIMEOUT_MS, "Hide thinking");
				cli.write("\r");
				await cli.waitForScreen((s) => /❯ Hide thinking +true/.test(s), STARTUP_TIMEOUT_MS, "the choice");
				await approveProject();
				cli.write("\x1b");
				await cli.waitForScreen((s) => !s.includes("⌕ hide thinking"), STARTUP_TIMEOUT_MS, "the cleared filter");
				cli.write("\x1b");
				await cli.waitForScreen((s) => !s.includes("Search settings"), STARTUP_TIMEOUT_MS, "the editor");
				cli.write("\x1b[19~"); // F8
				await cli.waitForScreen((s) => s.includes("Thinking blocks:"), STARTUP_TIMEOUT_MS, "the next toggle");
				assert.match(cli.screen(), /Thinking blocks: visible/);
			},
			(project, agentDir) => {
				write(join(project, ".atomic/settings.json"), JSON.stringify({ hideThinkingBlock: false }));
				write(join(agentDir, "keybindings.json"), JSON.stringify({ "app.thinking.toggle": "f8" }));
			},
		),
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
	"keeps the presentation of resumed messages already on screen when the project is approved (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject) => {
				await cli.waitForScreen(
					(screen) => screen.includes("saved reply text"),
					STARTUP_TIMEOUT_MS,
					"the restored messages",
				);
				const messageRows = () =>
					cli
						.screen()
						.split("\n")
						.filter((line) =>
							/saved thinking text|indent-mark|LaTeX|saved reply text|SavedBox|flowchart LR/.test(line),
						);
				const before = messageRows();
				assert.ok(before.some((line) => line.includes("saved thinking text")));
				assert.ok(
					before.some((line) => line.includes("SavedBox")) &&
						!before.some((line) => line.includes("flowchart LR")),
				);
				await approveProject();
				assert.deepEqual(messageRows(), before);
			},
			async (project, agentDir) => {
				write(
					join(project, ".atomic/settings.json"),
					JSON.stringify({
						outputPad: 0,
						hideThinkingBlock: true,
						markdown: { latex: false, codeBlockIndent: "      ", mermaid: "off" },
					}),
				);
				const storePath = join(agentDir, "saved.sqlite");
				const store = await resolveSessionStore(project, { agentDir, sessionStorePath: storePath });
				try {
					const manager = await SessionManager.create(store, project);
					await manager.appendMessage({
						role: "user",
						content:
							"```\nindent-mark\n```\n\nLaTeX $\\alpha$\n\n```mermaid\nflowchart LR\nA[SavedBox] --> B[Next]\n```",
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
	"delivers a click on the visible Prompts section across approval (#5693)",
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
				(screen) => /\[Prompts\]\s+user\s/.test(screen),
				5000,
				"the expanded original prompts",
			);
		}),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"keeps the contents and expansion of mounted resource sections on project approval (#5693)",
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
			assert.match(cli.screen(), /\[Prompts\]\s+user\s/);
			assert.doesNotMatch(cli.screen(), /projectapproved/);
		}),
	3 * STARTUP_TIMEOUT_MS,
);

test.each(["cwd decision", "startup settlement"])(
	"a new child of a still-mounted in-process Settings form uses the folder setting at %s (#5693)",
	(cut) =>
		withPendingProject(
			async (cli, approveProject, settleSource) => {
				cli.write("/settings\r");
				await cli.waitForScreen((s) => s.includes("Search settings"), STARTUP_TIMEOUT_MS, "Settings");
				cli.write("decision model");
				await cli.waitForScreen(
					(s) => /❯ Decision model +Automatic/.test(s),
					STARTUP_TIMEOUT_MS,
					"the original parent",
				);
				await approveProject();
				if (cut === "startup settlement") {
					settleSource();
					await cli.waitForScreen(
						(s) => s.includes("/projectapproved"),
						STARTUP_TIMEOUT_MS,
						"startup publication",
					);
				} else {
					assert.doesNotMatch(cli.screen(), /\/projectapproved/);
				}
				assert.match(cli.screen(), /❯ Decision model +Automatic/);
				cli.write("\r");
				await cli.waitForScreen((s) => s.includes("A classifier answers"), STARTUP_TIMEOUT_MS, "the new child");
				assert.match(cli.screen(), /Saves to project settings\./);
				assert.match(cli.screen(), /❯ ● fixture\/project/);
			},
			(project) =>
				write(join(project, ".atomic/settings.json"), JSON.stringify({ decisionModel: "fixture/project" })),
			"in-process",
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"the in-process host keeps a file menu when the remaining source settles (#5693)",
	() =>
		withPendingProject(
			async (cli, approveProject, settleSource) => {
				cli.write("@demo");
				await cli.waitForScreen((s) => /❯ demo0\.txt/.test(s), STARTUP_TIMEOUT_MS, "the first file");
				const row =
					cli
						.screen()
						.split("\n")
						.findIndex((line) => line.trim() === "demo1.txt") + 1;
				assert.ok(row > 0);
				cli.write(`\x1b[<0;8;${row}M`);
				await cli.waitForScreen((s) => /❯ demo1\.txt/.test(s), STARTUP_TIMEOUT_MS, "the pressed file");
				await approveProject();
				settleSource();
				await cli.waitForScreen(
					(s) => s.includes("/projectapproved"),
					STARTUP_TIMEOUT_MS,
					"the in-process publication",
				);
				assert.match(cli.screen(), /❯ demo1\.txt/);
				cli.write(`\x1b[<0;8;${row}m`);
				await cli.waitForScreen((s) => /❯ @demo1\.txt/.test(s), 5_000, "release commits the pressed file");
			},
			(project) => {
				for (let i = 0; i < 6; i++) write(join(project, `demo${i}.txt`), "Hello");
			},
			"in-process",
		),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"keeps the visible completion menu and its selected row across approval (#5693)",
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
			assert.doesNotMatch(cli.screen(), /Project exact match/);
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
