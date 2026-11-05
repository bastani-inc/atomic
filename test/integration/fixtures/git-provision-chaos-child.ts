// One installer process for the git provisioning chaos tests (#4322). The archive is read from disk through a fetch
// stub, so the test opens no listening socket. Every fetch is appended to CHAOS_LOG before the optional delay.
import { appendFileSync, readFileSync } from "node:fs";
import {
	type GitRelease,
	resolveGit,
	withGitProvisionSettingsForTest,
} from "../../../packages/coding-agent/src/utils/tools-manager.ts";

const archive = readFileSync(process.env.CHAOS_ARCHIVE ?? "");
const log = process.env.CHAOS_LOG ?? "";
const holdMs = Number(process.env.CHAOS_HOLD_MS ?? "0");
const asset = { name: "fake-git.tar.gz", sha256: process.env.CHAOS_SHA256 ?? "" };
const release: GitRelease = {
	repo: "example/fake-git",
	tag: process.env.CHAOS_TAG ?? "v0.0.0-chaos",
	version: "2.56.0",
	assets: {
		"darwin-x64": asset,
		"darwin-arm64": asset,
		"linux-x64": asset,
		"linux-arm64": asset,
		"linux-arm": asset,
		"win32-x64": asset,
		"win32-arm64": asset,
		"win32-ia32": asset,
	},
};

globalThis.fetch = Object.assign(async () => {
	appendFileSync(log, `fetch ${process.pid}\n`);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, holdMs));
	return new Response(new Uint8Array(archive));
}, globalThis.fetch);

try {
	const git = await withGitProvisionSettingsForTest(
		{ release, lockStaleMs: 2_000, lockUpdateMs: 500, lockPollMs: 50 },
		() => resolveGit(),
	);
	process.stdout.write(`${JSON.stringify({ pid: process.pid, ok: true, path: git.path, version: git.version })}\n`);
} catch (error) {
	const payload =
		typeof (error as { toJSON?: () => object }).toJSON === "function"
			? (error as { toJSON: () => object }).toJSON()
			: { name: String((error as Error).name), message: String((error as Error).message) };
	process.stdout.write(`${JSON.stringify({ pid: process.pid, ok: false, error: payload })}\n`);
}
