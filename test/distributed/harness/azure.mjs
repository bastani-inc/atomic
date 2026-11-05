// @ts-check
/**
 * Azure side effects of a run: prerequisite checks, private network and VM provisioning, the security gate's Azure
 * queries, and VM-level faults. Every resource is recorded in the manifest before the command that creates it, and
 * every taggable resource carries the run tag and expiry.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { azJson, retrying, settleAll } from "./commands.mjs";
import { DistributedPrerequisiteError, DistributedProvisionError, isCancellation } from "./errors.mjs";
import { allocateAddressSpaces, subnetOf, subnetRules } from "./network.mjs";
import { networkNames, RUN_TAG, runTags, tagArguments } from "./ownership.mjs";

/**
 * @typedef {import("./config.mjs").RunPlan} RunPlan
 * @typedef {import("./config.mjs").Topology} Topology
 * @typedef {import("./config.mjs").VmPlan} VmPlan
 * @typedef {VmPlan & { privateIp: string, secondaryIp?: string, nics: string[] }} PlacedVm
 * @typedef {{ region: string, prefix: string, vnetId: string, names: ReturnType<typeof networkNames> }} RegionNetwork
 */

const AZ_TIMEOUT_MS = 20 * 60_000;

/**
 * @typedef {{ tool: string, what: string, why: string, fix: string }} ToolRequirement
 */

/**
 * The local tools a run needs, given what it will do: a reused topology needs no key, download or build tools, the
 * sqld image is pulled only when its binary is not cached, and git only resolves a ref that is not already a SHA.
 * @param {{ reuse: boolean, builder: boolean, sqldCached: boolean, ref: string }} input
 * @returns {ToolRequirement[]}
 */
export function requiredTools({ reuse, builder, sqldCached, ref }) {
	/** @type {ToolRequirement[]} */
	const tools = [
		{
			tool: "ssh",
			what: "ssh",
			why: "the controller reaches private VMs over SSH",
			fix: "sudo apt-get install -y openssh-client",
		},
		{
			tool: "scp",
			what: "scp",
			why: "artifacts and credentials are copied to the VMs over SSH",
			fix: "sudo apt-get install -y openssh-client",
		},
		{
			tool: "openssl",
			what: "openssl",
			why: "the run CA and host certificates are created locally",
			fix: "sudo apt-get install -y openssl",
		},
	];
	if (!reuse) {
		tools.push(
			{
				tool: "ssh-keygen",
				what: "ssh-keygen",
				why: "each run gets its own SSH key",
				fix: "sudo apt-get install -y openssh-client",
			},
			{
				tool: "curl",
				what: "curl",
				why: "the pinned Node runtime and its checksums are downloaded",
				fix: "sudo apt-get install -y curl",
			},
		);
		if (!sqldCached)
			tools.push({
				tool: "docker",
				what: "docker",
				why: "the pinned sqld binary is extracted from its image",
				fix: "install Docker Engine",
			});
		if (!/^[0-9a-f]{40}$/.test(ref))
			tools.push({
				tool: "git",
				what: "git",
				why: "--ref is resolved to a commit SHA with git ls-remote",
				fix: "sudo apt-get install -y git, or pass a full commit SHA",
			});
		if (builder)
			tools.push({
				tool: "crabbox",
				what: "crabbox",
				why: "the ref is built on a Crabbox runner",
				fix: "install crabbox, or pass --artifact <tarball>",
			});
	}
	tools.push({
		tool: "az",
		what: "az",
		why: "every resource is created with the az CLI",
		fix: "install the Azure CLI",
	});
	return tools;
}

/**
 * Whether an executable named `tool` is on `path` (a PATH value).
 * @param {string} tool
 * @param {string} path
 */
export function onPath(tool, path) {
	return path.split(delimiter).some((dir) => {
		if (dir === "") return false;
		try {
			accessSync(join(dir, tool), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * Checks every tool, login and network the run needs before anything is created, reporting all missing pieces
 * together. Tools are looked up on PATH without running them; `az` is called only when it is present.
 * @param {import("./commands.mjs").CommandContext} context
 * @param {{ control: import("./config.mjs").ControlNetwork, tools: readonly ToolRequirement[], path: string, signal?: AbortSignal }} input
 * @returns {Promise<{ subscription: string, controlVnetId: string, controlPrefixes: string[] }>}
 */
export async function checkPrerequisites(context, { control, tools, path, signal }) {
	const missing = tools.filter((item) => !onPath(item.tool, path)).map(({ what, why, fix }) => ({ what, why, fix }));
	if (missing.some((item) => item.what === "az")) throw new DistributedPrerequisiteError({ missing });
	/** @type {unknown[]} */
	const causes = [];
	/** @param {string[]} args @param {{ what: string, why: string, fix: string }} item */
	const query = async (args, item) => {
		try {
			return await azJson(context, args, { operation: `prerequisite ${item.what}`, timeoutMs: 120_000, signal });
		} catch (error) {
			if (isCancellation(error, signal)) throw error;
			missing.push(item);
			causes.push(error);
			return undefined;
		}
	};
	const account = await query(["account", "show", "--query", "id"], {
		what: "az login",
		why: "every resource is created with the az CLI",
		fix: "az login",
	});
	const controlVnet = await query(
		[
			"network",
			"vnet",
			"show",
			"--resource-group",
			control.resourceGroup,
			"--name",
			control.vnet,
			"--query",
			"{id:id,prefixes:addressSpace.addressPrefixes}",
		],
		{
			what: `control VNet ${control.vnet}`,
			why: "test VNets are peered to it for private control",
			fix: `check that ${control.resourceGroup}/${control.vnet} exists and that you can read it`,
		},
	);
	if (missing.length > 0) throw new DistributedPrerequisiteError({ missing, cause: causes[0] });
	const shown = /** @type {{ id: string, prefixes: string[] | null }} */ (controlVnet);
	return { subscription: String(account), controlVnetId: shown.id, controlPrefixes: shown.prefixes ?? [] };
}

export class AzureRun {
	/**
	 * @param {{ context: import("./commands.mjs").CommandContext, plan: RunPlan, topology: Topology,
	 *   manifest: import("./manifest.mjs").Manifest, control: import("./config.mjs").ControlNetwork, controlVnetId: string, controlPrefixes: string[],
	 *   sshPublicKey: string, signal?: AbortSignal }} init
	 */
	constructor({ context, plan, topology, manifest, control, controlVnetId, controlPrefixes, sshPublicKey, signal }) {
		this.context = context;
		this.plan = plan;
		this.topology = topology;
		this.control = control;
		this.controlPrefixes = controlPrefixes;
		this.manifest = manifest;
		this.controlVnetId = controlVnetId;
		this.sshPublicKey = sshPublicKey;
		this.signal = signal;
		this.tags = tagArguments(runTags(plan.runId, plan.expiresAt));
		/** @type {Map<string, RegionNetwork>} */
		this.networks = new Map();
		/** @type {PlacedVm[]} */
		this.vms = [];
	}

	/**
	 * @template T
	 * @param {readonly string[]} args
	 * @param {string} operation
	 * @param {number} [timeoutMs]
	 * @returns {Promise<T>}
	 */
	az(args, operation, timeoutMs = AZ_TIMEOUT_MS) {
		return azJson(this.context, args, { operation, timeoutMs, signal: this.signal });
	}

	/**
	 * Records the resource, then runs the command that creates it, wrapping failures with the step and resource.
	 * @template T
	 * @param {{ kind: string, name: string, scope?: string, step: string, args: readonly string[] }} input
	 * @returns {Promise<T>}
	 */
	async create({ kind, name, scope = this.plan.resourceGroup, step, args }) {
		this.manifest.plan(kind, name, scope);
		try {
			/** @type {T} */
			const result = await this.az(args, `${step} ${name}`);
			this.manifest.mark(kind, name, scope, "created");
			return result;
		} catch (error) {
			if (isCancellation(error, this.signal)) throw error;
			throw new DistributedProvisionError({ step, resource: name, cause: error });
		}
	}

	/** Address prefixes already in use by the control VNet's peers and by other runs' VNets. */
	async usedPrefixes() {
		const peers = /** @type {string[][]} */ (
			await this.az(
				[
					"network",
					"vnet",
					"peering",
					"list",
					"--resource-group",
					this.control.resourceGroup,
					"--vnet-name",
					this.control.vnet,
					"--query",
					"[].remoteAddressSpace.addressPrefixes",
				],
				"list control peer prefixes",
			)
		);
		const tagged = /** @type {string[][]} */ (
			await this.az(
				["network", "vnet", "list", "--query", `[?tags."${RUN_TAG}" != null].addressSpace.addressPrefixes`],
				"list run VNet prefixes",
			)
		);
		return [...this.controlPrefixes, ...(peers ?? []).flat(), ...(tagged ?? []).flat()];
	}

	async createGroup() {
		await this.create({
			kind: "group",
			name: this.plan.resourceGroup,
			scope: "subscription",
			step: "create resource group",
			args: [
				"group",
				"create",
				"--name",
				this.plan.resourceGroup,
				"--location",
				this.plan.location,
				"--tags",
				...this.tags,
			],
		});
	}

	async createNetworks() {
		const allocated = allocateAddressSpaces(
			this.plan.vnetRegions,
			await this.usedPrefixes(),
			this.topology.addressPool,
		);
		if (allocated === undefined) {
			throw new DistributedProvisionError({
				step: "allocate address space",
				resource: "10.60.0.0/16 pool",
				detail: "no free /16 left in the pool",
			});
		}
		const runPrefixes = [...allocated.values()];
		const databaseVms = this.plan.vms.filter((vm) => vm.kind === "database");
		const hostIp = (/** @type {VmPlan} */ vm) =>
			subnetOf(/** @type {string} */ (allocated.get(vm.region))).host(vm.hostIndex);
		await settleAll(
			this.plan.vnetRegions.map(async (region) => {
				const prefix = /** @type {string} */ (allocated.get(region));
				const names = networkNames(this.plan.runId, region);
				await this.create({
					kind: "nsg",
					name: names.nsg,
					step: "create NSG",
					args: [
						"network",
						"nsg",
						"create",
						"--resource-group",
						this.plan.resourceGroup,
						"--name",
						names.nsg,
						"--location",
						region,
						"--tags",
						...this.tags,
					],
				});
				const rules = subnetRules({
					sshSource: this.control.sshSourcePrefix,
					runPrefixes,
					databaseHosts: databaseVms.filter((vm) => vm.region === region).map(hostIp),
					replicaHosts: databaseVms.filter((vm) => vm.dbRole === "replica").map(hostIp),
					primaryHosts: databaseVms.filter((vm) => vm.dbRole === "primary" && vm.region === region).map(hostIp),
					gatewayPort: this.topology.database.gatewayPort,
					replicationPort: this.topology.database.replicationPort,
				});
				for (const rule of rules) {
					await this.create({
						kind: "nsg-rule",
						name: `${names.nsg}/${rule.name}`,
						step: "create NSG rule",
						args: [
							"network",
							"nsg",
							"rule",
							"create",
							"--resource-group",
							this.plan.resourceGroup,
							"--nsg-name",
							names.nsg,
							"--name",
							rule.name,
							"--priority",
							String(rule.priority),
							"--direction",
							rule.direction,
							"--access",
							rule.access,
							"--protocol",
							rule.protocol,
							"--source-address-prefixes",
							...rule.sources,
							"--source-port-ranges",
							"*",
							"--destination-address-prefixes",
							...rule.destinations,
							"--destination-port-ranges",
							...rule.ports,
						],
					});
				}
				/** @type {{ newVNet: { id: string } }} */
				const vnet = await this.create({
					kind: "vnet",
					name: names.vnet,
					step: "create VNet",
					args: [
						"network",
						"vnet",
						"create",
						"--resource-group",
						this.plan.resourceGroup,
						"--name",
						names.vnet,
						"--location",
						region,
						"--address-prefixes",
						prefix,
						"--tags",
						...this.tags,
					],
				});
				await this.create({
					kind: "subnet",
					name: `${names.vnet}/${names.subnet}`,
					step: "create private subnet",
					args: [
						"network",
						"vnet",
						"subnet",
						"create",
						"--resource-group",
						this.plan.resourceGroup,
						"--vnet-name",
						names.vnet,
						"--name",
						names.subnet,
						"--address-prefixes",
						subnetOf(prefix).subnet,
						"--network-security-group",
						names.nsg,
						"--default-outbound",
						"false",
					],
				});
				this.networks.set(region, { region, prefix, vnetId: vnet.newVNet.id, names });
			}),
		);
		await this.createPeerings();
	}

	async createPeerings() {
		const peer = (
			/** @type {string} */ group,
			/** @type {string} */ vnet,
			/** @type {string} */ name,
			/** @type {string} */ remote,
			/** @type {string} */ scope,
		) =>
			this.create({
				kind: "peering",
				name,
				scope,
				step: "create VNet peering",
				args: [
					"network",
					"vnet",
					"peering",
					"create",
					"--resource-group",
					group,
					"--vnet-name",
					vnet,
					"--name",
					name,
					"--remote-vnet",
					remote,
					"--allow-vnet-access",
					"true",
					"--allow-forwarded-traffic",
					"false",
				],
			});
		const networks = [...this.networks.values()];
		const control = `${this.control.resourceGroup}/${this.control.vnet}`;
		await settleAll(
			networks.map(async (network) => {
				await peer(
					this.control.resourceGroup,
					this.control.vnet,
					network.names.fromControl,
					network.vnetId,
					control,
				);
				await peer(
					this.plan.resourceGroup,
					network.names.vnet,
					network.names.toControl,
					this.controlVnetId,
					this.plan.resourceGroup,
				);
			}),
		);
		for (const network of networks) {
			for (const other of networks) {
				if (other !== network)
					await peer(
						this.plan.resourceGroup,
						network.names.vnet,
						network.names.toRegion(other.region),
						other.vnetId,
						this.plan.resourceGroup,
					);
			}
		}
	}

	/** Creates every VM in parallel with private NICs only. */
	async createVms() {
		this.vms = await settleAll(this.plan.vms.map((vm) => this.createVm(vm)));
		return this.vms;
	}

	/**
	 * @param {VmPlan} vm
	 * @returns {Promise<PlacedVm>}
	 */
	async createVm(vm) {
		const network = /** @type {RegionNetwork} */ (this.networks.get(vm.region));
		const privateIp = subnetOf(network.prefix).host(vm.hostIndex);
		const nicSpecs = [
			{ name: `${vm.name}-nic`, ip: privateIp },
			...(vm.secondaryNic
				? [{ name: `${vm.name}-nic2`, ip: subnetOf(network.prefix).host(vm.hostIndex + 100) }]
				: []),
		];
		for (const nic of nicSpecs) {
			await this.create({
				kind: "nic",
				name: nic.name,
				step: "create private NIC",
				args: [
					"network",
					"nic",
					"create",
					"--resource-group",
					this.plan.resourceGroup,
					"--name",
					nic.name,
					"--location",
					vm.region,
					"--vnet-name",
					network.names.vnet,
					"--subnet",
					network.names.subnet,
					"--private-ip-address",
					nic.ip,
					"--tags",
					...this.tags,
				],
			});
		}
		await this.create({
			kind: "vm",
			name: vm.name,
			step: "create VM",
			args: [
				"vm",
				"create",
				"--resource-group",
				this.plan.resourceGroup,
				"--name",
				vm.name,
				"--location",
				vm.region,
				"--size",
				vm.size,
				"--image",
				this.topology.image,
				"--admin-username",
				this.topology.adminUser,
				"--ssh-key-values",
				this.sshPublicKey,
				"--nics",
				...nicSpecs.map((nic) => nic.name),
				"--public-ip-address",
				"",
				"--os-disk-delete-option",
				"Delete",
				"--os-disk-size-gb",
				"64",
				"--storage-sku",
				"Premium_LRS",
				"--tags",
				...this.tags,
				...(vm.dataDisk
					? [
							"--data-disk-sizes-gb",
							String(this.topology.database.dataDiskGb),
							"--data-disk-delete-option",
							"Delete",
						]
					: []),
				...(vm.encryptionAtHost ? ["--encryption-at-host", "true"] : []),
			],
		});
		return {
			...vm,
			privateIp,
			...(vm.secondaryNic ? { secondaryIp: nicSpecs[1].ip } : {}),
			nics: nicSpecs.map((nic) => nic.name),
		};
	}

	/** Tags any resource in the group that Azure created without the run tag (OS and data disks). */
	async tagStragglers() {
		/** @type {{ id: string, tags?: Record<string, string> | null }[]} */
		const resources = await this.az(
			["resource", "list", "--resource-group", this.plan.resourceGroup, "--query", "[].{id:id,tags:tags}"],
			"list group resources",
		);
		for (const resource of resources.filter((item) => item.tags?.[RUN_TAG] !== this.plan.runId)) {
			await this.az(
				["resource", "tag", "--ids", resource.id, "--is-incremental", "--tags", ...this.tags],
				`tag ${resource.id.split("/").pop()}`,
			);
		}
		return resources.length;
	}

	// Security gate queries.

	/** @returns {Promise<{ vm: string, publicIps: string[] }[]>} */
	async publicAddresses() {
		/** @type {{ virtualMachine: { name: string, network: { publicIpAddresses: { ipAddress: string }[] } } }[]} */
		const listed = await this.az(
			["vm", "list-ip-addresses", "--resource-group", this.plan.resourceGroup],
			"list VM IP addresses",
		);
		return listed.map((item) => ({
			vm: item.virtualMachine.name,
			publicIps: item.virtualMachine.network.publicIpAddresses.map((ip) => ip.ipAddress),
		}));
	}

	/** @returns {Promise<string[]>} */
	async publicIpResources() {
		return this.az(
			["network", "public-ip", "list", "--resource-group", this.plan.resourceGroup, "--query", "[].id"],
			"list public IP resources",
		);
	}

	/** @returns {Promise<string[]>} */
	async loadBalancers() {
		return this.az(
			["network", "lb", "list", "--resource-group", this.plan.resourceGroup, "--query", "[].id"],
			"list load balancers",
		);
	}

	/**
	 * @param {string} nic
	 * @returns {Promise<import("./network.mjs").EffectiveRule[]>}
	 */
	async effectiveRules(nic) {
		/** @type {{ value?: { effectiveSecurityRules?: import("./network.mjs").EffectiveRule[] }[] }} */
		const result = await retrying(
			() =>
				this.az(
					["network", "nic", "list-effective-nsg", "--resource-group", this.plan.resourceGroup, "--name", nic],
					`effective NSG ${nic}`,
				),
			{ attempts: 3, delayMs: 15_000, signal: this.signal },
		);
		return (result?.value ?? []).flatMap((entry) => entry.effectiveSecurityRules ?? []);
	}

	/**
	 * @param {string} vm
	 * @returns {Promise<{ encryptionAtHost: boolean | null, size: string, nics: number, powerState: string }>}
	 */
	async vmFacts(vm) {
		/** @type {{ securityProfile?: { encryptionAtHost?: boolean } | null, hardwareProfile: { vmSize: string }, networkProfile: { networkInterfaces: unknown[] }, powerState?: string }} */
		const shown = await this.az(
			["vm", "show", "--resource-group", this.plan.resourceGroup, "--name", vm, "--show-details"],
			`show ${vm}`,
		);
		return {
			encryptionAtHost: shown.securityProfile?.encryptionAtHost ?? null,
			size: shown.hardwareProfile.vmSize,
			nics: shown.networkProfile.networkInterfaces.length,
			powerState: shown.powerState ?? "unknown",
		};
	}

	// VM-level faults.

	/**
	 * Without `wait`, Azure only accepts the operation and the caller observes the guest instead. A restart or start can
	 * finish in the guest within seconds while Azure reports the VM as `Updating` for many minutes, for example while a
	 * policy-installed extension that needs Internet access never completes on a private VM.
	 * @param {string} vm @param {"restart" | "deallocate" | "start"} action @param {{ wait?: boolean }} [options]
	 */
	async vmPower(vm, action, { wait = true } = {}) {
		await this.az(
			["vm", action, "--resource-group", this.plan.resourceGroup, "--name", vm, ...(wait ? [] : ["--no-wait"])],
			`${action} ${vm}`,
		);
	}

	/** @param {string} vm @param {string} nic @param {"remove" | "add"} action */
	async vmNic(vm, nic, action) {
		await this.az(
			["vm", "nic", action, "--resource-group", this.plan.resourceGroup, "--vm-name", vm, "--nics", nic],
			`${action} NIC ${nic} on ${vm}`,
		);
	}
}
