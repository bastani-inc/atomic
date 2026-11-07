// @ts-check
/** SSH implementation of the multi-node-resume suite. All temporary files and units are owned by this run. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { iptablesRules, parseCounters } from "./chaos.mjs";
import { runCommand, shellQuote } from "./commands.mjs";
import { attachCleanupFailure, DistributedProvisionError, DistributedTimeoutError } from "./errors.mjs";
import { NODE_BIN, REF_DIR, REMOTE_ROOT, SECRETS, UndoScope, unitState } from "./remote.mjs";
import { RESUME_LEASE_WAIT_MS, RESUME_STEP_TIMEOUT_MS } from "./resume-suite.mjs";

/** @typedef {import("./suites.mjs").NodeHost} NodeHost */
/** The real Git download deadline is ten minutes; SSH has extra time to report its typed result and cleanup. */
export const GITLESS_EGRESS_DENIED_BUDGET_MS = 11 * 60_000;
const BUN_VERSION = "1.4.4";
const POLL_MS = 1_000;

/** @param {string} phase @param {string} detail */
function failure(phase, detail) {
	return new DistributedProvisionError({ step: phase, resource: "multi-node-resume", detail });
}

/** @param {string} text @param {string} phase @returns {import("./resume-suite.mjs").DriverOutput} */
function document(text, phase) {
	const line = text
		.split("\n")
		.filter((entry) => entry.startsWith("{"))
		.at(-1);
	if (line === undefined) throw failure(phase, "the fixture produced no JSON observation");
	try {
		const value = /** @type {unknown} */ (JSON.parse(line));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object");
		return /** @type {import("./resume-suite.mjs").DriverOutput} */ (value);
	} catch (cause) {
		throw new DistributedProvisionError({
			step: phase,
			resource: "multi-node-resume",
			detail: "invalid fixture JSON",
			cause,
		});
	}
}

/** @param {import("./resume-suite.mjs").ResumeContext} ctx @returns {import("./resume-suite.mjs").ResumeRemote} */
export function resumeRemote(ctx) {
	const scope = new UndoScope({ signal: ctx.signal });
	const nodes = ctx.nodes.map((node) => scope.bind(node));
	const a = nodes[0];
	const b = nodes[1];
	const c = nodes.find((node) => node.roles.includes("git-less"));
	if (nodes.length < 3 || a === undefined || b === undefined || c === undefined || c === a || c === b)
		throw failure("select nodes", "three nodes are required, with a third git-less node");
	const work = `${REMOTE_ROOT}/resume-${ctx.attempt}`;
	const gitconfig = `${work}/gitconfig`;
	const bun = `${REMOTE_ROOT}/bun`;
	const sessionDriver = `${REF_DIR}/test/fixtures/multinode-resume-node.ts`;
	const runDriver = `${REF_DIR}/test/fixtures/multinode-run-node.ts`;
	const adapter = `${REF_DIR}/packages/storage-libsql/libsql.js`;
	const url = `https://${ctx.primary.ip}:${ctx.gatewayPort}`;
	const sessionPath = `${work}/node-a/home/session-repo`;
	const stepPath = `${work}/node-a/home/stepped`;
	const sessionAgent = `${work}/node-b/session-agent`;
	const gitlessAgent = `${work}/node-c/session-agent`;
	const runAgent = `${work}/node-b/run-agent`;
	const forkAgent = `${work}/node-b/fork-agent`;
	const runRoot = `${runAgent}/worktree-snapshots/worktrees`;
	const sessionRoot = `${sessionAgent}/worktree-snapshots/worktrees`;
	const gitlessRoot = `${gitlessAgent}/worktree-snapshots/worktrees`;
	const forkRoot = `${forkAgent}/worktree-snapshots/worktrees`;
	const alpha = `file://${work}/remotes/alpha.git`;
	const beta = `file://${work}/remotes/beta.git`;
	const storage = JSON.stringify({
		adapter,
		options: { url, namespace: ctx.namespace },
		secrets: { authToken: { file: `${SECRETS}/token` } },
	});
	const local = mkdtempSync(join(tmpdir(), "atomic-distributed-resume-"));
	/** @type {{ host: NodeHost, name: string }[]} */
	const units = [];
	/** @type {{ rules: ReturnType<typeof iptablesRules>, active: boolean }[]} */
	const partitions = [];
	let gitArchiveSha = "";
	let gitVersion = "";

	/** @param {NodeHost} host @param {string} script @param {string} operation */
	const text = async (host, script, operation) =>
		(await host.run(script, { operation, timeoutMs: RESUME_STEP_TIMEOUT_MS })).stdout.trim();
	/** @param {NodeHost} host @param {string} path */
	const exists = async (host, path) =>
		(await host.run(`test -e ${shellQuote(path)}`, { operation: "check run-owned path", allowExitCodes: [1] }))
			.exitCode === 0;
	/** @param {NodeHost} host @param {string} remote @param {string} destination */
	const download = (host, remote, destination) =>
		runCommand(host.context, "scp", ["-q", ...host.options, `${host.user}@${host.ip}:${remote}`, destination], {
			operation: `${host.name}: copy synthetic fixture archive`,
			timeoutMs: RESUME_STEP_TIMEOUT_MS,
			signal: scope.signal,
			retryableExitCodes: [255],
		});
	/** @param {NodeHost} _host @param {string} agentDir @param {string} nodeName @param {Record<string, string>} [extra] */
	const env = (_host, agentDir, nodeName, extra = {}) => ({
		HOME: `${work}/${nodeName}/home`,
		ATOMIC_CODING_AGENT_DIR: agentDir,
		ATOMIC_STORAGE: storage,
		ATOMIC_SESSIONS_STORAGE: "",
		ATOMIC_WORKFLOWS_JOURNAL: "",
		ATOMIC_WORKFLOW_JOURNAL_PATH: "",
		ATOMIC_CODING_AGENT_SESSION_DIR: "",
		ATOMIC_OFFLINE: "",
		MULTINODE_NODE: nodeName,
		MULTINODE_LIBSQL: adapter,
		MULTINODE_JOURNAL_URL: url,
		MULTINODE_JOURNAL_NAMESPACE: ctx.namespace,
		MULTINODE_JOURNAL_TOKEN_FILE: `${SECRETS}/token`,
		NODE_EXTRA_CA_CERTS: `${SECRETS}/ca.pem`,
		GIT_CONFIG_GLOBAL: gitconfig,
		GIT_CONFIG_NOSYSTEM: "1",
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		...extra,
	});
	/** @param {Record<string, string>} variables */
	const envWords = (variables) =>
		Object.entries(variables)
			.map(([key, value]) => shellQuote(`${key}=${value}`))
			.join(" ");
	/** @param {NodeHost} host @param {string} driver @param {string} command @param {object} args @param {Record<string, string>} variables @param {number} [timeoutMs] */
	const once = async (host, driver, command, args, variables, timeoutMs = RESUME_STEP_TIMEOUT_MS) => {
		const result = await host.run(
			`env ${envWords(variables)} ${shellQuote(bun)} --no-install ${shellQuote(driver)} ${shellQuote(command)} ${shellQuote(JSON.stringify(args))}`,
			{ operation: `${command} fixture`, timeoutMs, allowExitCodes: [2, 137] },
		);
		return {
			code: result.exitCode,
			signal: result.exitCode === 137 ? "SIGKILL" : null,
			output: result.exitCode === 137 ? {} : document(result.stdout, `${command} fixture`),
		};
	};
	/** @param {NodeHost} host @param {string} label @param {string} driver @param {string} command @param {object} args @param {Record<string, string>} variables */
	const start = async (host, label, driver, command, args, variables) => {
		const unit = `adt-${ctx.runId}-resume-${label}-${ctx.attempt}`;
		const log = `${work}/${label}.jsonl`;
		const words = [
			"sudo",
			"systemd-run",
			"--quiet",
			`--unit=${unit}`,
			`--uid=${host.user}`,
			`--gid=${host.user}`,
			`--property=WorkingDirectory=${variables.HOME}`,
			`--property=StandardOutput=append:${log}`,
			`--property=StandardError=append:${log}`,
			...Object.entries(variables).map(([key, value]) => `--setenv=${key}=${value}`),
			bun,
			"--no-install",
			driver,
			command,
			JSON.stringify(args),
		];
		await host.run(words.map(shellQuote).join(" "), { operation: `start ${label}` });
		units.push({ host, name: unit });
		return { unit, log };
	};
	/** @template T @param {string} phase @param {() => Promise<T | undefined>} probe @returns {Promise<T>} */
	const until = async (phase, probe) => {
		const began = performance.now();
		for (;;) {
			ctx.signal?.throwIfAborted();
			const result = await probe();
			if (result !== undefined) return result;
			const elapsedMs = Math.round(performance.now() - began);
			if (elapsedMs >= RESUME_STEP_TIMEOUT_MS)
				throw new DistributedTimeoutError({ phase, timeoutMs: RESUME_STEP_TIMEOUT_MS, elapsedMs });
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	};
	/** @param {NodeHost} host @param {{ unit: string, log: string }} process @param {readonly string[]} files */
	const awaitFiles = async (host, process, files) =>
		until("fixture markers", async () => {
			if ((await Promise.all(files.map((file) => exists(host, file)))).every(Boolean)) return true;
			const state = await unitState(host, process.unit);
			if (state.active !== "active" && state.active !== "activating")
				throw failure("fixture markers", `unit ${process.unit} ended before its markers`);
			return undefined;
		});
	/** @param {NodeHost} host @param {{ unit: string, log: string }} process */
	const kill = async (host, process) => {
		await host.run(`sudo systemctl kill --signal=SIGKILL --kill-whom=main ${shellQuote(process.unit)}`, {
			operation: "kill fixture process",
		});
		const state = await until("fixture killed", async () => {
			const current = await unitState(host, process.unit);
			return current.active === "failed" && current.result === "signal" ? current : undefined;
		});
		return { code: null, signal: state.result === "signal" ? "SIGKILL" : null };
	};
	/** The environment portable Git needs, matching the resolver's GitExecutable.env; system Git needs no overrides. */
	const gitEnvironment = (/** @type {string} */ git) => {
		if (git === "/usr/bin/git") return "";
		const root = dirname(dirname(git));
		return `GIT_EXEC_PATH=${shellQuote(`${root}/libexec/git-core`)} GIT_TEMPLATE_DIR=${shellQuote(`${root}/share/git-core/templates`)} GIT_CONFIG_SYSTEM=${shellQuote(`${root}/etc/gitconfig`)} GIT_SSL_CAINFO=${shellQuote(`${root}/ssl/cacert.pem`)}`;
	};
	/** @param {NodeHost} host @param {string} root @param {string} git @param {string} marker */
	const observeTree = async (host, root, git, marker) => {
		const command = `env ${gitEnvironment(git)} ${shellQuote(git)}`;
		const script = `set -o pipefail\ncd ${shellQuote(root)}\nH=$(${command} rev-parse HEAD)\n${command} fsck --no-progress >/dev/null\nN=0; if [ -f ${shellQuote(marker)} ]; then N=$(wc -l < ${shellQuote(marker)}); fi\nprintf '%s\\n%s\\n' "$H" "$N"`;
		const [head, count] = (await text(host, script, "verify restored tree")).split("\n");
		const manifest = /** @type {ReturnType<typeof import("../node/resume-check.mjs").treeManifest>} */ (
			await host.json(
				`${shellQuote(NODE_BIN)} ${shellQuote(`${REMOTE_ROOT}/harness/resume-check.mjs`)} tree ${shellQuote(root)}`,
				{ operation: "digest restored tree" },
			)
		);
		return { ...manifest, head, setupRuns: Number(count), fsck: true };
	};
	/** @param {NodeHost} host @param {string} root @param {string} git */
	const clean = async (host, root, git) =>
		/** @type {{ clean: boolean }} */ (
			await host.json(
				`env ${gitEnvironment(git)} ${shellQuote(NODE_BIN)} ${shellQuote(`${REMOTE_ROOT}/harness/resume-check.mjs`)} ${shellQuote(root)} ${shellQuote(git)}`,
				{
					operation: "check published restored worktrees",
				},
			)
		).clean === true;
	/** @param {NodeHost} host @param {string} root */
	const noWorktrees = async (host, root) => !(await exists(host, root));
	/** @param {NodeHost} host @param {string} agentDir @param {string} nodeName @param {string} id @param {Record<string,string>} [extra] */
	const sessionArgs = (host, agentDir, nodeName, id, extra = {}) => ({
		args: {
			sessionId: id,
			launchCwd: `${work}/${nodeName}/home`,
			readPath: `${sessionPath}/notes/agent-wrote.txt`,
			setupCommand: `echo ran >> ${work}/${nodeName}/setup-ran`,
		},
		variables: env(host, agentDir, nodeName, extra),
	});
	/** @param {NodeHost} host @param {string} agentDir @param {string} nodeName @param {string} id @param {Record<string,string>} [extra] @param {number} [timeoutMs] */
	const sessionResume = async (host, agentDir, nodeName, id, extra = {}, timeoutMs = RESUME_STEP_TIMEOUT_MS) => {
		const { args, variables } = sessionArgs(host, agentDir, nodeName, id, extra);
		return once(host, sessionDriver, "resume", args, variables, timeoutMs);
	};
	/** @param {NodeHost} host @param {import("./resume-suite.mjs").DriverOutput} output @param {string} marker @param {string} git @param {string} restoreRoot */
	const sessionObservation = async (host, output, marker, git, restoreRoot) => {
		const cwd = output.cwd;
		if (typeof cwd !== "string") throw failure("session resume", "fixture did not return a cwd");
		const tree = await observeTree(host, cwd, git, marker);
		const parts = Array.isArray(output.toolResult) ? output.toolResult : [];
		return {
			...tree,
			cwd,
			restoreRoot,
			notice:
				Array.isArray(output.notices) &&
				output.notices.some(
					(notice) =>
						typeof notice?.message === "string" && notice.message.startsWith("Restored worktree snapshot"),
				),
			userMessages: output.userMessages,
			oldPathContent: parts.map((part) => part?.text ?? "").join(""),
			clean: await clean(host, restoreRoot, git),
		};
	};
	/** @param {string} path */
	const shimScript = (path) =>
		`mkdir -p ${shellQuote(path)}; cat > ${shellQuote(`${path}/git`)} <<'SHIM'\n#!/bin/sh\n/usr/bin/git "$@"\ns=$?\ncase "$*" in *"worktree add"*) if [ ! -e ${shellQuote(`${path}/killed`)} ]; then : > ${shellQuote(`${path}/killed`)}; kill -9 "$PPID"; fi;; esac\nexit "$s"\nSHIM\nchmod 755 ${shellQuote(`${path}/git`)}`;
	/** @param {string} kind @param {() => Promise<import("./resume-suite.mjs").DriverResult>} action @param {string} root */
	const partition = async (kind, action, root) => {
		const rules = iptablesRules(`adt-${ctx.runId}-resume-${kind}`, "full", {
			dbIp: ctx.primary.ip,
			port: ctx.gatewayPort,
		});
		const tracked = { rules, active: true };
		partitions.push(tracked);
		let result;
		let counters;
		try {
			await b.run(rules.apply, { operation: `partition ${kind}` });
			result = await action();
			counters = parseCounters(await text(b, rules.counters, `partition ${kind} counters`));
		} catch (error) {
			try {
				await scope.undo(() => b.run(rules.clear, { operation: `clear ${kind} partition` }));
				tracked.active = false;
			} catch (cleanup) {
				attachCleanupFailure(error, cleanup);
			}
			throw error;
		}
		await scope.undo(() => b.run(rules.clear, { operation: `clear ${kind} partition` }));
		tracked.active = false;
		const remaining = await text(
			b,
			`sudo iptables -S | grep -c ${shellQuote(`adt-${ctx.runId}-resume-${kind}`)} || true`,
			`verify ${kind} partition cleared`,
		);
		return {
			code: result.code,
			signal: result.signal,
			error: result.output.error,
			noWorktrees: await noWorktrees(b, root),
			dropped: counters.OUTPUT ?? 0,
			cleared: remaining === "0",
		};
	};
	/** @param {string} id */
	const runInputs = (id) => ({ runId: id, alpha, beta });

	return {
		undo: (action) => scope.undo(action),
		prepare: async () => {
			const version = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
			if (version !== BUN_VERSION) throw failure("stage Bun", `expected ${BUN_VERSION}, found ${version}`);
			const executable = realpathSync(execFileSync("which", ["bun"], { encoding: "utf8" }).trim());
			for (const host of [a, b, c]) {
				await host.run(
					`mkdir -p ${shellQuote(work)} ${shellQuote(`${work}/node-a/home`)} ${shellQuote(`${work}/node-b/home`)} ${shellQuote(`${work}/node-c/home`)}; printf '%s\\n' '[user]' ' name = Fixture' ' email = fixture@example.com' '[commit]' ' gpgSign = false' '[protocol "file"]' ' allow = always' > ${shellQuote(gitconfig)}`,
					{ operation: "prepare resume fixture directories" },
				);
				await host.upload(executable, bun, "upload pinned Bun");
				const actual = await text(
					host,
					`chmod 755 ${shellQuote(bun)}; ${shellQuote(bun)} --version`,
					"verify Bun version",
				);
				if (actual !== BUN_VERSION) throw failure("stage Bun", `node ${host.name} reports ${actual}`);
			}
			const script = `export GIT_CONFIG_GLOBAL=${shellQuote(gitconfig)} GIT_CONFIG_NOSYSTEM=1\nmkdir -p ${shellQuote(`${work}/remotes`)} ${shellQuote(`${work}/seeds`)}\nfor name in session alpha beta stepped; do\n  mkdir -p ${shellQuote(`${work}/seeds`)}/$name\n  git -C ${shellQuote(`${work}/seeds`)}/$name init -q -b main\n  printf '%s\\n' "$name" > ${shellQuote(`${work}/seeds`)}/$name/README.md\n  if [ "$name" = session ]; then printf '{}\\n' > ${shellQuote(`${work}/seeds`)}/$name/package-lock.json; fi\n  if [ "$name" = stepped ]; then printf 'zero\\n' > ${shellQuote(`${work}/seeds`)}/$name/state.txt; fi\n  git -C ${shellQuote(`${work}/seeds`)}/$name add -A\n  git -C ${shellQuote(`${work}/seeds`)}/$name commit -q -m initial\n  git clone -q --bare ${shellQuote(`${work}/seeds`)}/$name ${shellQuote(`${work}/remotes`)}/$name.git\ndone\ngit clone -q ${shellQuote(`${work}/remotes/session.git`)} ${shellQuote(sessionPath)}\ngit -C ${shellQuote(sessionPath)} branch --set-upstream-to=origin/main >/dev/null\nprintf 'only on node A\\n' > ${shellQuote(`${sessionPath}/unpushed.txt`)}\ngit -C ${shellQuote(sessionPath)} add -A && git -C ${shellQuote(sessionPath)} commit -q -m unpushed\nprintf 'uncommitted edit\\n' > ${shellQuote(`${sessionPath}/README.md`)}\nmkdir -p ${shellQuote(`${sessionPath}/notes`)}\nprintf 'untracked\\n' > ${shellQuote(`${sessionPath}/notes/untracked.txt`)}\ngit clone -q ${shellQuote(`${work}/remotes/stepped.git`)} ${shellQuote(stepPath)}\ntar -cf ${shellQuote(`${work}/remotes.tar`)} -C ${shellQuote(work)} remotes\nP=${shellQuote(`${work}/portable-git`)}; mkdir -p "$P/bin" "$P/libexec" "$P/share/git-core" "$P/etc" "$P/ssl"\ncp "$(command -v git)" "$P/bin/git"; cp -a "$(git --exec-path)" "$P/libexec/git-core"; cp -a /usr/share/git-core/templates "$P/share/git-core/templates"\n: > "$P/etc/gitconfig"; : > "$P/ssl/cacert.pem"\ntar czf ${shellQuote(`${work}/portable-git.tar.gz`)} -C "$P" .\nsha256sum ${shellQuote(`${work}/portable-git.tar.gz`)} | cut -d' ' -f1; git --version | awk '{print $3}'`;
			const built = (await text(a, script, "create synthetic repositories and Git archive")).split("\n");
			gitVersion = built.at(-1) ?? "";
			gitArchiveSha = built.at(-2) ?? "";
			if (!/^[a-f0-9]{64}$/.test(gitArchiveSha) || !gitVersion)
				throw failure("create Git archive", "missing digest or version");
			for (const archive of ["remotes.tar", "portable-git.tar.gz"]) {
				const target = join(local, archive);
				await download(a, `${work}/${archive}`, target);
				for (const host of [b, c]) await host.upload(target, `${work}/${archive}`, `upload ${archive}`);
			}
			for (const host of [b, c])
				await host.run(`tar -xf ${shellQuote(`${work}/remotes.tar`)} -C ${shellQuote(work)}`, {
					operation: "unpack synthetic repositories",
				});
			await c.run("! command -v git", { operation: "verify git-less node" });
		},
		recordSession: async () => {
			const args = {
				cwd: sessionPath,
				file: `${sessionPath}/notes/agent-wrote.txt`,
				content: "written by the model on node A\n",
			};
			const process = await start(
				a,
				"session-source",
				sessionDriver,
				"record",
				args,
				env(a, `${work}/node-a/session-agent`, "node-a"),
			);
			const recorded = await until("session recorded", async () => {
				if (await exists(a, process.log)) {
					const content = await text(a, `cat ${shellQuote(process.log)}`, "read session record");
					const line = content.split("\n").find((entry) => entry.startsWith("{"));
					if (line) return document(line, "session record");
				}
				const state = await unitState(a, process.unit);
				if (state.active !== "active" && state.active !== "activating")
					throw failure("record session", "fixture ended before recording a session");
				return undefined;
			});
			if (typeof recorded.sessionId !== "string" || recorded.snapshots !== 1)
				throw failure("record session", "session or snapshot missing");
			const source = await observeTree(a, sessionPath, "/usr/bin/git", `${work}/unused`);
			await kill(a, process);
			return { id: recorded.sessionId, source };
		},
		partitionSession: (id) => partition("session", () => sessionResume(b, sessionAgent, "node-b", id), sessionRoot),
		killSessionRestore: async (id) => {
			const path = `${work}/node-b/shim`;
			await b.run(shimScript(path), { operation: "install restore-kill shim" });
			const killed = await sessionResume(b, sessionAgent, "node-b", id, {
				PATH: `${path}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
			});
			return { ...killed, marker: await exists(b, `${path}/killed`) };
		},
		resumeSession: async (id) => {
			const result = await sessionResume(b, sessionAgent, "node-b", id, {
				PATH: `${work}/node-b/shim:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
			});
			if (result.code !== 0)
				throw failure(
					"resume session",
					`fixture exited ${result.code}: ${JSON.stringify(result.output.error ?? null)}`,
				);
			return {
				observation: await sessionObservation(
					b,
					result.output,
					`${work}/node-b/setup-ran`,
					"/usr/bin/git",
					sessionRoot,
				),
				clean: await clean(b, sessionRoot, "/usr/bin/git"),
			};
		},
		gitlessFailure: async (id) => {
			const result = await sessionResume(c, gitlessAgent, "node-c", id, {}, GITLESS_EGRESS_DENIED_BUDGET_MS);
			return {
				code: result.code,
				signal: result.signal,
				error: result.output.error,
				noWorktrees: await noWorktrees(c, gitlessRoot),
				provisioned: await exists(c, `${gitlessAgent}/bin/git/bin/git`),
			};
		},
		gitlessResume: async (id) => {
			const result = await sessionResume(c, gitlessAgent, "node-c", id, {
				PROVISION_ARCHIVE: `${work}/portable-git.tar.gz`,
				PROVISION_SHA256: gitArchiveSha,
				PROVISION_VERSION: gitVersion,
			});
			if (result.code !== 0)
				throw failure(
					"gitless resume",
					`fixture exited ${result.code}: ${JSON.stringify(result.output.error ?? null)}`,
				);
			const git = `${gitlessAgent}/bin/git/bin/git`;
			return {
				...(await sessionObservation(c, result.output, `${work}/node-c/setup-ran`, git, gitlessRoot)),
				provisioned: await exists(c, git),
			};
		},
		recordRun: async () => {
			const id = randomUUID();
			const hold = `${work}/node-a/holds`;
			await a.run(`mkdir -p ${shellQuote(hold)}`, { operation: "prepare held workflow" });
			const process = await start(
				a,
				"run-source",
				runDriver,
				"two-repos",
				runInputs(id),
				env(a, `${work}/node-a/run-agent`, "node-a", { HOLD_DIR: hold }),
			);
			await awaitFiles(a, process, [`${hold}/alpha.holding`, `${hold}/beta.holding`]);
			return { id, killed: await kill(a, process) };
		},
		waitForLease: async () => {
			if (ctx.signal?.aborted) throw ctx.signal.reason;
			await new Promise((resolve, reject) => {
				const signal = ctx.signal;
				const abort = () => {
					clearTimeout(timer);
					reject(signal?.reason);
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", abort);
					resolve(undefined);
				}, RESUME_LEASE_WAIT_MS);
				signal?.addEventListener("abort", abort, { once: true });
			});
		},
		partitionRun: (id) =>
			partition("run", () => once(b, runDriver, "two-repos", runInputs(id), env(b, runAgent, "node-b")), runRoot),
		resumeRun: async (id) => {
			const result = await once(b, runDriver, "two-repos", runInputs(id), env(b, runAgent, "node-b"));
			if (result.code !== 0)
				throw failure(
					"resume workflow",
					`fixture exited ${result.code}: ${JSON.stringify(result.output.error ?? null)}`,
				);
			const children = [];
			for (const name of ["alpha", "beta"]) {
				const child = JSON.parse(result.output.result?.[name] ?? "{}");
				if (typeof child.cwd !== "string") throw failure("resume workflow", `${name} returned no cwd`);
				const repository = await text(b, `cat ${shellQuote(`${child.cwd}/README.md`)}`, `read ${name} repository`);
				children.push({ ...child, repository: `${repository}\n` });
			}
			return {
				status: result.output.status,
				children,
				restoreRoot: runRoot,
				clean: await clean(b, runRoot, "/usr/bin/git"),
			};
		},
		fork: async () => {
			const id = randomUUID();
			const source = await once(
				a,
				runDriver,
				"stepped",
				{ runId: id, cwd: stepPath },
				env(a, `${work}/node-a/fork-agent`, "node-a"),
			);
			if (source.code !== 0 || source.output.status !== "completed")
				throw failure("record fork source", JSON.stringify(source.output.error ?? source.output));
			const fork = await once(
				b,
				runDriver,
				"fork",
				{ sourceRunId: id, fromStage: "two" },
				env(b, forkAgent, "node-b"),
			);
			if (fork.code !== 0) throw failure("fork workflow", JSON.stringify(fork.output.error ?? null));
			const one = JSON.parse(fork.output.result?.one ?? "{}");
			const two = JSON.parse(fork.output.result?.two ?? "{}");
			return {
				status: fork.output.status,
				beforeOne: one.before,
				beforeTwo: two.before,
				cwd: two.cwd,
				restoreRoot: forkRoot,
			};
		},
		integrity: async () =>
			(
				await a.agent("integrity", [
					"--ref-dir",
					REF_DIR,
					"--journal",
					"shared",
					"--url",
					url,
					"--namespace",
					ctx.namespace,
					"--token-file",
					`${SECRETS}/token`,
				])
			).result,
		close: async () => {
			/** @type {unknown[]} */
			const failures = [];
			try {
				await scope.undo(async () => {
					for (const item of partitions.filter((item) => item.active)) {
						try {
							await b.run(item.rules.clear, { operation: "clear resume partition" });
						} catch (error) {
							failures.push(error);
						}
					}
					for (const unit of units) {
						try {
							await unit.host.run(`sudo systemctl stop ${shellQuote(unit.name)}`, {
								operation: `stop ${unit.name}`,
							});
						} catch (error) {
							failures.push(error);
						}
					}
				});
			} finally {
				rmSync(local, { recursive: true, force: true });
			}
			if (failures.length > 0)
				throw new DistributedProvisionError({
					step: "cleanup",
					resource: "multi-node-resume",
					detail: `${failures.length} cleanup operations failed`,
					cause: new AggregateError(failures),
				});
		},
	};
}
