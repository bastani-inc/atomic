import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, it } from "vitest";
import { bunExecutable } from "./cli-test-helpers.ts";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/model-list-reader.ts", import.meta.url));
let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "atomic-model-readers-"));
	env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		TEMP: dir,
		TMP: dir,
		HOME: dir,
		USERPROFILE: dir,
		ATOMIC_CODING_AGENT_DIR: dir,
		ATOMIC_OFFLINE: "0",
		AWS_EC2_METADATA_DISABLED: "true",
	};
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});
function run(mode: string) {
	return exec(bunExecutable(), ["--no-env-file", fixture, mode, dir], {
		cwd: dir,
		env,
		timeout: 45_000,
		killSignal: "SIGKILL",
	});
}

it("an ordinary listing leaves another process's explicitly refreshed catalog and account IDs intact (#5685)", async () => {
	await writeFile(
		join(dir, "auth.json"),
		JSON.stringify({ "github-copilot": { type: "api_key", key: "github_pat_example" } }),
	);
	await writeFile(
		join(dir, "models.json"),
		JSON.stringify({ providers: { "github-copilot": { baseUrl: "http://127.0.0.1:9/account" } } }),
	);
	const reader = spawn(bunExecutable(), ["--no-env-file", fixture, "reader", dir], {
		cwd: dir,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 45_000,
		killSignal: "SIGKILL",
	});
	const done = new Promise<number | null>((resolve, reject) => {
		reader.once("error", reject);
		reader.once("close", resolve);
	});
	const lines = createInterface({ input: reader.stdout })[Symbol.asyncIterator]();
	try {
		assert.equal((await lines.next()).value, "reader ready");
		await run("writer");
		await run("reopen");
		reader.stdin.end("continue\n");
		assert.deepEqual(JSON.parse((await lines.next()).value ?? "null"), { accountReads: 0 });
		assert.equal(await done, 0);
		await run("reopen");
	} finally {
		reader.kill();
		await done;
	}
}, 90_000);

it.skipIf(process.platform === "win32")(
	"an account lookup does not open a credential file replaced with a pipe (#5685)",
	async () => {
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({ "github-copilot": { type: "api_key", key: "github_pat_example" } }),
		);
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({ providers: { "github-copilot": { baseUrl: "http://127.0.0.1:9/account" } } }),
		);
		await exec("mkfifo", [join(dir, "next.fifo")]);
		const { stdout } = await run("account-fifo");
		assert.deepEqual(JSON.parse(stdout), { accountReads: 1, credentialRead: false });
	},
	60_000,
);

it.skipIf(process.platform === "win32")(
	"listing known models does not reopen a blocked config or keep the process alive (#5685)",
	async () => {
		await writeFile(join(dir, "models.json"), "{}");
		await writeFile(join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "example" } }));
		await exec("mkfifo", [join(dir, "next.fifo")]);
		const { stdout } = await run("fifo");
		assert.deepEqual(JSON.parse(stdout), { configRead: false });
	},
	60_000,
);
