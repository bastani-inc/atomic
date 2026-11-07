import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { type GitProvisionError, isGitProvisionError } from "../../utils/git-errors.ts";
import { TEAM_JOIN_COMMAND } from "../agent-rehydrate-errors.ts";
import { StorageAdapterLoadError } from "../storage/errors.js";
import { loadStorageAdapter, type SecretRef, type StorageSelection, secretFilePath } from "../storage/provider.js";
import { gitText } from "../worktree-snapshot/git.ts";
import { type ResumeEntryPoint, ResumePreconditionError, type ResumePreconditionProblem } from "./errors.ts";

/** The I/O a resume precondition check performs. Injectable so tests can count it. */
export interface ResumePreflightIo {
	/** Loads a storage adapter module without opening a database. Rejects with StorageAdapterLoadError. */
	loadAdapter(module: string, agentDir: string, domain: StorageDomainName): Promise<void>;
	readText(path: string): Promise<string>;
	env(name: string): string | undefined;
	/**
	 * The typed reason Git can neither be started nor provisioned (`GitUnavailableError`, or the `GitProvisionError`
	 * of a failed download), or undefined when it can. Provisions Git when this machine has none.
	 */
	probeGit(signal?: AbortSignal): Promise<GitProvisionError | undefined>;
}

export type StorageDomainName = "sessions" | "journal";

export const defaultResumePreflightIo: ResumePreflightIo = {
	async loadAdapter(module, agentDir, domain) {
		await loadStorageAdapter(module, { agentDir, domain });
	},
	readText: (path) => readFile(path, "utf8"),
	env: (name) => process.env[name],
	async probeGit(signal) {
		try {
			await gitText(["--version"], { cwd: tmpdir(), signal });
			return undefined;
		} catch (error) {
			if (!signal?.aborted && isGitProvisionError(error)) return error;
			throw error;
		}
	},
};

/** A storage selection this resume reads through, and the domain it serves. */
export interface ResumeStorageTarget {
	readonly domain: StorageDomainName;
	readonly selection: StorageSelection;
}

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const DOMAIN_RECORDS: Record<StorageDomainName, string> = { sessions: "sessions", journal: "workflow runs" };

function adapterProblem(module: string, domain: StorageDomainName, agentDir: string): ResumePreconditionProblem {
	return {
		code: "adapter-not-installed",
		subject: `storage adapter ${module}`,
		why: `this node's ${domain} storage selects it, and resuming reads ${DOMAIN_RECORDS[domain]} recorded on other nodes through it, but it cannot be loaded`,
		fix: PACKAGE_NAME.test(module)
			? `Install it with \`atomic install npm:${module}\`.`
			: `Make ${module} loadable from ${agentDir}.`,
	};
}

async function secretProblem(
	name: string,
	ref: Exclude<SecretRef, { readonly value: string }>,
	module: string,
	agentDir: string,
	io: ResumePreflightIo,
): Promise<ResumePreconditionProblem | undefined> {
	const why = `storage secret ${name} of ${module} reads it to authenticate to the shared storage`;
	if ("env" in ref) {
		const value = io.env(ref.env);
		if (value !== undefined && value.length > 0) return undefined;
		return {
			code: "credential-missing",
			subject: `environment variable ${ref.env}`,
			why: `${why}, and it is ${value === undefined ? "not set" : "empty"}`,
			fix: `Set ${ref.env} for this process, or join with \`${TEAM_JOIN_COMMAND}\` to keep the token in a file.`,
		};
	}
	const path = secretFilePath(ref.file, agentDir);
	const fix = `Write the token to ${path} (mode 600, readable by this user), or join again with \`${TEAM_JOIN_COMMAND}\`.`;
	let text: string;
	try {
		text = await io.readText(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return {
				code: "credential-missing",
				subject: `token file ${path}`,
				why: `${why}, and it does not exist`,
				fix,
			};
		}
		return {
			code: "credential-unreadable",
			subject: `token file ${path}`,
			why: `${why}, and it cannot be read (${code ?? "read failed"})`,
			fix,
		};
	}
	if (text.trim().length > 0) return undefined;
	return { code: "credential-missing", subject: `token file ${path}`, why: `${why}, and it is empty`, fix };
}

/**
 * Every unmet storage precondition of `targets` in one pass: adapters that cannot be loaded and secrets that are
 * missing or unreadable. Loads each adapter module once and reads each secret once; opens no database.
 */
export async function storagePreconditionProblems(
	targets: readonly ResumeStorageTarget[],
	agentDir: string,
	io: ResumePreflightIo = defaultResumePreflightIo,
): Promise<ResumePreconditionProblem[]> {
	const problems: ResumePreconditionProblem[] = [];
	const loaded = new Set<string>();
	const read = new Set<string>();
	for (const { domain, selection } of targets) {
		if (selection.kind !== "adapter") continue;
		if (!loaded.has(selection.module)) {
			loaded.add(selection.module);
			try {
				await io.loadAdapter(selection.module, agentDir, domain);
			} catch (error) {
				if (!(error instanceof StorageAdapterLoadError)) throw error;
				problems.push(adapterProblem(selection.module, domain, agentDir));
			}
		}
		for (const [name, ref] of Object.entries(selection.secrets ?? {})) {
			if (!("env" in ref) && !("file" in ref)) continue;
			const key = "env" in ref ? `env:${ref.env}` : `file:${secretFilePath(ref.file, agentDir)}`;
			if (read.has(key)) continue;
			read.add(key);
			const problem = await secretProblem(name, ref, selection.module, agentDir, io);
			if (problem) problems.push(problem);
		}
	}
	return problems;
}

/** The precondition problem for a restore that needs Git on a node where it can neither be started nor provisioned. */
export function gitUnavailableProblem(error: GitProvisionError, why: string): ResumePreconditionProblem {
	return { code: "git-unavailable", subject: `git (${error.code})`, why, fix: error.hint };
}

/**
 * Throws one {@link ResumePreconditionError} listing every problem, with `cause` (the typed reason Git is unavailable,
 * when that is one of them) as its cause, or returns when there are none.
 */
export function assertResumePreconditions(
	entryPoint: ResumeEntryPoint,
	problems: readonly ResumePreconditionProblem[],
	cause?: Error,
): void {
	if (problems.length > 0) throw new ResumePreconditionError({ entryPoint, problems }, cause);
}

/** Checks the storage `targets` select before any of it is opened, and throws every unmet precondition together. */
export async function checkResumeStoragePreconditions(
	entryPoint: ResumeEntryPoint,
	targets: readonly ResumeStorageTarget[],
	agentDir: string,
	io: ResumePreflightIo = defaultResumePreflightIo,
): Promise<void> {
	assertResumePreconditions(entryPoint, await storagePreconditionProblems(targets, agentDir, io));
}
