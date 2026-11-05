// Produces git provisioning errors in a separate process and writes their wire form to stdout, the way the
// interactive engine sends `get_tools` reports to its host (#4322).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GitProvisionTimeoutError, GitUnavailableError } from "../../../packages/coding-agent/src/utils/git-errors.js";
import { getGitInstallDir, getGitStatus, resolveGit } from "../../../packages/coding-agent/src/utils/tools-manager.js";

function installFakeGit(root: string): void {
	if (process.platform !== "win32") {
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "git"), '#!/bin/sh\necho "git version 2.56.0"\n');
		chmodSync(join(root, "bin", "git"), 0o755);
		return;
	}
	const executable = join(root, "cmd", "git.exe");
	const source = join(root, "fake-git.ts");
	mkdirSync(dirname(executable), { recursive: true });
	writeFileSync(source, 'process.stdout.write("git version 2.56.0\\n");\n');
	const built = spawnSync(process.execPath, ["build", "--compile", source, "--outfile", executable], {
		encoding: "utf8",
	});
	if (built.status !== 0) throw new Error(`could not build the fake git: ${built.stderr}${built.stdout}`);
}

const offline = await resolveGit().then(
	() => undefined,
	(error: Error) => error,
);
const network = Object.assign(new TypeError("fetch failed"), {
	cause: Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" }),
});
const timeout = new GitProvisionTimeoutError(
	{ phase: "download", timeoutMs: 600_000, elapsedMs: 600_004 },
	{
		cause: new GitUnavailableError(
			{
				code: "download-failed",
				asset: "a.tar.gz",
				url: "https://example.test/a.tar.gz",
				platform: process.platform,
				arch: process.arch,
			},
			{ cause: network },
		),
	},
);
const status = getGitStatus();

// An install of an older pinned release that cannot be replaced offline: the status says why.
const installDir = getGitInstallDir();
installFakeGit(installDir);
writeFileSync(
	join(installDir, ".atomic-git-release.json"),
	JSON.stringify({ tag: "v-older", asset: "a", sha256: "0" }),
);
await resolveGit();
const staleStatus = getGitStatus();

process.stdout.write(`${JSON.stringify({ offline, timeout, status, staleStatus })}\n`);
