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
import { NODE_BIN, REF_DIR, REMOTE_ROOT, RESUME_POOL, SECRETS, UndoScope, unitState } from "./remote.mjs";
import { RESUME_LEASE_WAIT_MS, RESUME_STEP_TIMEOUT_MS } from "./resume-suite.mjs";

/** @typedef {import("./suites.mjs").NodeHost} NodeHost */
/** @typedef {import("./resume-suite.mjs").DriverResult} DriverResult */
/** @typedef {{ unit: string, log: string }} Unit */
/** The real Git download deadline is ten minutes; SSH has extra time to report its typed result and cleanup. */
export const GITLESS_EGRESS_DENIED_BUDGET_MS = 11 * 60_000;
/**
 * The work lease of the pooled campaign's root: a child whose host was killed is back in the queue this long after its
 * last renewal. Long enough that a host in the other region, a cross-region round trip from the database, never loses
 * a lease it is renewing.
 */
export const POOL_WORK_LEASE_MS = 20_000;
/** How long the campaign's work waits for a capable host before it fails for want of one. */
export const POOL_CLAIM_WINDOW_MS = 300_000;
const BUN_VERSION = "1.4.4";
const POLL_MS = 1_000;
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** What the recording node's model writes, and the read tool returns through the recorded absolute path. */
const WRITTEN = "written by the model on node A\n";
const SUBAGENT_WRITTEN = "written by the subagent on node A\n";

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

/**
 * The scripted state of a checkout the way a session leaves it: an unpushed commit, an uncommitted edit and an
 * untracked file, cloned from one of the run's synthetic remotes.
 * @param {string} remote @param {string} path
 */
function dirtyCheckout(remote, path) {
	const at = shellQuote(path);
	return [
		`git clone -q ${shellQuote(remote)} ${at}`,
		`git -C ${at} branch --set-upstream-to=origin/main >/dev/null`,
		`printf 'only on node A\\n' > ${shellQuote(`${path}/unpushed.txt`)}`,
		`git -C ${at} add -A && git -C ${at} commit -q -m unpushed`,
		`printf 'uncommitted edit\\n' > ${shellQuote(`${path}/README.md`)}`,
		`mkdir -p ${shellQuote(`${path}/notes`)}`,
		`printf 'untracked\\n' > ${shellQuote(`${path}/notes/untracked.txt`)}`,
	].join("\n");
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
	const releasedDriver = `${REF_DIR}/test/fixtures/multinode-released-node.ts`;
	const subagentDriver = `${REF_DIR}/test/fixtures/multinode-released-subagent-node.ts`;
	const adapter = `${REF_DIR}/packages/storage-libsql/libsql.js`;
	const url = `https://${ctx.primary.ip}:${ctx.gatewayPort}`;
	const sessionPath = `${work}/node-a/home/session-repo`;
	const stepPath = `${work}/node-a/home/stepped`;
	const sessionAgent = `${work}/node-b/session-agent`;
	const gitlessAgent = `${work}/node-c/session-agent`;
	const gitlessGit = `${gitlessAgent}/bin/git/bin/git`;
	const runAgent = `${work}/node-b/run-agent`;
	const forkAgent = `${work}/node-c/fork-agent`;
	const wakeAgent = `${work}/node-b/wake-agent`;
	const subagentWakeAgent = `${work}/node-b/subagent-wake-agent`;
	const subagentWakeRoot = `${subagentWakeAgent}/worktree-snapshots/worktrees`;
	const runRoot = `${runAgent}/worktree-snapshots/worktrees`;
	const sessionRoot = `${sessionAgent}/worktree-snapshots/worktrees`;
	const gitlessRoot = `${gitlessAgent}/worktree-snapshots/worktrees`;
	const forkRoot = `${forkAgent}/worktree-snapshots/worktrees`;
	const wakeRoot = `${wakeAgent}/worktree-snapshots/worktrees`;
	const alpha = `file://${work}/remotes/alpha.git`;
	const beta = `file://${work}/remotes/beta.git`;
	const storage = JSON.stringify({
		adapter,
		options: { url, namespace: ctx.namespace },
		secrets: { authToken: { file: `${SECRETS}/token` } },
	});
	// The pooled campaign (scenario 3): one directory at the same path on every node, and a host on each.
	const poolDir = `${work}/pool`;
	const poolRepo = `${work}/node-a/home/pool-repo`;
	const poolRootId = `adt-pool-${ctx.attempt}`;
	const poolNodes = /** @type {const} */ ({ A: "node-a", B: "node-b", C: "node-c" });
	const poolHosts = { A: a, B: b, C: c };
	const poolAgent = (/** @type {"A" | "B" | "C"} */ name) => `${work}/${poolNodes[name]}/pool-agent`;
	const restoreRoots = {
		A: `${poolAgent("A")}/worktree-snapshots/worktrees`,
		B: `${poolAgent("B")}/worktree-snapshots/worktrees`,
		C: `${poolAgent("C")}/worktree-snapshots/worktrees`,
	};
	const poolJournal = [
		"--url",
		url,
		"--namespace",
		ctx.namespace,
		"--token-file",
		`${SECRETS}/token`,
		"--prefix",
		`mnr_${ctx.attempt}_`,
	];
	const local = mkdtempSync(join(tmpdir(), "atomic-distributed-resume-"));
	/** A shell script that runs Git with the run's own configuration. @param {string} script */
	const gitScript = (script) => `export GIT_CONFIG_GLOBAL=${shellQuote(gitconfig)} GIT_CONFIG_NOSYSTEM=1\n${script}`;
	/** @type {{ host: NodeHost, name: string }[]} */
	const units = [];
	/** @type {{ host: NodeHost, rules: ReturnType<typeof iptablesRules>, active: boolean }[]} */
	const partitions = [];
	let gitArchiveSha = "";
	let gitVersion = "";
	let runKilledAt = 0;
	/** @type {Partial<Record<"A" | "B" | "C", Unit>>} */
	const poolUnits = {};
	/** @type {Unit | undefined} */
	let poolRootUnit;
	/** @type {Partial<Record<"A" | "B" | "C", { git?: string, restore?: boolean }>>} */
	const poolStats = {};
	/** @type {{ host: string, cwd: string, pid: number } | undefined} */
	let firstHeld;
	/** @type {import("./resume-invariants.mjs").SessionObservation | undefined} */
	let poolSource;

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
		PATH: BASE_PATH,
		...extra,
	});
	/** @param {Record<string, string>} variables */
	const envWords = (variables) =>
		Object.entries(variables)
			.map(([key, value]) => shellQuote(`${key}=${value}`))
			.join(" ");
	/** @param {string} driver @param {string} command @param {object} args */
	const bunCommand = (driver, command, args) => [bun, "--no-install", driver, command, JSON.stringify(args)];
	/** @param {NodeHost} host @param {string} driver @param {string} command @param {object} args @param {Record<string, string>} variables @param {number} [timeoutMs] @returns {Promise<DriverResult>} */
	const once = async (host, driver, command, args, variables, timeoutMs = RESUME_STEP_TIMEOUT_MS) => {
		const result = await host.run(
			`env ${envWords(variables)} ${bunCommand(driver, command, args).map(shellQuote).join(" ")}`,
			{ operation: `${command} fixture`, timeoutMs, allowExitCodes: [2, 137] },
		);
		return {
			code: result.exitCode,
			signal: result.exitCode === 137 ? "SIGKILL" : null,
			output: result.exitCode === 137 ? {} : document(result.stdout, `${command} fixture`),
		};
	};
	/**
	 * Starts `command` in a run-owned unit that logs to `<work>/<label>.jsonl`. With `exitFile`, a shell around it
	 * records its exit status there, since a unit that exits cleanly is unloaded with its status.
	 * @param {NodeHost} host @param {string} label @param {readonly string[]} command @param {Record<string, string>} variables
	 * @param {{ exitFile?: string, properties?: readonly string[] }} [options]
	 * @returns {Promise<Unit>}
	 */
	const start = async (host, label, command, variables, { exitFile, properties = [] } = {}) => {
		const unit = `adt-${ctx.runId}-resume-${label}-${ctx.attempt}`;
		const log = `${work}/${label}.jsonl`;
		const program =
			exitFile === undefined
				? command
				: ["/bin/sh", "-c", `"$0" "$@"; echo $? > ${shellQuote(exitFile)}`, ...command];
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
			...properties.map((property) => `--property=${property}`),
			...Object.entries(variables).map(([key, value]) => `--setenv=${key}=${value}`),
			...program,
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
	/** @param {NodeHost} host @param {Unit} process */
	const running = async (host, process) => {
		const state = await unitState(host, process.unit);
		return state.active === "active" || state.active === "activating";
	};
	/** @param {NodeHost} host @param {Unit} process @param {string} phase */
	const ensureRunning = async (host, process, phase) => {
		if (!(await running(host, process))) throw failure(phase, `unit ${process.unit} ended early`);
	};
	/** @param {NodeHost} host @param {Unit} process @param {readonly string[]} files */
	const awaitFiles = async (host, process, files) =>
		until("fixture markers", async () => {
			const alive = await running(host, process);
			if ((await Promise.all(files.map((file) => exists(host, file)))).every(Boolean)) return true;
			if (!alive) throw failure("fixture markers", `unit ${process.unit} ended before its markers`);
			return undefined;
		});
	/**
	 * The first JSON line the unit logged that `accept` takes. A fixture that reports an error ends the wait.
	 * @param {NodeHost} host @param {Unit} process @param {string} phase
	 * @param {(output: import("./resume-suite.mjs").DriverOutput) => boolean} accept
	 */
	const reported = (host, process, phase, accept) =>
		until(phase, async () => {
			const alive = await running(host, process);
			if (await exists(host, process.log)) {
				const content = await text(host, `cat ${shellQuote(process.log)}`, phase);
				for (const line of content.split("\n").filter((entry) => entry.startsWith("{"))) {
					const output = document(line, phase);
					if (output.error !== undefined) throw failure(phase, `fixture failed: ${JSON.stringify(output.error)}`);
					if (accept(output)) return output;
				}
			}
			if (!alive) throw failure(phase, `unit ${process.unit} ended before it reported`);
			return undefined;
		});
	/** The exit status the unit's shell recorded, and the fixture's last JSON line. @param {NodeHost} host @param {Unit} process @param {string} exitFile @param {string} phase @returns {Promise<DriverResult>} */
	const finished = async (host, process, exitFile, phase) => {
		const code = await until(phase, async () => {
			const alive = await running(host, process);
			if (await exists(host, exitFile)) return Number(await text(host, `cat ${shellQuote(exitFile)}`, phase));
			if (!alive) throw failure(phase, `unit ${process.unit} ended without an exit status`);
			return undefined;
		});
		return {
			code,
			signal: code === 137 ? "SIGKILL" : null,
			output: code === 137 ? {} : document(await text(host, `cat ${shellQuote(process.log)}`, phase), phase),
		};
	};
	/** @param {NodeHost} host @param {Unit} process */
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
			...(Array.isArray(output.mappings) ? { mappings: output.mappings } : {}),
			clean: await clean(host, restoreRoot, git),
		};
	};
	/**
	 * A `git` that runs `gitCommand`; with `kill`, it SIGKILLs the process that ran it right after its first
	 * `git worktree add`, leaving a run-owned marker beside itself.
	 * @param {string} path @param {string} gitCommand @param {boolean} killOnce
	 */
	const shimScript = (path, gitCommand, killOnce) =>
		`mkdir -p ${shellQuote(path)}; cat > ${shellQuote(`${path}/git`)} <<'SHIM'\n#!/bin/sh\n${gitCommand} "$@"\ns=$?\n${killOnce ? `case "$*" in *"worktree add"*) if [ ! -e ${shellQuote(`${path}/killed`)} ]; then : > ${shellQuote(`${path}/killed`)}; kill -9 "$PPID"; fi;; esac\n` : ""}exit "$s"\nSHIM\nchmod 755 ${shellQuote(`${path}/git`)}`;
	/**
	 * Runs `action` while `host` is cut off from the database gateway; `arm` runs first, before the rules go in.
	 * @param {NodeHost} host @param {string} kind @param {string} root @param {() => Promise<DriverResult>} action
	 * @param {() => Promise<void>} [arm]
	 */
	const partition = async (host, kind, root, action, arm) => {
		await arm?.();
		const tag = `adt-${ctx.runId}-resume-${kind}`;
		const rules = iptablesRules(tag, "full", { dbIp: ctx.primary.ip, port: ctx.gatewayPort });
		const tracked = { host, rules, active: true };
		partitions.push(tracked);
		let result;
		let counters;
		try {
			await host.run(rules.apply, { operation: `partition ${kind}` });
			result = await action();
			counters = parseCounters(await text(host, rules.counters, `partition ${kind} counters`));
		} catch (error) {
			try {
				await scope.undo(() => host.run(rules.clear, { operation: `clear ${kind} partition` }));
				tracked.active = false;
			} catch (cleanup) {
				attachCleanupFailure(error, cleanup);
			}
			throw error;
		}
		await scope.undo(() => host.run(rules.clear, { operation: `clear ${kind} partition` }));
		tracked.active = false;
		const remaining = await text(
			host,
			`sudo iptables -S | grep -c ${shellQuote(tag)} || true`,
			`verify ${kind} partition cleared`,
		);
		return {
			code: result.code,
			signal: result.signal,
			error: result.output.error,
			noWorktrees: await noWorktrees(host, root),
			dropped: counters.OUTPUT ?? 0,
			cleared: remaining === "0",
		};
	};
	/** @param {string} id */
	const runInputs = (id) => ({ runId: id, alpha, beta });
	const provisioning = () => ({
		PROVISION_ARCHIVE: `${work}/portable-git.tar.gz`,
		PROVISION_SHA256: gitArchiveSha,
		PROVISION_VERSION: gitVersion,
	});

	/** The held-child markers in the campaign directory of `host`: `held-<host>-<index>-<pid>` holding the child's cwd. @param {NodeHost} host */
	const heldMarkers = async (host) => {
		const listing = await text(
			host,
			`cd ${shellQuote(poolDir)}; for f in held-*; do [ -e "$f" ] || continue; printf '%s\\t' "$f"; cat "$f"; printf '\\n'; done`,
			"list held pooled children",
		);
		return listing
			.split("\n")
			.filter((line) => line.includes("\t"))
			.flatMap((line) => {
				const [name, json] = line.split("\t");
				const [, holder, , pid] = name.split("-");
				try {
					const held = /** @type {{ cwd?: string }} */ (JSON.parse(json));
					return [{ host: holder, cwd: String(held.cwd), pid: Number(pid) }];
				} catch {
					// A marker being written right now; the next poll reads it whole.
					return [];
				}
			});
	};
	/** @param {"A" | "B" | "C"} name */
	const readPoolStats = async (name) =>
		/** @type {{ git?: string, restore?: boolean, busy?: number, maxBusy?: number }} */ (
			await poolHosts[name].json(`cat ${shellQuote(`${poolDir}/host-stats-${name}.json`)}`, {
				operation: `read pool host ${name} stats`,
			})
		);
	/** @param {"A" | "B" | "C"} name */
	const startPoolHost = async (name) => {
		const host = poolHosts[name];
		const process = await start(
			host,
			`pool-host-${name}`,
			[
				NODE_BIN,
				RESUME_POOL,
				"host",
				"--ref-dir",
				REF_DIR,
				"--dir",
				poolDir,
				"--name",
				name,
				"--agent-dir",
				poolAgent(name),
				"--workers",
				"1",
				"--setup-log",
				`${poolDir}/setup-${name}.log`,
				...(name === "B" ? ["--setup-exit", "1"] : []),
				...poolJournal,
			],
			env(host, poolAgent(name), poolNodes[name], { ATOMIC_STORAGE: "" }),
			{ properties: ["KillMode=mixed"] },
		);
		poolUnits[name] = process;
		await awaitFiles(host, process, [`${poolDir}/host-ready-${name}`]);
		const stats = await readPoolStats(name);
		poolStats[name] = { git: stats.git, restore: stats.restore };
	};
	/** @param {"A" | "B" | "C"} name */
	const setupLog = async (name) => {
		const log = `${poolDir}/setup-${name}.log`;
		if (!(await exists(poolHosts[name], log))) return [];
		return (await text(poolHosts[name], `cat ${shellQuote(log)}`, `read pool host ${name} setup log`))
			.split("\n")
			.filter((line) => line !== "");
	};

	/** The released-session scenario (5): two checkouts on node A, and node B's wakes. */
	const releasedPaths = {
		away: `${work}/node-a/home/released-away`,
		samePath: `${work}/node-a/home/released-same-path`,
	};
	/** The released-subagent leg of scenario 5: the owner's directory exists on both nodes, the checkout only on node A. */
	const subagentPaths = {
		ownerCwd: `${work}/subagent-owner`,
		checkout: `${work}/node-a/home/released-subagent`,
	};
	/** @param {string} label @param {string} id @param {string} path */
	const startWake = async (label, id, path) => {
		const goFile = `${work}/node-b/${label}.go`;
		const exitFile = `${work}/node-b/${label}.exit`;
		const process = await start(
			b,
			label,
			bunCommand(releasedDriver, "wake", {
				cwd: `${work}/node-b/home`,
				sessionId: id,
				readPath: `${path}/notes/agent-wrote.txt`,
				goFile,
			}),
			env(b, wakeAgent, "node-b"),
			{ exitFile },
		);
		await reported(b, process, `${label} ready`, (output) => output.ready === true);
		return { label, process, goFile, exitFile };
	};
	/** @param {Awaited<ReturnType<typeof startWake>>} wake */
	const go = async (wake) => {
		await b.run(`: > ${shellQuote(wake.goFile)}`, { operation: `let ${wake.label} begin` });
		return finished(b, wake.process, wake.exitFile, wake.label);
	};
	/** @param {string} label @param {string} id @param {string} path */
	const wakeObservation = async (label, id, path) => {
		const result = await go(await startWake(label, id, path));
		if (result.code !== 0)
			throw failure(label, `fixture exited ${result.code}: ${JSON.stringify(result.output.error ?? null)}`);
		return {
			...(await sessionObservation(b, result.output, `${work}/unused`, "/usr/bin/git", wakeRoot)),
			code: result.code,
			recordedPath: path,
		};
	};

	return {
		undo: (action) => scope.undo(action),
		prepare: async () => {
			const version = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
			if (version !== BUN_VERSION) throw failure("stage Bun", `expected ${BUN_VERSION}, found ${version}`);
			const executable = realpathSync(execFileSync("which", ["bun"], { encoding: "utf8" }).trim());
			for (const host of [a, b, c]) {
				await host.run(
					`mkdir -p ${shellQuote(work)} ${shellQuote(poolDir)} ${["node-a", "node-b", "node-c"].flatMap((name) => [shellQuote(`${work}/${name}/home`), shellQuote(`${work}/${name}/pool-agent`)]).join(" ")}; printf '%s\\n' '[user]' ' name = Fixture' ' email = fixture@example.com' '[commit]' ' gpgSign = false' '[protocol "file"]' ' allow = always' > ${shellQuote(gitconfig)}`,
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
			const seeds = shellQuote(`${work}/seeds`);
			const script = `export GIT_CONFIG_GLOBAL=${shellQuote(gitconfig)} GIT_CONFIG_NOSYSTEM=1\nmkdir -p ${shellQuote(`${work}/remotes`)} ${seeds}\nfor name in session alpha beta stepped pool released; do\n  mkdir -p ${seeds}/$name\n  git -C ${seeds}/$name init -q -b main\n  printf '%s\\n' "$name" > ${seeds}/$name/README.md\n  if [ "$name" = session ] || [ "$name" = pool ]; then printf '{}\\n' > ${seeds}/$name/package-lock.json; fi\n  if [ "$name" = stepped ]; then printf 'zero\\n' > ${seeds}/$name/state.txt; fi\n  if [ "$name" = pool ] || [ "$name" = released ]; then mkdir -p ${seeds}/$name/lib; printf 'util\\n' > ${seeds}/$name/lib/util.txt; fi\n  git -C ${seeds}/$name add -A\n  git -C ${seeds}/$name commit -q -m initial\n  git clone -q --bare ${seeds}/$name ${shellQuote(`${work}/remotes`)}/$name.git\ndone\n${dirtyCheckout(`${work}/remotes/session.git`, sessionPath)}\ngit clone -q ${shellQuote(`${work}/remotes/stepped.git`)} ${shellQuote(stepPath)}\ntar -cf ${shellQuote(`${work}/remotes.tar`)} -C ${shellQuote(work)} remotes\nP=${shellQuote(`${work}/portable-git`)}; mkdir -p "$P/bin" "$P/libexec" "$P/share/git-core" "$P/etc" "$P/ssl"\ncp "$(command -v git)" "$P/bin/git"; cp -a "$(git --exec-path)" "$P/libexec/git-core"; cp -a /usr/share/git-core/templates "$P/share/git-core/templates"\n: > "$P/etc/gitconfig"; : > "$P/ssl/cacert.pem"\ntar czf ${shellQuote(`${work}/portable-git.tar.gz`)} -C "$P" .\nsha256sum ${shellQuote(`${work}/portable-git.tar.gz`)} | cut -d' ' -f1; git --version | awk '{print $3}'`;
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
				content: WRITTEN,
			};
			const process = await start(
				a,
				"session-source",
				bunCommand(sessionDriver, "record", args),
				env(a, `${work}/node-a/session-agent`, "node-a"),
			);
			const recorded = await reported(a, process, "session recorded", () => true);
			if (typeof recorded.sessionId !== "string" || recorded.snapshots !== 1)
				throw failure("record session", "session or snapshot missing");
			const source = await observeTree(a, sessionPath, "/usr/bin/git", `${work}/unused`);
			await kill(a, process);
			return { id: recorded.sessionId, source };
		},
		partitionSession: (id) =>
			partition(b, "session", sessionRoot, () => sessionResume(b, sessionAgent, "node-b", id)),
		killSessionRestore: async (id) => {
			const path = `${work}/node-b/shim`;
			await b.run(shimScript(path, "/usr/bin/git", true), { operation: "install restore-kill shim" });
			const killed = await sessionResume(b, sessionAgent, "node-b", id, { PATH: `${path}:${BASE_PATH}` });
			return { ...killed, marker: await exists(b, `${path}/killed`) };
		},
		resumeSession: async (id) => {
			const result = await sessionResume(b, sessionAgent, "node-b", id, {
				PATH: `${work}/node-b/shim:${BASE_PATH}`,
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
				provisioned: await exists(c, gitlessGit),
			};
		},
		partitionGitless: async (id) => ({
			...(await partition(c, "gitless", gitlessRoot, () =>
				sessionResume(c, gitlessAgent, "node-c", id, provisioning()),
			)),
			provisioned: await exists(c, gitlessGit),
		}),
		gitlessResume: async (id) => {
			const result = await sessionResume(c, gitlessAgent, "node-c", id, provisioning());
			if (result.code !== 0)
				throw failure(
					"gitless resume",
					`fixture exited ${result.code}: ${JSON.stringify(result.output.error ?? null)}`,
				);
			return {
				...(await sessionObservation(c, result.output, `${work}/node-c/setup-ran`, gitlessGit, gitlessRoot)),
				provisioned: await exists(c, gitlessGit),
			};
		},
		recordRun: async () => {
			const id = randomUUID();
			const hold = `${work}/node-a/holds`;
			await a.run(`mkdir -p ${shellQuote(hold)}`, { operation: "prepare held workflow" });
			const process = await start(
				a,
				"run-source",
				bunCommand(runDriver, "two-repos", runInputs(id)),
				env(a, `${work}/node-a/run-agent`, "node-a", { HOLD_DIR: hold }),
			);
			await awaitFiles(a, process, [`${hold}/alpha.holding`, `${hold}/beta.holding`]);
			const killed = await kill(a, process);
			runKilledAt = performance.now();
			return { id, killed: { ...killed, marker: true } };
		},
		waitForLease: async () => {
			if (ctx.signal?.aborted) throw ctx.signal.reason;
			const remainingMs = Math.max(0, RESUME_LEASE_WAIT_MS - (performance.now() - runKilledAt));
			await new Promise((resolve, reject) => {
				const signal = ctx.signal;
				const abort = () => {
					clearTimeout(timer);
					reject(signal?.reason);
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", abort);
					resolve(undefined);
				}, remainingMs);
				signal?.addEventListener("abort", abort, { once: true });
			});
		},
		partitionRun: (id) =>
			partition(b, "run", runRoot, () => once(b, runDriver, "two-repos", runInputs(id), env(b, runAgent, "node-b"))),
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
		startPool: async () => {
			await a.run(gitScript(dirtyCheckout(`${work}/remotes/pool.git`, poolRepo)), {
				operation: "create the pooled root's worktree",
			});
			poolSource = await observeTree(a, poolRepo, "/usr/bin/git", `${work}/unused`);
			// Node B's host and the git-less node's host serve first, so node B's host claims the only child.
			await startPoolHost("B");
			await startPoolHost("C");
			poolRootUnit = await start(
				a,
				"pool-root",
				[
					NODE_BIN,
					RESUME_POOL,
					"root",
					"--ref-dir",
					REF_DIR,
					"--dir",
					poolDir,
					"--root",
					poolRootId,
					"--worktree",
					poolRepo,
					"--agent-dir",
					`${work}/node-a/pool-root-agent`,
					"--children",
					"1",
					"--workers",
					"1",
					"--lease-ms",
					String(POOL_WORK_LEASE_MS),
					"--claim-window-ms",
					String(POOL_CLAIM_WINDOW_MS),
					...poolJournal,
				],
				env(a, `${work}/node-a/pool-root-agent`, "node-a", { ATOMIC_STORAGE: "" }),
				{ properties: ["KillMode=mixed"] },
			);
			const root = poolRootUnit;
			firstHeld = await until("pooled child held on node B", async () => {
				/** @type {[NodeHost, Unit | undefined][]} */
				const watched = [
					[a, root],
					[b, poolUnits.B],
					[c, poolUnits.C],
				];
				for (const [host, process] of watched)
					if (process !== undefined) await ensureRunning(host, process, "pool start");
				const elsewhere = [...(await heldMarkers(a)), ...(await heldMarkers(c))];
				if (elsewhere.length > 0)
					throw failure("pool start", `the child was first held by ${elsewhere[0]?.host}, not node B's host`);
				return (await heldMarkers(b)).find((marker) => marker.host === "B");
			});
			// Node A's capable host joins while node B's holds the child, idle until the child is reclaimed.
			await startPoolHost("A");
		},
		killPoolHost: async () => {
			const unit = poolUnits.B;
			const held = firstHeld;
			if (unit === undefined || held === undefined) throw failure("pool kill", "node B's host holds no child");
			await b.run(`sudo systemctl kill --signal=SIGKILL --kill-whom=all ${shellQuote(unit.unit)}`, {
				operation: "kill node B's worker host",
			});
			const state = await until("pool host killed", async () => {
				const current = await unitState(b, unit.unit);
				return current.active === "failed" || current.active === "inactive" ? current : undefined;
			});
			const gone =
				(
					await b.run(`! kill -0 ${held.pid} 2>/dev/null`, {
						operation: "check the held child's worker is gone",
						allowExitCodes: [1],
					})
				).exitCode === 0;
			return { code: null, signal: state.result === "signal" ? "SIGKILL" : null, marker: gone };
		},
		finishPool: async () => {
			const root = poolRootUnit;
			if (root === undefined || firstHeld === undefined) throw failure("pool reclaim", "the campaign never started");
			const reclaimed = await until("pooled child reclaimed", async () => {
				await ensureRunning(a, root, "pool reclaim");
				const onA = (await heldMarkers(a))[0];
				const onC = (await heldMarkers(c))[0];
				return onA ?? onC;
			});
			const tree =
				reclaimed.host === "C"
					? {}
					: await observeTree(a, reclaimed.cwd, "/usr/bin/git", `${poolDir}/setup-${reclaimed.host}.log`);
			for (const host of [a, b, c])
				await host.run(`: > ${shellQuote(`${poolDir}/release`)}`, { operation: "release the pooled child" });
			await until("pooled root ended", async () => {
				const alive = await running(a, root);
				if (await exists(a, `${poolDir}/outcome-start.json`)) return true;
				if (!alive) throw failure("pool reclaim", "the root ended without an outcome");
				return undefined;
			});
			const outcome = /** @type {NonNullable<import("./resume-invariants.mjs").PoolObservation["outcome"]>} */ (
				await a.json(`cat ${shellQuote(`${poolDir}/outcome-start.json`)}`, { operation: "read pool outcome" })
			);
			const gitless = await readPoolStats("C");
			const heldOnGitless = (await heldMarkers(c)).length;
			const journal = /** @type {{ work: { state: string, generation: number, worker: string }[] }} */ (
				await a.json(
					`NODE_EXTRA_CA_CERTS=${shellQuote(`${SECRETS}/ca.pem`)} ${[NODE_BIN, RESUME_POOL, "work", "--ref-dir", REF_DIR, "--root", poolRootId, ...poolJournal].map(shellQuote).join(" ")}`,
					{ operation: "read the campaign's work rows" },
				)
			);
			const setup = { A: await setupLog("A"), B: await setupLog("B"), C: await setupLog("C") };
			for (const name of /** @type {const} */ (["A", "C"])) {
				const process = poolUnits[name];
				if (process !== undefined)
					await poolHosts[name].run(`sudo systemctl stop ${shellQuote(process.unit)}`, {
						operation: `stop pool host ${name}`,
					});
			}
			return {
				source: poolSource,
				hosts: {
					A: poolStats.A,
					B: poolStats.B,
					C: { ...poolStats.C, maxBusy: gitless.maxBusy },
				},
				restoreRoots,
				first: { host: firstHeld.host, cwd: firstHeld.cwd },
				reclaimed: { ...tree, host: reclaimed.host, cwd: reclaimed.cwd },
				outcome,
				setup,
				heldOnGitless,
				work: journal.work,
			};
		},
		releaseSessions: async () => {
			await a.run(
				gitScript(
					Object.values(releasedPaths)
						.map((path) => dirtyCheckout(`${work}/remotes/released.git`, path))
						.join("\n"),
				),
				{ operation: "create the released sessions' checkouts" },
			);
			/** @param {"away" | "samePath"} key */
			const release = async (key) => {
				const path = releasedPaths[key];
				const process = await start(
					a,
					`release-${key}`,
					bunCommand(releasedDriver, "release", {
						cwd: path,
						file: `${path}/notes/agent-wrote.txt`,
						content: WRITTEN,
					}),
					env(a, `${work}/node-a/released-agent`, "node-a"),
				);
				const recorded = await reported(a, process, "session released", (output) => "sessionId" in output);
				const recordedPath = recorded.releasedCwd;
				if (typeof recorded.sessionId !== "string" || recorded.snapshots !== 1 || typeof recordedPath !== "string")
					throw failure("release session", `unexpected release ${JSON.stringify(recorded)}`);
				await kill(a, process);
				return {
					id: recorded.sessionId,
					path: recordedPath,
					source: await observeTree(a, path, "/usr/bin/git", `${work}/unused`),
				};
			};
			return { away: await release("away"), samePath: await release("samePath") };
		},
		partitionWake: async (id, path) => {
			/** @type {{ wake?: Awaited<ReturnType<typeof startWake>> }} */
			const armed = {};
			return partition(
				b,
				"wake",
				wakeRoot,
				() => {
					if (armed.wake === undefined) throw failure("partition wake", "the wake never started");
					return go(armed.wake);
				},
				async () => {
					armed.wake = await startWake("wake-partitioned", id, path);
				},
			);
		},
		wake: (id, path) => wakeObservation("wake-away", id, path),
		releaseSubagent: async () => {
			const path = subagentPaths.checkout;
			await a.run(
				gitScript(
					`mkdir -p ${shellQuote(subagentPaths.ownerCwd)}\n${dirtyCheckout(`${work}/remotes/released.git`, path)}`,
				),
				{ operation: "create the released subagent's checkout" },
			);
			const process = await start(
				a,
				"release-subagent",
				bunCommand(subagentDriver, "release", {
					ownerCwd: subagentPaths.ownerCwd,
					cwd: path,
					file: `${path}/notes/agent-wrote.txt`,
					content: SUBAGENT_WRITTEN,
				}),
				env(a, `${work}/node-a/subagent-agent`, "node-a"),
			);
			const recorded = await reported(a, process, "subagent released", (output) => "ownerSessionId" in output);
			if (
				typeof recorded.ownerSessionId !== "string" ||
				typeof recorded.childId !== "string" ||
				recorded.childSessionRecordedInStore !== true ||
				recorded.childSnapshots !== 1
			)
				throw failure("release subagent", `unexpected release ${JSON.stringify(recorded)}`);
			await kill(a, process);
			return {
				ownerSessionId: recorded.ownerSessionId,
				childId: recorded.childId,
				path,
				source: await observeTree(a, path, "/usr/bin/git", `${work}/unused`),
			};
		},
		wakeSubagent: async (released) => {
			const label = "wake-subagent";
			const goFile = `${work}/node-b/${label}.go`;
			const exitFile = `${work}/node-b/${label}.exit`;
			await b.run(`mkdir -p ${shellQuote(subagentPaths.ownerCwd)}`, { operation: "create the owner's directory" });
			const process = await start(
				b,
				label,
				bunCommand(subagentDriver, "wake", {
					ownerCwd: subagentPaths.ownerCwd,
					workedIn: released.path,
					ownerSessionId: released.ownerSessionId,
					childId: released.childId,
					readPath: `${released.path}/notes/agent-wrote.txt`,
					goFile,
				}),
				env(b, subagentWakeAgent, "node-b"),
				{ exitFile },
			);
			await reported(b, process, `${label} ready`, (output) => output.ready === true);
			await b.run(`: > ${shellQuote(goFile)}`, { operation: `let ${label} begin` });
			const result = await finished(b, process, exitFile, label);
			if (result.code !== 0)
				throw failure(label, `fixture exited ${result.code}: ${JSON.stringify(result.output.error ?? null)}`);
			return {
				...(await sessionObservation(b, result.output, `${work}/unused`, "/usr/bin/git", subagentWakeRoot)),
				code: result.code,
				recordedPath: released.path,
				...(typeof result.output.outcome === "string" ? { outcome: result.output.outcome } : {}),
			};
		},
		wakeAtSamePath: async (id, path) => {
			// Another checkout of the same repository, at exactly the path the session recorded on node A.
			await b.run(gitScript(`git clone -q ${shellQuote(`${work}/remotes/released.git`)} ${shellQuote(path)}`), {
				operation: "check out the repository at the recorded path",
			});
			const before = await observeTree(b, path, "/usr/bin/git", `${work}/unused`);
			const woken = await wakeObservation("wake-same-path", id, path);
			const after = await observeTree(b, path, "/usr/bin/git", `${work}/unused`);
			return {
				...woken,
				decoy: {
					before: { digest: before.digest, head: before.head },
					after: { digest: after.digest, head: after.head },
				},
			};
		},
		recordFork: async () => {
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
			return id;
		},
		killFork: async (id) => {
			if (!(await exists(c, gitlessGit))) throw failure("fork on node C", "no Git was provisioned there");
			const shim = `${work}/node-c/shim`;
			await c.run(shimScript(shim, `${gitEnvironment(gitlessGit)} ${shellQuote(gitlessGit)}`, true), {
				operation: "install fork-kill shim",
			});
			const killed = await once(
				c,
				runDriver,
				"fork",
				{ sourceRunId: id, fromStage: "two" },
				env(c, forkAgent, "node-c", { PATH: `${shim}:${BASE_PATH}` }),
			);
			return {
				code: killed.code,
				signal: killed.signal,
				marker: await exists(c, `${shim}/killed`),
				clean: await clean(c, forkRoot, gitlessGit),
			};
		},
		fork: async (id) => {
			if (!(await exists(c, gitlessGit))) throw failure("fork on node C", "no Git was provisioned there");
			// The Git provisioned on node C, as the only `git` on its PATH.
			const bin = `${work}/node-c/git-bin`;
			await c.run(shimScript(bin, `${gitEnvironment(gitlessGit)} ${shellQuote(gitlessGit)}`, false), {
				operation: "expose provisioned Git",
			});
			const fork = await once(
				c,
				runDriver,
				"fork",
				{ sourceRunId: id, fromStage: "two" },
				env(c, forkAgent, "node-c", { PATH: `${bin}:${BASE_PATH}` }),
			);
			if (fork.code !== 0) throw failure("fork workflow", JSON.stringify(fork.output.error ?? null));
			const one = JSON.parse(fork.output.result?.one ?? "{}");
			const two = JSON.parse(fork.output.result?.two ?? "{}");
			const stateAfter =
				typeof two.cwd === "string"
					? `${await text(c, `cat ${shellQuote(`${two.cwd}/state.txt`)}`, "read forked state")}\n`
					: undefined;
			return {
				status: fork.output.status,
				beforeOne: one.before,
				beforeTwo: two.before,
				cwd: two.cwd,
				restoreRoot: forkRoot,
				stateAfter,
				gitless: c.roles.includes("git-less"),
				clean: await clean(c, forkRoot, gitlessGit),
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
							await item.host.run(item.rules.clear, { operation: "clear resume partition" });
						} catch (error) {
							failures.push(error);
						}
					}
					for (const unit of units) {
						const name = shellQuote(unit.name);
						try {
							// A unit that exited cleanly is already unloaded; only a loaded one is stopped.
							await unit.host.run(
								`if [ "$(systemctl show -p LoadState --value ${name})" = loaded ]; then sudo systemctl stop ${name}; fi`,
								{ operation: `stop ${unit.name}` },
							);
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
