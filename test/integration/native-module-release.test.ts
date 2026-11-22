import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { decodeStream, makeTempDirectory, moduleDir, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
/** Starting Node and loading Atomic's SDK, however loaded the machine. */
const SDK_PROCESS_MS = 60_000;
/** Each test runs one SDK process: its start, and its answer. */
const SDK_PROCESS_TEST_TIMEOUT_MS = SDK_PROCESS_MS * 2;

interface Answer {
	readonly name?: string;
	readonly code?: string;
	readonly message?: string;
	readonly started?: true;
}

/**
 * An SDK process running from an installation of release `running`, depending on its native module of that release
 * (this checkout's build, whose native module is of the source checkout, `0.0.0`). Once it has loaded the SDK, `meanwhile` may change the installation; then it opens
 * a session, the first time it needs the native module, and reports how that went.
 */
async function openSessionAfter(running: string, meanwhile: (setVersion: (version: string) => void) => void) {
	const root = makeTempDirectory("atomic-native-release-");
	try {
		const installed = join(root, "installed");
		prepareInstalledPackage(PACKAGE, installed);
		const manifest = join(installed, "package.json");
		// A release stamps its version and the release of the native module it depends on.
		const setVersion = (version: string) => {
			const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
				version: string;
				dependencies: Record<string, string>;
			};
			const dependencies = { ...pkg.dependencies, "@bastani/atomic-natives": version };
			writeFileSync(manifest, JSON.stringify({ ...pkg, version, dependencies }));
		};
		setVersion(running);
		const sdk = pathToFileURL(join(PACKAGE, "dist/index.js")).href;
		const script = `const { createAgentSession } = await import(${JSON.stringify(sdk)});
process.stdout.write("loaded\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
let answer;
try {
	await createAgentSession({ cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(join(root, "agent"))} });
	answer = { started: true };
} catch (error) {
	answer = { name: error.name, code: error.code, message: error.message };
}
process.stdout.write(JSON.stringify(answer) + "\\n");
process.exit(0);`;
		const child = spawnProcess([process.execPath, "--input-type=module", "-e", script], {
			cwd: root,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: {
				...process.env,
				ATOMIC_PACKAGE_DIR: installed,
				HOME: root,
				USERPROFILE: root,
				ATOMIC_CODING_AGENT_DIR: join(root, "agent"),
				ATOMIC_SKIP_VERSION_CHECK: "1",
				ATOMIC_TELEMETRY: "0",
				ATOMIC_OFFLINE: "1",
			},
		});
		const lines = decodeStream(child.stdout!).getReader();
		let text = "";
		const nextLine = async (): Promise<string> => {
			const deadline = Date.now() + SDK_PROCESS_MS;
			while (!text.includes("\n")) {
				const read = await Promise.race([
					lines.read(),
					new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()))),
				]);
				if (read === "late" || read.done) throw new Error(`the SDK process stopped answering: ${text}`);
				text += read.value;
			}
			const line = text.slice(0, text.indexOf("\n"));
			text = text.slice(text.indexOf("\n") + 1);
			return line;
		};
		try {
			assert.equal(await nextLine(), "loaded");
			meanwhile(setVersion);
			child.stdin?.write("go\n");
			return JSON.parse(await nextLine()) as Answer;
		} finally {
			child.kill("SIGKILL");
			await child.exited.catch(() => {});
		}
	} finally {
		removeTempDirectory(root);
	}
}

test(
	"a release whose native module is of another release refuses to open a session, naming both releases",
	async () => {
		const answer = await openSessionAfter("0.10.4", () => {});

		assert.equal(answer.code, "NativeModuleUnavailable", JSON.stringify(answer));
		assert.match(answer.message ?? "", /native module \(@bastani\/atomic-natives\) is from 0\.0\.0, not 0\.10\.4/);
	},
	SDK_PROCESS_TEST_TIMEOUT_MS,
);

test(
	"a running process whose installation an update replaced says to restart when it first opens a session",
	async () => {
		const answer = await openSessionAfter("0.10.4", (setVersion) => setVersion("0.10.5"));

		assert.equal(answer.code, "NativeModuleUnavailable", JSON.stringify(answer));
		assert.equal(answer.message, "atomic was updated to 0.10.5 while this process was running; restart it.");
	},
	SDK_PROCESS_TEST_TIMEOUT_MS,
);
