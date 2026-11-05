#!/usr/bin/env node
// @ts-check
/**
 * One command for a distributed chaos run on Azure:
 *
 *   node test/distributed/run.mjs --ref <sha|branch> --suite <name|all> --nodes 3 --regions eastus2,westus3 --chaos <profile> [--keep]
 *
 * It validates every input before any side effect, provisions a private topology tagged
 * `atomic-distributed-test=<run-id>`, deploys one build of the ref to every node, passes the security gate, runs the
 * suites, and tears everything down in `finally`, proving with az queries that nothing tagged is left. See
 * docs/distributed-tests.md.
 */
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	artifactArchivePath,
	artifactBuildScript,
	artifactCleanupScript,
	artifactRemoteDir,
} from "./harness/artifact.mjs";
import { AzureRun, checkPrerequisites, requiredTools } from "./harness/azure.mjs";
import { cacheFile } from "./harness/cache.mjs";
import { profileCoverage } from "./harness/chaos.mjs";
import { azJson, runCommand, settleAll } from "./harness/commands.mjs";
import {
	buildPlan,
	CONTROL_ENV,
	encryptionAtHostSkip,
	newRunId,
	parseControlEnv,
	parseRunArgs,
	parseTopology,
	readJsonInput,
	remoteRefPatterns,
	replayValues,
	resolveRunOptions,
	SUITES,
	selectRemoteRef,
} from "./harness/config.mjs";
import {
	attachCleanupFailure,
	attachConcurrentFailures,
	DistributedConfigError,
	DistributedProvisionError,
	DistributedTimeoutError,
	isCancellation,
	isDistributedTestError,
	serializeDistributedError,
} from "./harness/errors.mjs";
import { invariantFailures } from "./harness/invariants.mjs";
import { runLifecycle } from "./harness/lifecycle.mjs";
import { Manifest } from "./harness/manifest.mjs";
import { evaluateEffectiveRules } from "./harness/network.mjs";
import { createRandom, PRNG_NAME } from "./harness/prng.mjs";
import {
	createNamespaces,
	Host,
	listeningSockets,
	removeGit,
	SECRETS,
	setupSqld,
	sha256File,
	stageArtifact,
	stageBase,
	stageSecret,
} from "./harness/remote.mjs";
import { overallStatus, suiteStatus, writeReport } from "./harness/report.mjs";
import { createRunSecrets, loadRunSecrets } from "./harness/secrets.mjs";
import { bindViolations, gateVerdict, publicAddressChecks } from "./harness/security.mjs";
import { loadState, reuseCommand } from "./harness/state.mjs";
import { featureSkip, parseCapabilities, runSmoke, selectedSuites } from "./harness/suites.mjs";
import { teardownRun } from "./harness/teardown.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const STATE_ROOT = join(
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
	"atomic-distributed-test",
	"runs",
);
const CACHE_ROOT = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "atomic-distributed-test");
const BUN_VERSION = "1.4.4";

const USAGE = `Usage: node test/distributed/run.mjs --ref <sha|branch> [--suite <name|all>] [--nodes 3] [--regions eastus2,westus3]
       [--chaos <profile|smoke|none>] [--keep] [--seed <n>] [--ttl-hours <h>] [--db-storage premium-ssd|local-nvme]
       [--db-region <region>] [--topology <file>] [--out <dir>] [--builder <crabbox-id>] [--artifact <file.tar.zst>]
       [--replay <report.json>] [--reuse <run-id>] [--plan-only]
Suites: all, ${Object.keys(SUITES).join(", ")}`;

/**
 * @param {string} message
 * @param {unknown} error
 */
function printError(message, error) {
	const hint = isDistributedTestError(error) ? error.hint : undefined;
	const text = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}: ${text}\n${hint === undefined || text.includes(hint) ? "" : `${hint}\n`}`);
}

/**
 * @param {import("./harness/commands.mjs").CommandContext} context
 * @param {string} repository
 * @param {string} ref
 * @param {AbortSignal} signal
 */
async function resolveRef(context, repository, ref, signal) {
	if (/^[0-9a-f]{40}$/.test(ref)) return { sha: ref, refname: null };
	const result = await runCommand(context, "git", ["ls-remote", repository, ...remoteRefPatterns(ref)], {
		operation: `resolve ${ref}`,
		timeoutMs: 60_000,
		signal,
	});
	return selectRemoteRef(result.stdout, ref);
}

/**
 * The pinned Node runtime tarball, downloaded once and checked against the release's SHASUMS256.txt.
 * @param {import("./harness/commands.mjs").CommandContext} context
 * @param {string} version
 * @param {AbortSignal} signal
 */
export async function nodeTarball(context, version, signal) {
	const dir = join(CACHE_ROOT, "node");
	mkdirSync(dir, { recursive: true });
	const name = `node-${version}-linux-x64.tar.xz`;
	const path = join(dir, name);
	await cacheFile(path, async (temporary) => {
		await runCommand(context, "curl", ["-fsSL", "-o", temporary, `https://nodejs.org/dist/${version}/${name}`], {
			operation: `download ${name}`,
			timeoutMs: 600_000,
			signal,
		});
		await verifyNodeTarball(temporary);
	});
	return { path, digest: await verifyNodeTarball(path) };

	/** @param {string} candidate */
	async function verifyNodeTarball(candidate) {
		const sums = await runCommand(context, "curl", ["-fsSL", `https://nodejs.org/dist/${version}/SHASUMS256.txt`], {
			operation: "download SHASUMS256.txt",
			timeoutMs: 60_000,
			signal,
		});
		const expected = sums.stdout
			.split("\n")
			.find((line) => line.endsWith(`  ${name}`))
			?.split(" ")[0];
		const actual = await sha256File(candidate);
		if (expected !== actual)
			throw new DistributedProvisionError({
				step: "verify Node runtime",
				resource: name,
				detail: "SHA-256 does not match SHASUMS256.txt",
			});
		return actual;
	}
}

/**
 * The pinned sqld binary, extracted once from the digest-pinned image.
 * @param {import("./harness/commands.mjs").CommandContext} context
 * @param {{ image: string, version: string }} database
 * @param {AbortSignal} signal
 */
export async function sqldBinary(context, database, signal) {
	const dir = join(CACHE_ROOT, "sqld", database.version);
	const path = join(dir, "sqld");
	await cacheFile(path, async (temporary) => {
		await runCommand(context, "docker", ["pull", database.image], {
			operation: "pull sqld image",
			timeoutMs: 900_000,
			signal,
		});
		const created = await runCommand(context, "docker", ["create", database.image], {
			operation: "create sqld container",
			timeoutMs: 60_000,
			signal,
		});
		const id = created.stdout.trim();
		/** @type {unknown} */
		let copyFailure;
		try {
			await runCommand(context, "docker", ["cp", `${id}:/bin/sqld`, temporary], {
				operation: "copy sqld binary",
				timeoutMs: 120_000,
				signal,
			});
		} catch (error) {
			copyFailure = error;
		}
		try {
			await runCommand(context, "docker", ["rm", id], { operation: "remove sqld container", timeoutMs: 60_000 });
		} catch (error) {
			if (copyFailure === undefined) throw error;
			attachCleanupFailure(copyFailure, error);
		}
		if (copyFailure !== undefined) throw copyFailure;
	});
	const version = await runCommand(context, path, ["--version"], {
		operation: "sqld version",
		timeoutMs: 30_000,
		signal,
	});
	if (!version.stdout.includes(database.version.replace(/^v/, ""))) {
		throw new DistributedProvisionError({
			step: "verify sqld",
			resource: path,
			detail: `expected ${database.version}`,
		});
	}
	return { path, digest: await sha256File(path), version: version.stdout.trim() };
}

/**
 * Builds the ref once on a Crabbox runner (or reuses the cached build of the same SHA) and copies the tarball back.
 * @param {import("./harness/commands.mjs").CommandContext} context
 * @param {{ sha: string, repository: string, nodeVersion: string, builder?: string, manifest: Manifest, signal: AbortSignal }} input
 */
export async function buildArtifact(context, { sha, repository, nodeVersion, builder, manifest, signal }) {
	const dir = join(CACHE_ROOT, "artifacts");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `atomic-${sha}.tar.zst`);
	if (existsSync(path)) return { path, digest: await sha256File(path), cached: true };
	let slug = builder;
	let warmed = false;
	if (slug === undefined) {
		const warm = await runCommand(context, "crabbox", ["warmup"], {
			operation: "crabbox warmup",
			timeoutMs: 1_200_000,
			signal,
			cwd: REPO_ROOT,
		});
		slug = /slug=(\S+)/.exec(`${warm.stdout}\n${warm.stderr}`)?.[1];
		if (slug === undefined)
			throw new DistributedProvisionError({
				step: "crabbox warmup",
				resource: "builder",
				detail: "no lease slug in output",
			});
		warmed = true;
		manifest.setBuilder(slug);
	}
	/** @type {unknown} */
	let failure;
	/** @type {{ path: string, digest: string, cached: boolean } | undefined} */
	let built;
	const remoteDir = artifactRemoteDir();
	try {
		const script = artifactBuildScript({ sha, repository, nodeVersion, bunVersion: BUN_VERSION, remoteDir });
		const output = await runCommand(context, "crabbox", ["run", "--id", slug, "--", "bash", "-lc", script], {
			operation: "build ref artifact",
			timeoutMs: 3_600_000,
			signal,
			cwd: REPO_ROOT,
		});
		const remoteDigest = output.stdout
			.trim()
			.split("\n")
			.filter((line) => /^[0-9a-f]{64}$/.test(line))
			.pop();
		const cached = await cacheFile(path, async (temporary) => {
			await runCommand(
				context,
				"crabbox",
				["cp", "--id", slug, `SANDBOX:${artifactArchivePath(remoteDir)}`, temporary],
				{ operation: "copy artifact", timeoutMs: 1_800_000, signal, cwd: REPO_ROOT },
			);
			if ((await sha256File(temporary)) !== remoteDigest)
				throw new DistributedProvisionError({
					step: "copy artifact",
					resource: path,
					detail: "digest differs from the builder's",
				});
		});
		built = { path, digest: await sha256File(path), cached };
	} catch (error) {
		failure = error;
	}
	if (!warmed) {
		try {
			await runCommand(
				context,
				"crabbox",
				["run", "--id", slug, "--", "bash", "-lc", artifactCleanupScript(remoteDir)],
				{ operation: "remove artifact build directory", timeoutMs: 600_000, cwd: REPO_ROOT },
			);
		} catch (cleanupFailure) {
			if (failure === undefined) failure = cleanupFailure;
			else attachCleanupFailure(failure, cleanupFailure);
		}
	} else {
		try {
			await stopBuilder(context, slug);
			manifest.setBuilder(undefined);
		} catch (stopFailure) {
			if (failure === undefined) failure = stopFailure;
			else attachCleanupFailure(failure, stopFailure);
		}
	}
	if (failure !== undefined || built === undefined) throw failure;
	return built;
}

/**
 * @param {import("./harness/commands.mjs").CommandContext} context
 * @param {string} slug
 */
async function stopBuilder(context, slug) {
	await runCommand(context, "crabbox", ["stop", slug], {
		operation: "crabbox stop",
		timeoutMs: 600_000,
		cwd: REPO_ROOT,
	});
}

/**
 * The mandatory pre-test gate. Every check is pushed onto `checks` as it is made, so the report shows them even when
 * the gate fails; any failure throws `DistributedSecurityError` and no scenario starts.
 * @param {{ azure: AzureRun, nodes: Host[], primary: Host, replica: Host, dbHosts: Host[], allowedSources: string[], nics: { vm: string, nic: string }[],
 *   gatewayPort: number, replicationPort: number, namespace: string, nvme: boolean }} input
 * @param {import("./harness/security.mjs").SecurityCheck[]} checks
 */
async function securityGate(
	{ azure, nodes, primary, replica, dbHosts, allowedSources, nics, gatewayPort, replicationPort, namespace, nvme },
	checks,
) {
	checks.push(
		...publicAddressChecks(
			await azure.publicAddresses(),
			azure.plan.vms.map((vm) => vm.name),
		),
	);
	const publicIps = await azure.publicIpResources();
	checks.push({
		name: "no-public-ip-resources",
		subject: azure.plan.resourceGroup,
		passed: publicIps.length === 0,
		observed: publicIps.length,
	});
	const balancers = await azure.loadBalancers();
	checks.push({
		name: "no-load-balancers",
		subject: azure.plan.resourceGroup,
		passed: balancers.length === 0,
		observed: balancers.length,
	});
	for (const { nic } of nics) {
		const violations = evaluateEffectiveRules(nic, await azure.effectiveRules(nic), allowedSources);
		checks.push({
			name: "effective-nsg-inbound",
			subject: nic,
			passed: violations.length === 0,
			observed:
				violations.length === 0
					? "no inbound allow from Internet, * or unlisted sources; implicit allows overridden"
					: violations,
		});
	}
	for (const host of dbHosts) {
		const sockets = await listeningSockets(host);
		const bad = bindViolations(sockets, {
			privateIp: host.ip,
			gatewayPort,
			replicationPort,
			loopbackPorts: [8080, 9090],
		});
		checks.push({
			name: "sqld-private-bind",
			subject: host.name,
			passed: bad.length === 0,
			observed: bad.length === 0 ? sockets : { sockets, offending: bad },
		});
	}
	const probeTargets = [primary, replica];
	for (const target of probeTargets) {
		const from = nodes.find((node) => Reflect.get(node, "region") !== Reflect.get(target, "region")) ?? nodes[0];
		const result = await from.agent("security", [
			"--url",
			`https://${target.ip}:${gatewayPort}`,
			"--namespace",
			namespace,
			"--token-file",
			`${SECRETS}/token`,
			"--foreign-token-file",
			`${SECRETS}/foreign-token`,
			"--ca",
			`${SECRETS}/ca.pem`,
			"--decoy-ca",
			`${SECRETS}/decoy-ca.pem`,
			"--backend-port",
			"8080",
		]);
		for (const check of result.checks)
			checks.push({
				name: check.name,
				subject: `${from.name} → ${target.name}`,
				passed: check.passed,
				observed: check.observed,
			});
	}
	if (nvme) {
		for (const host of dbHosts) {
			const facts = await azure.vmFacts(host.name);
			checks.push({
				name: "encryption-at-host",
				subject: host.name,
				passed: facts.encryptionAtHost === true,
				observed: facts.encryptionAtHost,
			});
		}
	}
	return gateVerdict(checks);
}

/** @typedef {import("./harness/state.mjs").RunState} RunState */

/**
 * @param {string} outDir
 * @param {RunState} state
 */
function saveState(outDir, state) {
	writeFileSync(join(outDir, "state.json"), `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
}

/** @param {unknown} left @param {unknown} right */
function sameAzureId(left, right) {
	return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

/**
 * Confirms with read-only queries that the current az account and control network are the ones a kept run was
 * created in, so a reused run never checks, changes or tears down resources in another context.
 * @param {{ az: (args: readonly string[], operation: string) => Promise<unknown>,
 *   saved: { subscription?: unknown, controlVnetId?: unknown }, control: { resourceGroup: string, vnet: string } }} input
 */
export async function verifyReuseContext({ az, saved, control }) {
	const subscription = await az(["account", "show", "--query", "id"], "reuse: current subscription");
	if (!sameAzureId(subscription, saved.subscription))
		throw new DistributedConfigError({
			source: "cli",
			field: "--reuse",
			reason: "invalid-value",
			expected: `a run kept in the current Azure subscription; the run was created in ${String(saved.subscription)} (az account set --subscription ${String(saved.subscription)})`,
			actual: String(subscription),
		});
	const controlVnetId = await az(
		["network", "vnet", "show", "--resource-group", control.resourceGroup, "--name", control.vnet, "--query", "id"],
		"reuse: current control VNet",
	);
	if (!sameAzureId(controlVnetId, saved.controlVnetId))
		throw new DistributedConfigError({
			source: "env",
			field: `${CONTROL_ENV.resourceGroup}/${CONTROL_ENV.vnet}`,
			reason: "invalid-value",
			expected: `the control VNet the run was peered to, ${String(saved.controlVnetId)}`,
			actual: String(controlVnetId),
		});
}

async function main() {
	const started = performance.now();
	/** @type {Record<string, number>} */
	const durations = {};
	/** @template T @param {string} phase @param {() => Promise<T>} action @returns {Promise<T>} */
	const timed = async (phase, action) => {
		const at = performance.now();
		try {
			return await action();
		} finally {
			durations[phase] = Math.round(performance.now() - at);
		}
	};
	/** @type {import("./harness/config.mjs").RunArgs} */
	let args;
	/** @type {import("./harness/config.mjs").Topology} */
	let topology;
	/** @type {import("./harness/config.mjs").RunOptions} */
	let options;
	/** @type {import("./harness/config.mjs").RunPlan} */
	let plan;
	/** @type {RunState | undefined} */
	let reused;
	try {
		args = parseRunArgs(process.argv.slice(2));
		if (args.help) {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		}
		const read = (/** @type {string} */ path) => readFileSync(path, "utf8");
		topology = parseTopology(
			readJsonInput(read, {
				source: "cli",
				field: "--topology",
				path: args.topology ?? join(HERE, "topology.json"),
				expected: "a readable JSON topology file",
			}),
		);
		reused = args.reuse === undefined ? undefined : loadState(args.reuse, STATE_ROOT, args.out);
		const replay =
			reused !== undefined
				? {
						ref: reused.sha,
						nodes: String(reused.options.nodes),
						regions: reused.options.regions.join(","),
						dbStorage: reused.options.dbStorage,
						dbRegion: reused.options.dbRegion,
						suite: reused.options.suite,
						chaos: reused.options.chaosSelection,
					}
				: args.replay === undefined
					? {}
					: replayValues(
							readJsonInput(read, {
								source: "replay",
								field: "--replay",
								path: args.replay,
								expected: "a report.json written by an earlier run",
							}),
						);
		options = resolveRunOptions(args, topology, { randomSeed: randomInt(2 ** 32), replay });
		const now = new Date();
		plan = reused?.plan ?? buildPlan(options, topology, { runId: newRunId(now, randomInt(65536)), now });
	} catch (error) {
		printError("Configuration rejected", error);
		return 2;
	}
	if (args.planOnly) {
		process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
		return 0;
	}
	/** @type {import("./harness/config.mjs").ControlNetwork} */
	let control;
	try {
		control = parseControlEnv(process.env);
	} catch (error) {
		printError("Configuration rejected", error);
		return 2;
	}
	const outDir = args.out ?? join(STATE_ROOT, plan.runId);
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	const attempt = reused === undefined ? "" : `-reuse-${Date.now()}`;
	/** @type {import("./harness/commands.mjs").CommandContext} */
	const context = { log: join(outDir, `commands${attempt}.log`), secrets: new Set() };
	const controller = new AbortController();
	for (const signalName of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
		process.once(signalName, () => controller.abort(new DOMException(`cancelled by ${signalName}`, "AbortError")));
	}
	const signal = controller.signal;
	const log = (/** @type {string} */ line) =>
		process.stdout.write(`[${((performance.now() - started) / 1000).toFixed(0).padStart(5)}s] ${line}\n`);
	if (reused !== undefined) {
		try {
			await verifyReuseContext({
				az: (azArgs, operation) => azJson(context, azArgs, { operation, timeoutMs: 120_000, signal }),
				saved: reused,
				control,
			});
		} catch (error) {
			if (isCancellation(error, signal)) return 130;
			printError("Reuse rejected", error);
			return error instanceof DistributedConfigError ? 2 : 1;
		}
	}
	/** @type {import("./harness/report.mjs").Report} */
	const report = {
		schemaVersion: 1,
		runId: plan.runId,
		startedAt: new Date().toISOString(),
		command: ["node", "test/distributed/run.mjs", ...process.argv.slice(2)].join(" "),
		replay: {
			ref: options.ref,
			suite: options.suite,
			chaos: options.chaosSelection,
			nodes: options.nodes,
			regions: options.regions,
			seed: options.seed,
			prng: PRNG_NAME,
			dbStorage: options.dbStorage,
			dbRegion: options.dbRegion,
		},
		topology: {
			resourceGroup: plan.resourceGroup,
			expiresAt: plan.expiresAt,
			vms: plan.vms.map((vm) => ({ ...vm })),
		},
		suites: [],
		coverage: [],
		durations,
		environment: {},
	};
	log(`run ${plan.runId}${reused === undefined ? "" : " (reused)"}: evidence in ${outDir}`);
	/** @type {Manifest | undefined} */
	let manifest = reused === undefined ? undefined : Manifest.load(outDir);
	/** @type {RunState | undefined} */
	let state = reused;
	/** @type {AzureRun | undefined} */
	let azure;
	/** @type {{ subscription: string, controlVnetId: string, controlPrefixes: string[] } | undefined} */
	let prerequisites;
	/** @type {import("./harness/secrets.mjs").RunSecrets | undefined} */
	let secrets;
	/** @type {ReturnType<typeof hostsOf> | undefined} */
	let hosts;
	/** @type {import("./harness/suites.mjs").Capabilities | undefined} */
	let capabilities;
	const keyPath = join(outDir, "ssh", "id_ed25519");
	const hostsOf = (/** @type {import("./harness/azure.mjs").PlacedVm[]} */ placed) => {
		const hostOf = (/** @type {import("./harness/azure.mjs").PlacedVm} */ vm) =>
			Object.assign(
				new Host({
					context,
					name: vm.name,
					ip: vm.privateIp,
					user: topology.adminUser,
					key: keyPath,
					knownHosts: join(outDir, "ssh", "known_hosts"),
					signal,
				}),
				{ roles: vm.roles, vmName: vm.name, region: vm.region },
			);
		return {
			nodes: placed.filter((vm) => vm.kind === "node").map(hostOf),
			primary: hostOf(
				/** @type {import("./harness/azure.mjs").PlacedVm} */ (placed.find((vm) => vm.dbRole === "primary")),
			),
			replica: hostOf(
				/** @type {import("./harness/azure.mjs").PlacedVm} */ (placed.find((vm) => vm.dbRole === "replica")),
			),
		};
	};
	const current = () => /** @type {RunState} */ (state);

	const outcome = await runLifecycle({
		keep: options.keep,
		signal,
		provisioned: () => manifest !== undefined && manifest.data.entries.length > 0,
		steps: [
			{
				name: "prerequisites",
				run: async () => {
					prerequisites = await timed("prerequisites", () =>
						checkPrerequisites(context, {
							control,
							tools: requiredTools({
								reuse: reused !== undefined,
								builder: reused === undefined && args.artifact === undefined,
								sqldCached: existsSync(join(CACHE_ROOT, "sqld", topology.database.version, "sqld")),
								ref: options.ref,
							}),
							path: process.env.PATH ?? "",
							signal,
						}),
					);
					if (reused === undefined && options.dbStorage === "local-nvme") {
						const feature = await azJson(
							context,
							[
								"feature",
								"show",
								"--namespace",
								"Microsoft.Compute",
								"--name",
								"EncryptionAtHost",
								"--query",
								"properties.state",
							],
							{ operation: "encryption-at-host feature", timeoutMs: 120_000, signal },
						);
						const skip = encryptionAtHostSkip(options.dbStorage, feature);
						if (skip !== undefined) {
							report.nvmeSkip = skip;
							options.dbStorage = "premium-ssd";
							plan = buildPlan(options, topology, {
								runId: plan.runId,
								now: new Date(Date.parse(plan.expiresAt) - options.ttlHours * 3_600_000),
							});
							report.topology.vms = plan.vms.map((vm) => ({ ...vm }));
							report.replay.dbStorage = options.dbStorage;
						}
					}
				},
			},
			{
				name: "provision",
				run: async () => {
					const checked =
						/** @type {{ subscription: string, controlVnetId: string, controlPrefixes: string[] }} */ (
							prerequisites
						);
					if (reused !== undefined) {
						azure = new AzureRun({
							context,
							plan,
							topology,
							manifest: /** @type {Manifest} */ (manifest),
							control,
							controlVnetId: checked.controlVnetId,
							controlPrefixes: checked.controlPrefixes,
							sshPublicKey: `${keyPath}.pub`,
							signal,
						});
						azure.vms = reused.vms;
						for (const network of reused.networks) azure.networks.set(network.region, network);
						report.replay.sha = reused.sha;
						report.replay.artifactDigest = reused.artifact.digest;
						return;
					}
					const { sha, refname } = await timed("resolve-ref", () =>
						resolveRef(context, topology.repository, options.ref, signal),
					);
					report.replay.sha = sha;
					report.replay.refname = refname;
					const runManifest = new Manifest(outDir, {
						runId: plan.runId,
						resourceGroup: plan.resourceGroup,
						expiresAt: plan.expiresAt,
						subscription: checked.subscription,
						control: { resourceGroup: control.resourceGroup, vnet: control.vnet },
						entries: [],
					});
					manifest = runManifest;
					mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
					await runCommand(
						context,
						"ssh-keygen",
						["-q", "-t", "ed25519", "-N", "", "-C", plan.runId, "-f", keyPath],
						{ operation: "create run SSH key", timeoutMs: 30_000, signal },
					);
					const run = new AzureRun({
						context,
						plan,
						topology,
						manifest: runManifest,
						control,
						controlVnetId: checked.controlVnetId,
						controlPrefixes: checked.controlPrefixes,
						sshPublicKey: `${keyPath}.pub`,
						signal,
					});
					azure = run;
					const [artifact, , runtime, sqld] = await settleAll([
						timed("artifact", () =>
							args.artifact !== undefined
								? sha256File(args.artifact).then((digest) => ({
										path: /** @type {string} */ (args.artifact),
										digest,
										cached: true,
									}))
								: buildArtifact(context, {
										sha,
										repository: topology.repository,
										nodeVersion: topology.node.version,
										builder: args.builder,
										manifest: runManifest,
										signal,
									}),
						),
						timed("provision", async () => {
							log("provisioning resource group, private networks and peerings");
							await run.createGroup();
							await run.createNetworks();
							log("creating VMs");
							await run.createVms();
							await run.tagStragglers();
							return undefined;
						}),
						timed("node-runtime", () => nodeTarball(context, topology.node.version, signal)),
						timed("sqld-binary", () => sqldBinary(context, topology.database, signal)),
					]).then(
						(values) =>
							/** @type {[{ path: string, digest: string, cached: boolean }, undefined, { path: string, digest: string }, { path: string, digest: string, version: string }]} */ (
								/** @type {unknown} */ (values)
							),
					);
					report.replay.artifactDigest = artifact.digest;
					report.environment = { artifactCached: artifact.cached };
					state = {
						plan,
						options,
						subscription: checked.subscription,
						controlVnetId: checked.controlVnetId,
						vms: run.vms,
						networks: [...run.networks.values()],
						sha,
						artifact: { path: artifact.path, digest: artifact.digest },
						runtime,
						sqld,
						deployed: false,
						sqldReady: false,
					};
					saveState(outDir, state);
				},
			},
			{
				name: "deploy",
				run: async () => {
					const run = current();
					report.environment = {
						...report.environment,
						sqld: run.sqld.version,
						sqldDigest: run.sqld.digest,
						sqldImage: topology.database.image,
						node: topology.node.version,
						nodeDigest: run.runtime.digest,
					};
					report.topology.vms = run.vms.map((vm) => ({ ...vm }));
					report.topology.networks = run.networks.map((network) => ({
						region: network.region,
						prefix: network.prefix,
						vnet: network.names.vnet,
					}));
					const secretsDir = join(outDir, "secrets");
					secrets =
						reused === undefined
							? await timed("secrets", () =>
									createRunSecrets(context, {
										dir: secretsDir,
										runId: plan.runId,
										hosts: run.vms
											.filter((vm) => vm.kind === "database")
											.map((vm) => ({ name: vm.name, ip: vm.privateIp })),
										namespaces: topology.database.namespaces,
										validHours: options.ttlHours,
									}),
								)
							: loadRunSecrets(context, secretsDir);
					const all = hostsOf(run.vms);
					hosts = all;
					if (run.deployed) return;
					const runSecrets = secrets;
					log("staging runtime, artifact and credentials over the private control path");
					await timed("deploy", () =>
						settleAll([
							...all.nodes.map(async (host) => {
								await stageBase(host, { nodeTarball: run.runtime.path, harnessDir: join(HERE, "node") });
								for (const [file, name] of [
									[runSecrets.caCert, "ca.pem"],
									[runSecrets.decoyCaCert, "decoy-ca.pem"],
									[runSecrets.token, "token"],
									[runSecrets.foreignToken, "foreign-token"],
								])
									await stageSecret(host, file, name);
								const deployed = await stageArtifact(host, {
									artifact: run.artifact.path,
									digest: run.artifact.digest,
								});
								if (deployed.sha !== run.sha)
									throw new DistributedProvisionError({
										step: "deploy artifact",
										resource: host.name,
										detail: `artifact is ${deployed.sha}, expected ${run.sha}`,
									});
								if (host.roles.includes("git-less")) await removeGit(host);
							}),
							...[all.primary, all.replica].map(async (host) => {
								await stageBase(host, { nodeTarball: run.runtime.path, harnessDir: join(HERE, "node") });
								const cert = runSecrets.hostCert(host.name);
								for (const [file, name] of [
									[runSecrets.caCert, "ca.pem"],
									[cert.cert, "host.pem"],
									[cert.key, "host.key"],
									[runSecrets.jwtPublicKey, "jwt.pub"],
								])
									await stageSecret(host, file, name);
							}),
						]),
					);
					run.deployed = true;
					saveState(outDir, run);
				},
			},
			{
				name: "sqld",
				run: async () => {
					const run = current();
					const { primary, replica } = /** @type {NonNullable<typeof hosts>} */ (hosts);
					if (run.sqldReady) return;
					const common = {
						storage: /** @type {"premium-ssd" | "local-nvme"} */ (run.options.dbStorage),
						sqldBinary: run.sqld.path,
						sqldDigest: run.sqld.digest,
						primaryIp: primary.ip,
						gatewayPort: topology.database.gatewayPort,
						replicationPort: topology.database.replicationPort,
					};
					/** @type {NonNullable<import("./harness/report.mjs").ReportEnvironment["databaseVolumes"]>} */
					const databaseVolumes = {};
					report.environment.databaseVolumes = databaseVolumes;
					await timed("sqld", async () => {
						databaseVolumes.primary = await setupSqld(primary, { role: "primary", ...common });
						await createNamespaces(primary, topology.database.namespaces);
						databaseVolumes.replica = await setupSqld(replica, { role: "replica", ...common });
					});
					run.sqldReady = true;
					saveState(outDir, run);
				},
			},
			{
				name: "probe",
				run: async () => {
					const { nodes, primary, replica } = /** @type {NonNullable<typeof hosts>} */ (hosts);
					report.environment.hosts = Object.fromEntries(
						await settleAll(
							[...nodes, primary, replica].map(async (host) => [host.name, await host.agent("facts", [])]),
						),
					);
					const document = await nodes[0].agent("capabilities", ["--ref-dir", "/opt/adt/atomic"]);
					capabilities = parseCapabilities(document);
					if (capabilities === undefined)
						throw new DistributedProvisionError({
							step: "probe capabilities",
							resource: nodes[0].name,
							detail: "malformed capabilities document",
						});
					report.environment.capabilities = {
						workflows: capabilities.workflows.length,
						atomic: capabilities.atomic.length,
						artifact: document.artifact,
					};
				},
			},
			{
				name: "security-gate",
				teardownOnFailure: true,
				run: async () => {
					const run = current();
					const { nodes, primary, replica } = /** @type {NonNullable<typeof hosts>} */ (hosts);
					log("running the security gate");
					/** @type {import("./harness/security.mjs").SecurityCheck[]} */
					const checks = [];
					report.security = { passed: false, checks };
					report.security = await timed("security", () =>
						securityGate(
							{
								azure: /** @type {AzureRun} */ (azure),
								nodes,
								primary,
								replica,
								dbHosts: [primary, replica],
								allowedSources: [control.sshSourcePrefix, ...run.networks.map((network) => network.prefix)],
								nics: run.vms.flatMap((vm) => vm.nics.map((nic) => ({ vm: vm.name, nic }))),
								gatewayPort: topology.database.gatewayPort,
								replicationPort: topology.database.replicationPort,
								namespace: topology.database.namespaces[0],
								nvme: run.options.dbStorage === "local-nvme",
							},
							checks,
						),
					);
					log("security gate passed; running suites");
				},
			},
		],
		scenarios: async () => {
			const { nodes, primary, replica } = /** @type {NonNullable<typeof hosts>} */ (hosts);
			const random = createRandom(options.seed);
			for (const suite of selectedSuites(options.suite)) {
				const issue = /** @type {Record<string, string>} */ (SUITES)[suite];
				if (suite === "smoke") {
					/** @type {import("./harness/suites.mjs").FaultRecord[]} */
					const faults = [];
					const smoke = await timed("suite-smoke", () =>
						runSmoke({
							runId: plan.runId,
							attempt: Date.now().toString(36),
							nodes,
							primary,
							replica,
							azure: /** @type {AzureRun} */ (azure),
							random,
							profiles: options.chaos,
							gatewayPort: topology.database.gatewayPort,
							namespace: topology.database.namespaces[0],
							signal,
							log,
							started,
							faults,
						}),
					).catch((error) => {
						report.suites.push({
							name: suite,
							issue,
							status: isCancellation(error, signal) ? "cancelled" : "failed",
							reason: serializeDistributedError(error),
							faults,
						});
						report.coverage = profileCoverage(faults, options.chaos);
						throw error;
					});
					report.suites.push({
						name: suite,
						issue,
						status: suiteStatus(smoke.invariants, smoke.faults),
						invariants: smoke.invariants,
						failures: invariantFailures(smoke.invariants, suite).map((error) => serializeDistributedError(error)),
						faults: smoke.faults,
						metrics: smoke.metrics,
						profiles: smoke.profileSpecs,
					});
					report.coverage = profileCoverage(smoke.faults, options.chaos);
					continue;
				}
				const skip = featureSkip(suite, /** @type {import("./harness/suites.mjs").Capabilities} */ (capabilities));
				report.suites.push({
					name: suite,
					issue,
					status: "skipped",
					...(skip === undefined ? {} : { reason: serializeDistributedError(skip) }),
				});
			}
		},
		teardown: async () => {
			const runManifest = /** @type {Manifest} */ (manifest);
			log("tearing down and proving absence");
			const cleanup = new AbortController();
			const budgetMs = 90 * 60_000;
			const teardownStarted = performance.now();
			const timer = setTimeout(
				() =>
					cleanup.abort(
						new DistributedTimeoutError({
							phase: "teardown",
							timeoutMs: budgetMs,
							elapsedMs: Math.round(performance.now() - teardownStarted),
						}),
					),
				budgetMs,
			);
			try {
				const result = await timed("teardown", () =>
					teardownRun({
						az: (azArgs, operation) =>
							azJson(context, azArgs, { operation, timeoutMs: 45 * 60_000, signal: cleanup.signal }),
						runId: plan.runId,
						resourceGroup: plan.resourceGroup,
						control,
						knownPeerings: runManifest.data.entries
							.filter((entry) => entry.kind === "peering" && entry.scope.includes("/"))
							.map((entry) => entry.name),
						sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
						now: () => performance.now(),
						deadlineMs: 10 * 60_000,
						pollMs: 20_000,
					}),
				);
				const leftoverBuilder = runManifest.data.builder;
				/** @type {unknown} */
				let builderFailure;
				if (leftoverBuilder !== undefined) {
					try {
						await stopBuilder(context, leftoverBuilder);
						runManifest.setBuilder(undefined);
					} catch (error) {
						builderFailure = error;
					}
				}
				report.teardown = {
					ok: result.ok && builderFailure === undefined,
					steps: result.steps.map((step) => ({
						operation: step.operation,
						ok: step.ok,
						...(step.error === undefined ? {} : { error: serializeDistributedError(step.error) }),
					})),
					queries: result.queries,
					remaining: result.remaining,
					...(leftoverBuilder === undefined
						? {}
						: { builder: builderFailure === undefined ? "stopped" : serializeDistributedError(builderFailure) }),
				};
				if (builderFailure === undefined) return { ok: result.ok, error: result.error };
				return {
					ok: false,
					error:
						result.error === undefined
							? builderFailure
							: attachConcurrentFailures(result.error, [builderFailure]),
				};
			} finally {
				clearTimeout(timer);
			}
		},
	});
	if (outcome.error !== undefined && !outcome.cancelled) printError("Run failed", outcome.error);
	if (outcome.teardown !== undefined && !outcome.teardown.ok) {
		printError("Teardown incomplete", outcome.teardown.error);
		if (outcome.error === undefined) report.teardownError = serializeDistributedError(outcome.teardown.error);
	}
	if (outcome.teardownSkipped === "kept")
		report.teardown = {
			ok: null,
			kept: true,
			expiresAt: plan.expiresAt,
			reuse: reuseCommand(plan.runId, args.out),
			sweep: `node test/distributed/sweep.mjs --run-id ${plan.runId} --force`,
		};
	if (outcome.teardownSkipped === "nothing-provisioned")
		report.teardown = { ok: true, nothingProvisioned: true, steps: [], queries: [], remaining: [] };
	report.lifecycle = { completed: outcome.completed, scenariosStarted: outcome.scenariosStarted };
	if (outcome.error !== undefined && !outcome.cancelled) report.error = serializeDistributedError(outcome.error);
	report.finishedAt = new Date().toISOString();
	durations.total = Math.round(performance.now() - started);
	report.status = overallStatus({
		cancelled: outcome.cancelled,
		error: outcome.cancelled ? undefined : outcome.error,
		suites: report.suites,
		coverage: report.coverage,
		teardownOk: outcome.teardown === undefined ? null : outcome.teardown.ok,
	});
	const paths = writeReport(outDir, report, context.secrets);
	writeFileSync(join(outDir, "status"), `${report.status}\n`);
	log(`status ${report.status}; report ${paths.markdown}`);
	return report.status === "passed" ? 0 : report.status === "cancelled" ? 130 : 1;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}
