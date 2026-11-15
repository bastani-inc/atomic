import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { installGit, removeGit } from "../src/core/package-manager-git.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type GitSource, parseGitUrl } from "../src/utils/git.ts";
import { createGitEnvironment } from "../src/utils/git-env.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: createGitEnvironment() });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

const SLOT_COLLAPSING_SOURCES = [
	"git:localhost/alice/.",
	"https://localhost/alice/.",
	"git:github.com/./.",
	"git:localhost/alice/./",
	"git:localhost/./tool",
	"git:./alice/tool",
	"https://localhost/alice/%2E",
	"git:localhost/alice//tool",
	"git:git@localhost:alice/.",
];

describe("git sources that do not name their own install directory (#5055)", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-git-dot-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** An installed package checkout under the user git root. */
	function installedPackage(...segments: string[]): string {
		const dir = join(agentDir, "git", ...segments);
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeFileSync(join(dir, "package.json"), "{}");
		return dir;
	}

	function createManager(): DefaultPackageManager {
		return new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });
	}

	it("rejects git sources with '.' or empty path segments (#5055)", () => {
		for (const source of SLOT_COLLAPSING_SOURCES) {
			assert.equal(parseGitUrl(source), null, source);
		}
	});

	it("keeps parsing sources whose names merely contain dots (#5055)", () => {
		assert.equal(parseGitUrl("git:localhost/alice/.dotfiles")?.path, "alice/.dotfiles");
		assert.equal(parseGitUrl("https://localhost/alice/tool.v2.git")?.path, "alice/tool.v2");
		assert.equal(parseGitUrl("https://localhost/alice/tool.gitx")?.path, "alice/tool.gitx");
		assert.equal(parseGitUrl("https://localhost/alice/tool//")?.path, "alice/tool");
	});

	it("leaves other installed packages in place when such a source is installed (#5055)", async () => {
		const siblings = [installedPackage("localhost", "alice", "tool"), installedPackage("github.com", "bob", "ext")];

		for (const source of SLOT_COLLAPSING_SOURCES) {
			await assert.rejects(createManager().install(source), undefined, source);
			for (const sibling of siblings) {
				assert.ok(existsSync(join(sibling, "package.json")), `${source} removed ${sibling}`);
			}
		}
	});

	it("never removes a parent directory for a source that bypassed parsing (#5055)", async () => {
		const sibling = installedPackage("localhost", "alice", "tool");
		const context = { cwd, agentDir, settingsManager: SettingsManager.inMemory() };
		const sources: Array<Pick<GitSource, "host" | "path">> = [
			{ host: "localhost", path: "alice/." },
			{ host: "localhost", path: "alice/" },
			{ host: "localhost", path: "alice/.." },
			{ host: "localhost", path: "alice" },
			{ host: ".", path: "localhost/alice" },
		];

		for (const { host, path } of sources) {
			const source: GitSource = { type: "git", repo: `https://${host}/${path}`, host, path, pinned: false };
			await assert.rejects(installGit(context, source, "user"), /not the install directory/, `install ${path}`);
			await assert.rejects(removeGit(context, source, "user"), /not the install directory/, `remove ${path}`);
			assert.ok(existsSync(join(sibling, "package.json")), `${host}/${path} removed ${sibling}`);
		}
	});

	/** A checkout of `origin` at the install directory of `localhost/alice/TOOL`. */
	function checkoutAtToolSlot(origin: string): string {
		const checkout = join(agentDir, "git", "localhost", "alice", "TOOL");
		mkdirSync(checkout, { recursive: true });
		git(["init"], checkout);
		git(["remote", "add", "origin", origin], checkout);
		writeFileSync(join(checkout, "package.json"), "{}");
		return checkout;
	}

	it("leaves another repository's checkout alone when a differently cased source maps onto it (#5055)", async () => {
		// On a case-insensitive filesystem, alice/TOOL opens the checkout of alice/tool.
		for (const origin of ["https://localhost/alice/tool", "git@localhost:alice/tool"]) {
			const checkout = checkoutAtToolSlot(origin);
			const source = "https://localhost/alice/TOOL";
			const mismatch = new RegExp(`${origin}.*https://localhost/alice/TOOL`);
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setPackages([source]);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

			await assert.rejects(manager.install(source), mismatch);
			await assert.rejects(manager.update(source), mismatch);
			await assert.rejects(manager.remove(source), mismatch);

			assert.ok(existsSync(join(checkout, "package.json")));
			assert.equal(git(["remote", "get-url", "origin"], checkout), origin);
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	it("removes a checkout whose origin the user pointed at another repository (#5055)", async () => {
		for (const origin of [
			"https://mirror.example/alice/tool",
			"https://localhost/bob/tool",
			join(tempDir, "remote"),
		]) {
			const checkout = checkoutAtToolSlot(origin);

			await createManager().remove("https://localhost/alice/TOOL");

			assert.equal(existsSync(checkout), false, origin);
		}
	});

	it("does not replace a directory that holds another package's checkout (#5055)", async () => {
		const nested = installedPackage("localhost", "alice", "tool", "sub");

		await assert.rejects(createManager().install("git:localhost/alice/tool"), /another package/);

		assert.ok(existsSync(join(nested, "package.json")));
	});
});
