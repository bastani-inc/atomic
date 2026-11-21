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

// A real interactive CLI: host, engine child, extension loading and the folders' trust decisions.
const STARTUP_TIMEOUT_MS = 60_000;
// A cleanup that never finishes holds the session back for as long as a quit waits for one: about five seconds.
const UNFINISHED_CLEANUP_BOUND_MS = 5_000;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function seed(cwd: string, agentDir: string, dir: string | undefined, text: string): Promise<string> {
	const store = await resolveSessionStore(cwd, {
		agentDir,
		settings: dir === undefined ? {} : { sessions: { storage: { dir } } },
	});
	try {
		const manager = await SessionManager.create(store, cwd);
		await manager.appendMessage({ role: "user", content: text, timestamp: 1 });
		return manager.getSessionId();
	} finally {
		await store.close();
	}
}

async function run(
	root: string,
	agentDir: string,
	cwd: string,
	args: string[],
	body: (cli: PtyProgram) => Promise<void>,
): Promise<void> {
	linkSharedTranspileCache(agentDir);
	const cli = startPtyProgram({
		executable: bunExecutable(),
		args: [cliPath, "--offline", ...args],
		cwd,
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, HOME: root, USERPROFILE: root, TERM: "xterm-256color", CI: "0" },
		cols: 160,
		rows: 50,
		timeoutMs: 2 * STARTUP_TIMEOUT_MS,
	});
	try {
		await body(cli);
	} finally {
		cli.kill();
		await cli.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

const settings = (extra: object) =>
	JSON.stringify({ lastChangelogVersion: "0.0.0", onboardedVersion: "0.0.0", ...extra });

test(
	"an extension installed while startup waits loads after the folder's saved decision applies, and does not vote on it",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-trust-startup-check-")));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const voted = join(root, "voted");
		const loaded = join(root, "loaded");
		write(join(cwd, ".atomic", "prompts", "projectprompt.md"), "---\ndescription: Project prompt\n---\nHello\n");
		write(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: true }));
		write(join(agentDir, "settings.json"), settings({}));
		await seed(cwd, agentDir, undefined, "EARLIER RECEIPT");
		await run(root, agentDir, cwd, ["--resume"], async (cli) => {
			// The session picker opens after startup checked for extensions and found none.
			await cli.waitForScreen((screen) => screen.includes("EARLIER RECEIPT"), STARTUP_TIMEOUT_MS, "the picker");
			write(
				join(agentDir, "extensions", "policy.ts"),
				`import { writeFileSync } from 'node:fs';
				export default function(pi) {
					writeFileSync(${JSON.stringify(loaded)}, '');
					pi.on('project_trust', async () => {
						writeFileSync(${JSON.stringify(voted)}, '');
						return { trusted: 'no' };
					});
				}`,
			);
			cli.write("\r");
			await cli.waitForScreen(
				(screen) => screen.includes("EARLIER RECEIPT") && screen.includes("❯") && existsSync(loaded),
				STARTUP_TIMEOUT_MS,
				"the session with the new extension loaded",
			);
			assert.equal(existsSync(voted), false);
			assert.doesNotMatch(cli.screen(), /This project is not trusted/);
		});
	},
	3 * STARTUP_TIMEOUT_MS,
);

/**
 * Folder A, whose own settings choose another session store, decides its trust before a session opens; the session
 * picked is folder B's. A user extension logs its factories, its shutdown and a timer's ticks; `hangA` makes its
 * shutdown in A never finish.
 */
async function resumeOtherFolder(
	hangA: boolean,
	body: (cli: PtyProgram, log: () => string[], b: string) => Promise<void>,
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-trust-other-folder-")));
	const agentDir = join(root, "agent");
	const a = join(root, "a");
	const b = join(root, "b");
	const logFile = join(root, "log.txt");
	const projectSessions = join(root, "project-sessions");
	write(join(a, ".atomic", "settings.json"), JSON.stringify({ sessions: { storage: { dir: projectSessions } } }));
	write(
		join(b, ".atomic", "extensions", "bonly.ts"),
		`import { appendFileSync } from 'node:fs';
		export default function() { appendFileSync(${JSON.stringify(logFile)}, 'bonly factory\\n'); }`,
	);
	write(join(agentDir, "trust.json"), JSON.stringify({ [a]: true, [b]: true }));
	write(join(agentDir, "settings.json"), settings({ sessions: { storage: { dir: join(root, "global-sessions") } } }));
	write(
		join(agentDir, "extensions", "policy.ts"),
		`import { appendFileSync } from 'node:fs';
		import { basename } from 'node:path';
		const log = (line) => appendFileSync(${JSON.stringify(logFile)}, line + '\\n');
		export default async function(pi) {
			// The folder a command runs in when the extension gives none.
			const cwd = (await pi.exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout;
			const folder = basename(cwd) === 'a' ? 'A' : basename(cwd) === 'b' ? 'B' : cwd;
			log('factory ' + folder);
			const timer = setInterval(() => log('tick ' + folder), 20);
			pi.on('project_trust', async () => ({ trusted: 'yes' }));
			pi.on('session_shutdown', async (event) => {
				log('shutdown ' + folder + ' ' + event.reason + ' ' + event.targetSessionId);
				clearInterval(timer);
				if (${hangA} && folder === 'A') await new Promise(() => {});
			});
		}`,
	);
	const id = await seed(b, agentDir, projectSessions, "B RECEIPT");
	await run(root, agentDir, a, ["--resume"], async (cli) => {
		await cli.waitForScreen((screen) => /this folder|all folders/.test(screen), STARTUP_TIMEOUT_MS, "the picker");
		// Every folder's sessions, then B's.
		cli.write("\t");
		await cli.waitForScreen((screen) => screen.includes("B RECEIPT"), STARTUP_TIMEOUT_MS, "B's session");
		cli.write("\r");
		const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : []);
		await body(cli, log, id);
	});
}

test(
	"a session picked in another folder shuts down the extensions that decided the startup folder before its own load",
	() =>
		resumeOtherFolder(false, async (cli, log, id) => {
			await cli.waitForScreen(
				(screen) =>
					screen.includes("B RECEIPT") &&
					screen.includes("❯") &&
					log().filter((line) => line === "tick B").length >= 5,
				STARTUP_TIMEOUT_MS,
				"B's session with its extensions running",
			);
			const lines = log().filter((line) => !line.startsWith("tick B"));
			const shutdown = lines.indexOf(`shutdown A resume ${id}`);
			assert.ok(shutdown > 0, lines.join("\n"));
			// A's extension ran once, for A's decision, and stopped before B's own extensions loaded; B's ran once.
			assert.deepEqual(
				lines.filter((line) => !line.startsWith("tick")),
				["factory A", `shutdown A resume ${id}`, "factory B", "bonly factory"],
			);
			assert.equal(lines.slice(shutdown).includes("tick A"), false, "A's timer stopped with its shutdown");
		}),
	3 * STARTUP_TIMEOUT_MS,
);

test(
	"a session picked in another folder opens when the startup folder's extension never finishes shutting down, and says which",
	() =>
		resumeOtherFolder(true, async (cli, log) => {
			await cli.waitForScreen(
				(screen) => screen.includes("B RECEIPT") && screen.includes("❯") && log().includes("bonly factory"),
				STARTUP_TIMEOUT_MS,
				"B's session",
			);
			await cli.waitForScreen(
				(screen) => /policy\.ts" did not finish shutting down/.test(screen.replace(/\s+/g, " ")),
				STARTUP_TIMEOUT_MS,
				"the warning that names the extension",
			);
			assert.ok(log().indexOf("factory B") > log().findIndex((line) => line.startsWith("shutdown A")));
		}),
	3 * STARTUP_TIMEOUT_MS + UNFINISHED_CLEANUP_BOUND_MS,
);
