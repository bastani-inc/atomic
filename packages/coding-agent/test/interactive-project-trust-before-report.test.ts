import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../../../test/helpers/detached-broker.js";
import { startPtyProgram } from "../../../test/helpers/pty-program.js";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.ts";
import { cliPath } from "./cli-test-helpers.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.js";

// A real interactive CLI: host, engine child, extension loading and the folder's trust decision.
const STARTUP_TIMEOUT_MS = 60_000;

/** Global extensions that answer project_trust with "yes" and with "no". */
const TRUST_POLICIES = {
	yes: "export default function(pi) { pi.on('project_trust', async () => ({ trusted: 'yes' })); }",
	no: "export default function(pi) { pi.on('project_trust', async () => ({ trusted: 'no' })); }",
} as const;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function seed(cwd: string, agentDir: string, dir: string, text: string): Promise<void> {
	const store = await resolveSessionStore(cwd, { agentDir, settings: { sessions: { storage: { dir } } } });
	try {
		const manager = await SessionManager.create(store, cwd);
		await manager.appendMessage({ role: "user", content: text, timestamp: 1 });
	} finally {
		await store.close();
	}
}

/**
 * A folder saved as trusted, whose own settings choose a session store different from the global one, and a global
 * extension that answers project_trust (`policy`: "yes", "no", or no extension at all).
 */
async function startSavedTrustedFolder(policy: "yes" | "no" | "none", args: string[], projectStore = true) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-trust-before-report-")));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const globalSessions = join(root, "global-sessions");
	const projectSessions = join(root, "project-sessions");
	write(
		join(cwd, ".atomic", "settings.json"),
		JSON.stringify({
			...(projectStore ? { sessions: { storage: { dir: projectSessions } } } : {}),
			modelRouting: { enabled: true },
		}),
	);
	write(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: true }));
	write(
		join(agentDir, "settings.json"),
		JSON.stringify({
			lastChangelogVersion: "0.0.0",
			onboardedVersion: "0.0.0",
			sessions: { storage: { dir: globalSessions } },
		}),
	);
	if (policy !== "none") write(join(agentDir, "extensions", "policy.ts"), TRUST_POLICIES[policy]);
	await seed(cwd, agentDir, globalSessions, "GLOBAL RECEIPT");
	await seed(cwd, agentDir, projectSessions, "PROJECT RECEIPT");
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
	return {
		cli,
		projectSettings: () => readFileSync(join(cwd, ".atomic", "settings.json"), "utf8"),
		async close() {
			cli.kill();
			await cli.exited;
			await removeTempRootReleasingBroker(root, agentDir);
		},
	};
}

for (const [policy, receipt] of [
	["no", "GLOBAL RECEIPT"],
	["yes", "PROJECT RECEIPT"],
	["none", "PROJECT RECEIPT"],
] as const) {
	test(
		`--continue reads the store the folder's settings choose only once the folder is trusted: policy ${policy} (#5693)`,
		async () => {
			const run = await startSavedTrustedFolder(policy, ["--continue"]);
			try {
				await run.cli.waitForScreen(
					(screen) => screen.includes("RECEIPT") && screen.includes("❯"),
					STARTUP_TIMEOUT_MS,
					"the continued session",
				);
				assert.match(run.cli.screen(), new RegExp(receipt));
				assert.doesNotMatch(run.cli.screen(), new RegExp(receipt === "GLOBAL RECEIPT" ? "PROJECT" : "GLOBAL"));
			} finally {
				await run.close();
			}
		},
		3 * STARTUP_TIMEOUT_MS,
	);
}

test.each([
	["its own session store", true],
	["the global session store", false],
] as const)(
	"startup leaves a folder's settings unmigrated when a global policy declines its saved trust, with %s (#5693)",
	async (_label, projectStore) => {
		const run = await startSavedTrustedFolder("no", [], projectStore);
		try {
			await run.cli.waitForScreen(
				(screen) => screen.includes("This project is not trusted"),
				STARTUP_TIMEOUT_MS,
				"the untrusted warning",
			);
			assert.match(run.projectSettings(), /modelRouting/);
		} finally {
			await run.close();
		}
	},
	3 * STARTUP_TIMEOUT_MS,
);
