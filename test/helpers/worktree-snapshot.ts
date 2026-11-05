import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type GitExecutable,
	runGit,
	setWorktreeSnapshotGit,
} from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";

/**
 * Disposable Git repositories whose commands all go through the snapshot runner with an isolated global config, so
 * the developer's signing, hooks and filter settings never reach a fixture.
 */
export class GitSandbox {
	readonly root: string;
	readonly globalConfig: string;
	readonly executable: GitExecutable;
	private readonly restoreResolver: () => void;

	constructor(extraGlobalConfig = "") {
		this.root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-snapshot-test-")));
		this.globalConfig = join(this.root, "gitconfig");
		writeFileSync(
			this.globalConfig,
			`[user]\n\tname = Fixture\n\temail = fixture@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n[protocol "file"]\n\tallow = always\n${extraGlobalConfig}`,
		);
		this.executable = {
			path: "git",
			env: { GIT_CONFIG_GLOBAL: this.globalConfig, GIT_CONFIG_NOSYSTEM: "1", HOME: this.root },
		};
		const executable = this.executable;
		const previous = setWorktreeSnapshotGit(async () => executable);
		this.restoreResolver = () => setWorktreeSnapshotGit(previous);
	}

	path(...parts: string[]): string {
		return join(this.root, ...parts);
	}

	async git(cwd: string, ...args: string[]): Promise<string> {
		const { stdout } = await runGit(args, { cwd });
		return stdout.toString("utf8").replace(/\n$/, "");
	}

	write(path: string, content: string | Uint8Array): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	/** A bare remote with one pushed commit and a clone of it, both under the sandbox. */
	async remoteWithClone(name = "repo", files: Record<string, string | Uint8Array> = { "README.md": "hello\n" }) {
		const remote = this.path(`${name}.git`);
		await this.git(this.root, "init", "-q", "--bare", remote);
		const clone = this.path(name);
		await this.git(this.root, "clone", "-q", remote, clone);
		for (const [file, content] of Object.entries(files)) this.write(join(clone, file), content);
		await this.git(clone, "add", "-A");
		await this.git(clone, "commit", "-q", "-m", "initial");
		await this.git(clone, "push", "-q", "origin", "HEAD:main");
		await this.git(clone, "branch", "-q", "--set-upstream-to=origin/main");
		return { remote, clone };
	}

	async commitAll(cwd: string, message: string): Promise<string> {
		await this.git(cwd, "add", "-A");
		await this.git(cwd, "commit", "-q", "-m", message);
		return this.git(cwd, "rev-parse", "HEAD");
	}

	dispose(): void {
		this.restoreResolver();
		rmSync(this.root, { recursive: true, force: true });
	}
}
