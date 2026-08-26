import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { type LocalCommandResult, runLocalCommand } from "../../packages/workflows/src/durable/local-command.js";

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(predicate(), true, `timed out waiting for ${label}`);
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function assertSuccessfulExitSettles(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "atomic-local-command-exit-"));
	const readyPath = join(root, "server.pid");
	const parentExitPath = join(root, "parent.exit");
	const releasePath = join(root, "server.release");
	const serverSource = `
const { existsSync } = require("node:fs");
const releasePath = ${JSON.stringify(releasePath)};
const timer = setInterval(() => {
  if (!existsSync(releasePath)) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`;
	const parentSource = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("exit", () => writeFileSync(${JSON.stringify(parentExitPath)}, "exited"));
const server = spawn(process.execPath, ["-e", ${JSON.stringify(serverSource)}], {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
process.stdout.write("direct stdout");
process.stderr.write("direct stderr");
server.unref();
writeFileSync(${JSON.stringify(readyPath)}, String(server.pid));
setImmediate(() => process.exit(0));
`;

	let settled: LocalCommandResult | undefined;
	let settlements = 0;
	const pending = runLocalCommand(process.execPath, ["-e", parentSource], { completion: "successful-exit" }).then(
		(result) => {
			settlements += 1;
			settled = result;
			return result;
		},
	);
	let serverPid = 0;
	try {
		await waitFor(() => existsSync(readyPath), "the parent to launch its server descendant");
		serverPid = Number.parseInt(readFileSync(readyPath, "utf8"), 10);
		assert.ok(Number.isInteger(serverPid) && serverPid > 0);
		await waitFor(() => existsSync(parentExitPath), "the direct child to exit");
		await waitFor(() => settled !== undefined, "successful-exit completion without inherited-pipe EOF");
		assert.ok(settled);
		assert.equal(settled.exitCode, 0);
		assert.equal(settlements, 1);
	} finally {
		writeFileSync(releasePath, "release", "utf8");
		await pending;
		if (serverPid > 0) await waitFor(() => !processExists(serverPid), "the fixture server to exit");
		rmSync(root, { recursive: true, force: true });
	}
}

test("ordinary local commands retain the bounded stdout and stderr tail", async () => {
	const stdout = `prefix-stdout:${"o".repeat(24_000)}`;
	const stderr = `prefix-stderr:${"e".repeat(24_000)}`;
	const legacyEmbeddedSource = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`;
	const childGeneratedSource =
		'process.stdout.write("prefix-stdout:" + "o".repeat(24_000)); process.stderr.write("prefix-stderr:" + "e".repeat(24_000));';
	assert.ok(legacyEmbeddedSource.length > 32_767, "the pre-fix fixture exceeded the Windows command-line limit");
	assert.ok(childGeneratedSource.length < 1_000, "the child-generated fixture keeps its command line short");
	const result = await runLocalCommand(process.execPath, ["-e", childGeneratedSource]);

	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout, stdout.slice(-16_384));
	assert.equal(result.stderr, stderr.slice(-16_384));
	assert.equal(result.stdoutTruncated, true);
	assert.equal(result.stderrTruncated, true);
});

test("successful-exit commands settle when a server descendant inherited their pipes", async () => {
	await assertSuccessfulExitSettles();
});

test("successful-exit mode drains bounded diagnostics through close on nonzero exit", async () => {
	const stderr = `failure-prefix:${"diagnostic".repeat(3_000)}`;
	const result = await runLocalCommand(
		process.execPath,
		["-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`],
		{ completion: "successful-exit" },
	);

	assert.equal(result.exitCode, 7);
	assert.equal(result.stderr, stderr.slice(-16_384));
	assert.equal(result.stdoutTruncated, undefined);
	assert.equal(result.stderrTruncated, true);
});

test("successful-exit spawn errors reject after cleaning command resources", async () => {
	await assert.rejects(
		runLocalCommand(`missing-atomic-command-${crypto.randomUUID()}`, [], { completion: "successful-exit" }),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
});
