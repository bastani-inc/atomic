import { randomUUID } from "node:crypto";
import { createChildProcessEnvironment, createGitEnvironment, resolveGitSync } from "@bastani/atomic";
import { type OutputPage, TaskSupervisor } from "@bastani/atomic-natives";

function accepted<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

export async function addNamedWorktree(
	repo: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<{ status: number; stdout: string; stderr: string }> {
	signal?.throwIfAborted();
	const git = resolveGitSync();
	const supervisor = new TaskSupervisor();
	const scope = { kind: "session" as const, sessionId: `named-worktree-${randomUUID()}` };
	const owner = accepted(supervisor.openTaskOwner(supervisor.bindHostSession(scope), scope));
	try {
		const environment: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			createGitEnvironment(
				{ ...env, LC_ALL: "C", LANGUAGE: "C" },
				createChildProcessEnvironment(undefined, git.env),
			),
		))
			if (value !== undefined) environment[key] = value;
		const task = accepted(
			await supervisor.startCommandTask(
				owner,
				{
					kind: "command",
					command: args.at(-1)!,
					shell: { program: git.path, args: ["-C", repo, ...args.slice(0, -1)] },
					cwd: repo,
					env: environment,
					inheritEnv: false,
					terminal: { kind: "pipe" },
				},
				"checkout",
			),
		);
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
		accepted(await supervisor.closeTaskOwner(owner, "session-close"));
		supervisor.trimClosedTaskOwner(owner);
	}
}
