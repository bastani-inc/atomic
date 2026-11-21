import { reportOwnedWebDiagnostic } from "./diagnostics.js";
import { type ExecFileException, execFile } from "node:child_process";
import { createChildProcessEnvironment } from "@bastani/atomic";
import { helperLaunchAsync, missingHelperOptions } from "@bastani/atomic-tui";
import type { ExtractedContent } from "./extract.js";
import { flattenTruncatedString } from "./flat-string.js";
import type { GitHubUrlInfo } from "./github-extract.js";
import { isValidGitHubOwner, isValidGitHubRepo, isValidGitRef, isValidRepoPath } from "./github-config.js";

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

let ghAvailable: boolean | null = null;

/** Runs `gh` from PATH's absolute directories, never from the working directory. */
function execGh(
	args: string[],
	options: { timeout: number; maxBuffer?: number; env: NodeJS.ProcessEnv },
	callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): void {
	helperLaunchAsync("gh", { env: options.env }).then(
		(launch) => {
			execFile(launch.file, args, { ...options, encoding: "utf8" as const, ...missingHelperOptions(launch) }, callback);
		},
		(error: Error) => callback(error, "", ""),
	);
}
let ghHintShown = false;

export async function checkGhAvailable(): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;

	return new Promise((resolve) => {
		execGh(["--version"], { timeout: 5000, env: createChildProcessEnvironment() }, (err) => {
			ghAvailable = !err;
			resolve(ghAvailable);
		});
	});
}

export function showGhHint(): void {
	if (!ghHintShown) {
		ghHintShown = true;
		if (!reportOwnedWebDiagnostic("warning")) console.error("[pi-web-access] Install `gh` CLI for better GitHub repo access including private repos.");
	}
}

/** Owner and repo names GitHub allows are already safe `gh api` path components. */
function isValidRepository(owner: string, repo: string): boolean {
	return isValidGitHubOwner(owner) && isValidGitHubRepo(repo);
}

export async function checkRepoSize(owner: string, repo: string): Promise<number | null> {
	if (!isValidRepository(owner, repo)) return null;
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execGh(["api", `repos/${owner}/${repo}`, "--jq", ".size"], { timeout: 10000, env: createChildProcessEnvironment() }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			const kb = parseInt(stdout.trim(), 10);
			resolve(Number.isNaN(kb) ? null : kb);
		});
	});
}

async function getDefaultBranch(owner: string, repo: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execGh(["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"], { timeout: 10000, env: createChildProcessEnvironment() }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			const branch = stdout.trim();
			resolve(isValidGitRef(branch) ? branch : null);
		});
	});
}

async function fetchTreeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execGh(
			["api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"],
			{ timeout: 15000, maxBuffer: 5 * 1024 * 1024, env: createChildProcessEnvironment() },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				const paths = stdout.trim().split("\n").filter(Boolean);
				if (paths.length === 0) {
					resolve(null);
					return;
				}
				const truncated = paths.length > MAX_TREE_ENTRIES;
				const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
				resolve(truncated ? display + `\n... (${paths.length} total entries)` : display);
			},
		);
	});
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execGh(
			["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10000, env: createChildProcessEnvironment() },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				try {
					const decoded = Buffer.from(stdout.trim(), "base64").toString("utf-8");
					resolve(decoded.length > 8192 ? flattenTruncatedString(decoded.slice(0, 8192) + "\n\n[README truncated at 8K chars]") : decoded);
				} catch {
					resolve(null);
				}
			},
		);
	});
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execGh(
			["api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10000, maxBuffer: 2 * 1024 * 1024, env: createChildProcessEnvironment() },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				try {
					resolve(Buffer.from(stdout.trim(), "base64").toString("utf-8"));
				} catch {
					resolve(null);
				}
			},
		);
	});
}

export async function fetchViaApi(
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	sizeNote?: string,
): Promise<ExtractedContent | null> {
	if (!isValidRepository(owner, repo)) return null;
	const ref = info.ref || (await getDefaultBranch(owner, repo));
	if (!ref || !isValidGitRef(ref) || !isValidRepoPath(info.path ?? "")) return null;
	const apiRef = encodeURIComponent(ref);

	const lines: string[] = [];
	if (sizeNote) {
		lines.push(sizeNote);
		lines.push("");
	}

	if (info.type === "blob" && info.path) {
		const apiPath = info.path.split("/").map(encodeURIComponent).join("/");
		const content = await fetchFileViaApi(owner, repo, apiPath, apiRef);
		if (!content) return null;

		lines.push(`## ${info.path}`);
		if (content.length > MAX_INLINE_FILE_CHARS) {
			lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
			lines.push(`\n[File truncated at 100K chars]`);
		} else {
			lines.push(content);
		}

		return {
			url,
			title: `${owner}/${repo} - ${info.path}`,
			content: lines.join("\n"),
			error: null,
		};
	}

	const [tree, readme] = await Promise.all([
		fetchTreeViaApi(owner, repo, apiRef),
		fetchReadmeViaApi(owner, repo, apiRef),
	]);

	if (!tree && !readme) return null;

	if (tree) {
		lines.push("## Structure");
		lines.push(tree);
		lines.push("");
	}

	if (readme) {
		lines.push("## README.md");
		lines.push(readme);
		lines.push("");
	}

	lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");

	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return {
		url,
		title,
		content: lines.join("\n"),
		error: null,
	};
}
