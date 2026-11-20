/**
 * The `execArgv` for a worker thread that evaluates Atomic's own CommonJS source (`new Worker(source, { eval: true })`).
 *
 * None of the process's command-line flags: a host started with `--input-type=module` would make that source a module,
 * which fails at its first `require`, and the host's `--import`/`--require` preloads would run again in every worker
 * (#6079). Under Node's permission model a worker is restricted only by the flags it starts with, so there it keeps the
 * process's flags (`undefined` inherits them) and stays as restricted as the process.
 */
export function evalWorkerExecArgv(): string[] | undefined {
	return process.permission === undefined ? [] : undefined;
}
