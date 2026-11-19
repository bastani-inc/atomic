import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argumentsFor, ReleaseBlocked, releaseCli } from "./cli.js";
import {
	currentBranchName,
	DEFAULT_RELEASE_DOCS_BASE_BRANCH,
	docsRoot,
	findMissingOrEmptyUpdateArtifacts,
	groupedTasks,
	nextDocsValidationPhase,
	releaseDocsUpdateTaskKey,
	requireNonBaseBranch,
	requireResearchArtifactPath,
	runDocsChecks,
	runGit,
	verifyReleaseDocsPr,
} from "./release-docs-lib.js";

const commands = {
	"require-non-base-branch": "",
	"group-tasks": "<research-report> <detected-tasks.json>",
	"check-updates": "<grouped-tasks.json> <updates-directory>",
	"docs-check": "",
	"verify-pr": "<original-branch>",
};

function run(args: string[]) {
	const { command, rest, help } = argumentsFor(commands, args, true);
	if (help) return help;
	if (command === "require-non-base-branch" && !rest.length) {
		const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
		if (status) throw new ReleaseBlocked(`release-docs refuses to start on a dirty working tree:\n${status}`);
		return {
			status: "passed",
			currentBranch: requireNonBaseBranch(currentBranchName()),
			base: DEFAULT_RELEASE_DOCS_BASE_BRANCH,
			docsRoot,
		};
	}
	if (command === "group-tasks" && rest.length === 2) {
		const research = requireResearchArtifactPath(rest[0]);
		if (!readFileSync(research, "utf8").trim()) throw new ReleaseBlocked(`Empty research artifact: ${research}`);
		return groupedTasks(rest[1]).map((task, index) => ({ ...task, key: releaseDocsUpdateTaskKey(task, index) }));
	}
	if (command === "check-updates" && rest.length === 2) {
		const artifacts = groupedTasks(rest[0]).map((task, index) => {
			const path = join(rest[1], `${releaseDocsUpdateTaskKey(task, index)}.md`);
			const exists = existsSync(path);
			return { path, exists, empty: !exists || !readFileSync(path, "utf8").trim() };
		});
		const missing = findMissingOrEmptyUpdateArtifacts(artifacts);
		if (missing.length)
			throw new ReleaseBlocked(
				`Missing or empty update artifacts:\n${missing.map(({ path, exists }) => `${path}: ${exists ? "empty" : "missing"}`).join("\n")}`,
			);
		return { status: "passed", reports: artifacts.length };
	}
	if (command === "docs-check" && !rest.length) {
		const { ok, markdown } = runDocsChecks();
		if (nextDocsValidationPhase(ok) === "repair_then_revalidate") throw new ReleaseBlocked(markdown);
		return { status: "passed", summary: markdown };
	}
	if (command === "verify-pr" && rest.length === 1) {
		const branch = requireNonBaseBranch(currentBranchName());
		if (branch !== rest[0]) throw new ReleaseBlocked(`Current branch drifted from ${rest[0]} to ${branch}.`);
		const status = runGit(["status", "--porcelain=v1", "--untracked-files=all", "--", docsRoot]);
		if (status) throw new ReleaseBlocked(`Uncommitted docs changes:\n${status}`);
		const pr = verifyReleaseDocsPr(branch);
		if (pr.error) throw new Error(pr.summary);
		if (!pr.ok) throw new ReleaseBlocked(pr.summary);
		return { status: "passed", ...pr };
	}
	throw new Error(`Usage: ${command} ${commands[command as keyof typeof commands]}`);
}

if (import.meta.main) await releaseCli(() => run(process.argv.slice(2)));
