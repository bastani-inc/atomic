// Runs inside a container that has no git. Imports the built @bastani/atomic, resolves git through the public
// resolveGit(), and drives real git commands through the resolved path and environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, distEntry] = process.argv.slice(2);
assert.ok(["online", "https", "offline"].includes(mode), `unknown mode ${mode}`);
const atomic = await import(pathToFileURL(distEntry).href);
const agentDir = process.env.ATOMIC_CODING_AGENT_DIR;
assert.ok(agentDir, "ATOMIC_CODING_AGENT_DIR must isolate the agent home");

const statuses = [];
const git = await atomic.resolveGit({ onStatus: (status) => statuses.push(status) });
assert.equal(git.source, "provisioned");
assert.ok(git.path.startsWith(`${join(agentDir, "bin", "git")}${sep}`), git.path);
assert.ok(git.env.GIT_EXEC_PATH?.startsWith(join(agentDir, "bin", "git")), "GIT_EXEC_PATH");
assert.ok(git.env.GIT_TEMPLATE_DIR?.startsWith(join(agentDir, "bin", "git")), "GIT_TEMPLATE_DIR");
assert.ok(git.env.GIT_SSL_CAINFO?.startsWith(join(agentDir, "bin", "git")), "GIT_SSL_CAINFO");
if (mode === "online")
	assert.ok(
		statuses.some((status) => /installed to/.test(status.message)),
		JSON.stringify(statuses),
	);
else assert.deepEqual(statuses, [], "an installed git must resolve without downloading");
if (mode === "https") {
	const head = spawnSync(git.path, ["ls-remote", "https://github.com/desktop/dugite-native", "HEAD"], {
		env: git.env,
		encoding: "utf-8",
	});
	assert.equal(head.status, 0, head.stderr);
	assert.match(head.stdout, /^[0-9a-f]{40}\tHEAD$/m);
	console.log(JSON.stringify({ mode, caBundle: git.env.GIT_SSL_CAINFO, remoteHead: head.stdout.split(/\s+/)[0] }));
	process.exit(0);
}

const identity = ["-c", "user.name=Atomic E2E", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false"];
function run(args, cwd) {
	const result = spawnSync(git.path, args, { cwd, env: git.env, encoding: "utf-8" });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", `git-provision-${mode}-`));
const repo = join(root, "repo");
const worktree = join(root, "worktree");
run(["init", "-b", "main", repo], root);
writeFileSync(join(repo, "hello.txt"), `hello from ${mode}\n`);
run(["add", "hello.txt"], repo);
run([...identity, "commit", "-m", `provisioned ${mode} commit`], repo);
run(["worktree", "add", "-b", "feature", worktree, "main"], repo);

assert.equal(run(["log", "-1", "--format=%s"], repo), `provisioned ${mode} commit`);
assert.equal(readFileSync(join(worktree, "hello.txt"), "utf-8"), `hello from ${mode}\n`);
assert.equal(run(["rev-parse", "HEAD"], worktree), run(["rev-parse", "HEAD"], repo));
assert.ok(run(["worktree", "list", "--porcelain"], repo).includes(`worktree ${worktree}`));
assert.ok(run(["rev-parse", "--git-path", "hooks"], repo).length > 0);

const status = atomic.getGitStatus();
assert.equal(status.source, "provisioned");
console.log(
	JSON.stringify({
		mode,
		source: git.source,
		version: git.version,
		path: git.path,
		statuses: statuses.map((entry) => entry.message),
		commit: run(["rev-parse", "HEAD"], repo),
		worktree,
		status,
	}),
);
