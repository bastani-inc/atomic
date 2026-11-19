import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const CLI_TIMEOUT_MS = 90_000;

test.each(["CLI", "embedding with a pending flush"])(
	"quitting while post-trust extension loading resumes exits cleanly (%s, #5639)",
	async (host) => {
		const root = makeTempDirectory("atomic-quit-during-startup-");
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		const installed = join(root, "installed");
		const extension = join(root, "startup.ts");
		const loading = join(root, "loading");
		const quitting = join(root, "quitting");
		let program: PtyProgram | undefined;
		try {
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			prepareInstalledPackage(PACKAGE, installed);
			mkdirSync(join(project, ".atomic"), { recursive: true });
			writeFileSync(join(project, ".atomic/settings.json"), "{}");
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				extension,
				`import { writeFileSync } from "node:fs";
export default (pi) => pi.on("session_shutdown", event => {
	if (event.reason === "quit") writeFileSync(${JSON.stringify(quitting)}, "");
});`,
			);
			program = startPtyProgram({
				executable: process.execPath,
				args: [
					...(host === "CLI"
						? [join(PACKAGE, "dist/cli.js")]
						: [join(moduleDir(import.meta.url), "../fixtures/startup-flush.mjs"), root]),
					"--offline",
					"--no-mcp",
					"-e",
					extension,
				],
				cwd: project,
				env: {
					HOME: root,
					USERPROFILE: root,
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_PACKAGE_DIR: installed,
					ATOMIC_SKIP_VERSION_CHECK: "1",
					ATOMIC_TELEMETRY: "0",
					TERM: "xterm-256color",
				},
				timeoutMs: CLI_TIMEOUT_MS,
				cols: 120,
				rows: 40,
			});
			await program.waitForScreen(
				(screen) => screen.includes("Do not trust (this session only)"),
				CLI_TIMEOUT_MS,
				"trust question",
			);
			// Installed after the question opened: this factory holds only the final load, ahead of the bundled providers.
			writeFileSync(
				join(agentDir, "extensions/hold.ts"),
				`import { writeFileSync, existsSync } from "node:fs";
export default async function () {
	writeFileSync(${JSON.stringify(loading)}, "");
	while (!existsSync(${JSON.stringify(quitting)})) await new Promise(resolve => setTimeout(resolve, 10));
}`,
			);
			program.write("\r");
			await program.waitForScreen(
				(screen) => existsSync(loading) && screen.includes("❯") && !screen.includes("Trust project folder?"),
				CLI_TIMEOUT_MS,
				"prompt during the final load",
			);
			program.write("/quit\r");
			const exit = await program.exited;
			assert.equal(exit.timedOut, false, program.screen());
			assert.equal(exit.exitCode, 0, program.screen());
			assert.ok(existsSync(quitting), "the session ran its quit hook");
			if (host !== "CLI") assert.equal(readFileSync(join(root, "exported"), "utf8"), "accepted before quit");
		} finally {
			program?.kill();
			await program?.exited;
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	CLI_TIMEOUT_MS + 10_000,
);
