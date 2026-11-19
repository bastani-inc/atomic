import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../../../test/helpers/detached-broker.js";
import { startPtyProgram } from "../../../test/helpers/pty-program.js";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { cliPath } from "./cli-test-helpers.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.js";

// Real interactive CLI, including an isolated engine child and two independent startup trust decisions.
const STARTUP_TIMEOUT_MS = 60_000;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

test(
	"lists and Tab-completes an approved project's resources while an -e source still awaits trust (#5693)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-trust-disclosure-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const source = join(root, "source");
		write(join(cwd, ".atomic/prompts/projectapproved.md"), "---\ndescription: Approved prompt\n---\nHello\n");
		write(
			join(cwd, ".atomic/skills/projectskill/SKILL.md"),
			"---\nname: projectskill\ndescription: Project skill\n---\nHello\n",
		);
		write(join(source, "extensions/source.ts"), "export default function() {}");
		write(join(source, ".atomic/prompts/source.md"), "Hello\n");
		write(join(agentDir, "prompts/globalprompt.md"), "Hello\n");
		write(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(cwd)]: true }));
		write(
			join(agentDir, "settings.json"),
			JSON.stringify({ lastChangelogVersion: "0.0.0", onboardedVersion: "0.0.0" }),
		);
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
			await cli.waitForScreen(
				(screen) => screen.includes("/globalprompt"),
				STARTUP_TIMEOUT_MS,
				"the first disclosure",
			);
			assert.doesNotMatch(cli.screen(), /projectapproved|projectskill/);
			write(approve, "");
			await cli.waitForScreen(
				(screen) =>
					existsSync(sourceAsked) && screen.includes("/projectapproved") && screen.includes("projectskill"),
				STARTUP_TIMEOUT_MS,
				"the approved project prompt and skill while the source waits",
			);
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
		} finally {
			write(finish, "");
			cli.kill();
			await cli.exited;
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	3 * STARTUP_TIMEOUT_MS,
);
