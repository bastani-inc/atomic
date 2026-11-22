import { createChildProcessEnvironment, createGitEnvironment, resolveInstalledGit } from "@bastani/atomic";
import { type OutputPage, type OwnerLease, TaskSupervisor } from "@bastani/atomic-natives";

interface SupervisedOwner {
	readonly supervisor: TaskSupervisor;
	readonly owner: OwnerLease;
}

let sharedOwner: SupervisedOwner | undefined;
let nextOwnerGeneration = 0;
let nextOperationId = 0;

function accepted<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function getSupervisedOwner(): SupervisedOwner {
	if (sharedOwner !== undefined) return sharedOwner;
	const supervisor = new TaskSupervisor();
	const scope = {
		kind: "session" as const,
		sessionId: `named-worktree-${process.pid}-${++nextOwnerGeneration}`,
	};
	const owner = accepted(supervisor.openTaskOwner(supervisor.bindHostSession(scope), scope));
	sharedOwner = { supervisor, owner };
	return sharedOwner;
}

/**
 * Runs `git worktree add` with `args` in `repo`. Git before 2.33 has no `--reason` for it and stops at its usage text
 * (exit code 129): the add then runs again without `--lock --reason <text>`. Git marks a worktree it adds that way
 * `initializing` until it is checked out and unlocks it then, so a later launch reads an add underway as it reads any
 * other Git's, not as one of its own.
 */
export async function addNamedWorktree(
	repo: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<{ status: number; stdout: string; stderr: string }> {
	const added = await runWorktreeAdd(repo, args, env, signal);
	const reason = args.indexOf("--reason");
	if (added.status !== 129 || reason < 0 || args[reason - 1] !== "--lock") return added;
	return runWorktreeAdd(repo, [...args.slice(0, reason - 1), ...args.slice(reason + 2)], env, signal);
}

async function runWorktreeAdd(
	repo: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<{ status: number; stdout: string; stderr: string }> {
	signal?.throwIfAborted();
	const git = await resolveInstalledGit();
	let { supervisor, owner } = getSupervisedOwner();
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(
		createGitEnvironment({ ...env, LANGUAGE: "C" }, createChildProcessEnvironment(undefined, git.env)),
	))
		if (value !== undefined) environment[key] = value;
	const intent = {
		kind: "command" as const,
		command: args.at(-1)!,
		shell: { program: git.path, args: ["-C", repo, ...args.slice(0, -1)] },
		cwd: repo,
		env: environment,
		inheritEnv: false,
		terminal: { kind: "pipe" as const },
	};
	const options = { keepBackgroundOnExit: true, retainRecordOnStart: true };
	let started = await supervisor.startCommandTask(owner, intent, `checkout-${++nextOperationId}`, options);
	if (!started.ok && started.error.code === "OwnerClosing") {
		sharedOwner = undefined;
		({ supervisor, owner } = getSupervisedOwner());
		started = await supervisor.startCommandTask(owner, intent, `checkout-${++nextOperationId}`, options);
	}
	const task = accepted(started);
	try {
		const cancel = (): void => {
			supervisor.cancelTask(task, "user");
		};
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		const wait = accepted(supervisor.waitForTask(task));
		try {
			const outcome = accepted(await supervisor.observeTaskWait(wait));
			if (outcome.kind !== "settled") throw new Error("Named-worktree checkout did not finish");
			const chunks: Buffer[] = [];
			let offset: string | undefined = "0";
			while (offset !== undefined) {
				const page: OutputPage = accepted(
					await supervisor.readTaskOutput(task, { start: offset, maximumBytes: 1024 * 1024 }),
				);
				chunks.push(...page.chunks.map((chunk) => chunk.bytes));
				offset = page.nextOffset;
			}
			const output = Buffer.concat(chunks).toString("utf8");
			if (outcome.result.kind === "cancelled") {
				signal?.throwIfAborted();
				throw new Error("Named-worktree checkout was cancelled");
			}
			return {
				status: outcome.result.exitCode ?? 1,
				stdout: output,
				stderr: outcome.result.kind === "failed" ? `${outcome.result.message}\n${output}` : "",
			};
		} finally {
			signal?.removeEventListener("abort", cancel);
			supervisor.disposeTaskWait(wait);
		}
	} finally {
		supervisor.releaseTaskRecord(task);
	}
}
