// Produces git provisioning errors in a separate process and writes their wire form to stdout, the way the
// interactive engine sends `get_tools` reports to its host (#4322).
import { GitProvisionTimeoutError, GitUnavailableError } from "../../../packages/coding-agent/src/utils/git-errors.ts";
import { getGitStatus, resolveGit } from "../../../packages/coding-agent/src/utils/tools-manager.ts";

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
process.stdout.write(`${JSON.stringify({ offline, timeout, status: getGitStatus() })}\n`);
