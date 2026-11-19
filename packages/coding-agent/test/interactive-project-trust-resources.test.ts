import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../../../test/helpers/detached-broker.js";
import { type PtyProgram, startPtyProgram } from "../../../test/helpers/pty-program.js";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { cliPath } from "./cli-test-helpers.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.js";

// Real interactive CLI, including an isolated engine child and two independent startup trust decisions.
const STARTUP_TIMEOUT_MS = 60_000;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function withPendingProject(run: (cli: PtyProgram, approveProject: () => Promise<void>) => Promise<void>) {
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
	linkSharedTranspileCache(agentDir);
	const cli = startPtyProgram({
		executable: bunExecutable(),
		args: [cliPath, "--offline", "--no-session", "-e", source],
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
			await cli.waitForScreen((screen) => /❯ globalone\s/.test(screen), STARTUP_TIMEOUT_MS, "the open menu");
			cli.write("\x1b[B");
			await cli.waitForScreen((screen) => /❯ globaltwo\s/.test(screen), STARTUP_TIMEOUT_MS, "the second completion");
			await approveProject();
			await cli.waitForScreen(
				(screen) => screen.includes("Project exact match"),
				STARTUP_TIMEOUT_MS,
				"the new completion",
			);
			assert.match(cli.screen(), /❯ globaltwo\s/);
			cli.write("\t");
			await cli.waitForScreen(
				(screen) => /❯\s*\/globaltwo\s*$/m.test(screen),
				STARTUP_TIMEOUT_MS,
				"the selected completion in the editor",
			);
		}),
	3 * STARTUP_TIMEOUT_MS,
);
