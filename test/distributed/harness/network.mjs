// @ts-check
/**
 * Private network planning and verification, as pure functions: address allocation for the run's VNets, the NSG
 * rules each subnet gets, and the evaluation of effective NSG rules the security gate applies to every NIC.
 */

/**
 * @param {string} cidr
 * @returns {{ base: number, bits: number } | undefined}
 */
export function parseCidr(cidr) {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(cidr);
	if (match === null) return undefined;
	const octets = match.slice(1, 5).map(Number);
	const bits = match[5] === undefined ? 32 : Number(match[5]);
	if (octets.some((octet) => octet > 255) || bits > 32) return undefined;
	const address = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return { base: (address & mask) >>> 0, bits };
}

/**
 * @param {{ base: number, bits: number }} range
 */
function rangeEnd(range) {
	return range.base + 2 ** (32 - range.bits) - 1;
}

/**
 * Whether two CIDR blocks share any address. Unparseable input overlaps everything, so it is never treated as free.
 * @param {string} left
 * @param {string} right
 */
export function cidrsOverlap(left, right) {
	const a = parseCidr(left);
	const b = parseCidr(right);
	if (a === undefined || b === undefined) return true;
	return a.base <= rangeEnd(b) && b.base <= rangeEnd(a);
}

/**
 * Whether `inner` lies entirely inside `outer`.
 * @param {string} inner
 * @param {string} outer
 */
export function cidrWithin(inner, outer) {
	const a = parseCidr(inner);
	const b = parseCidr(outer);
	if (a === undefined || b === undefined) return false;
	return a.base >= b.base && rangeEnd(a) <= rangeEnd(b);
}

/**
 * One /16 per region from `10.<first>.0.0/16` upward, skipping every prefix already in use (peered to the control
 * VNet, owned by other runs, or reserved for the control network). Returns undefined when the pool is exhausted.
 * @param {readonly string[]} regions
 * @param {readonly string[]} used
 * @param {{ firstSecondOctet: number, lastSecondOctet: number }} pool
 * @returns {Map<string, string> | undefined}
 */
export function allocateAddressSpaces(regions, used, pool) {
	/** @type {Map<string, string>} */
	const allocated = new Map();
	const taken = [...used];
	let octet = pool.firstSecondOctet;
	for (const region of regions) {
		if (allocated.has(region)) continue;
		while (octet <= pool.lastSecondOctet && taken.some((prefix) => cidrsOverlap(`10.${octet}.0.0/16`, prefix)))
			octet++;
		if (octet > pool.lastSecondOctet) return undefined;
		const prefix = `10.${octet}.0.0/16`;
		allocated.set(region, prefix);
		taken.push(prefix);
		octet++;
	}
	return allocated;
}

/**
 * The subnet and a host address inside a region's /16.
 * @param {string} vnetPrefix
 */
export function subnetOf(vnetPrefix) {
	const second = vnetPrefix.split(".")[1];
	return { subnet: `10.${second}.0.0/24`, host: (/** @type {number} */ index) => `10.${second}.0.${index}` };
}

/**
 * @typedef {{ name: string, priority: number, direction: "Inbound" | "Outbound", access: "Allow" | "Deny",
 *   protocol: "Tcp" | "*", sources: string[], destinations: string[], ports: string[] }} NsgRule
 */

/**
 * The rules every test subnet's NSG carries. Inbound: deny Internet first, allow SSH from the control subnet and the
 * database ports from the run's own VNets only, then deny the rest of `VirtualNetwork` and `AzureLoadBalancer` ahead
 * of Azure's implicit allows. Outbound: deny Internet; nothing the harness runs needs it, because every artifact is
 * staged over the private control path.
 * @param {{ sshSource: string, runPrefixes: readonly string[], databaseHosts: readonly string[], replicaHosts: readonly string[],
 *   primaryHosts: readonly string[], gatewayPort: number, replicationPort: number }} input
 * @returns {NsgRule[]}
 */
export function subnetRules({
	sshSource,
	runPrefixes,
	databaseHosts,
	replicaHosts,
	primaryHosts,
	gatewayPort,
	replicationPort,
}) {
	/** @type {NsgRule[]} */
	const rules = [
		{
			name: "deny-internet-in",
			priority: 100,
			direction: "Inbound",
			access: "Deny",
			protocol: "*",
			sources: ["Internet"],
			destinations: ["*"],
			ports: ["*"],
		},
		{
			name: "allow-ssh-control",
			priority: 200,
			direction: "Inbound",
			access: "Allow",
			protocol: "Tcp",
			sources: [sshSource],
			destinations: ["VirtualNetwork"],
			ports: ["22"],
		},
	];
	if (databaseHosts.length > 0) {
		rules.push({
			name: "allow-sqld-gateway",
			priority: 210,
			direction: "Inbound",
			access: "Allow",
			protocol: "Tcp",
			sources: [...runPrefixes],
			destinations: databaseHosts.map((host) => `${host}/32`),
			ports: [String(gatewayPort)],
		});
	}
	if (replicaHosts.length > 0 && primaryHosts.length > 0) {
		rules.push({
			name: "allow-sqld-replication",
			priority: 220,
			direction: "Inbound",
			access: "Allow",
			protocol: "Tcp",
			sources: replicaHosts.map((host) => `${host}/32`),
			destinations: primaryHosts.map((host) => `${host}/32`),
			ports: [String(replicationPort)],
		});
	}
	rules.push(
		{
			name: "deny-vnet-in",
			priority: 4000,
			direction: "Inbound",
			access: "Deny",
			protocol: "*",
			sources: ["VirtualNetwork"],
			destinations: ["*"],
			ports: ["*"],
		},
		{
			name: "deny-azure-lb-in",
			priority: 4010,
			direction: "Inbound",
			access: "Deny",
			protocol: "*",
			sources: ["AzureLoadBalancer"],
			destinations: ["*"],
			ports: ["*"],
		},
		{
			name: "deny-internet-out",
			priority: 100,
			direction: "Outbound",
			access: "Deny",
			protocol: "*",
			sources: ["*"],
			destinations: ["Internet"],
			ports: ["*"],
		},
	);
	return rules;
}

/**
 * @typedef {{ name?: string, access?: string, direction?: string, priority?: number, protocol?: string,
 *   sourceAddressPrefix?: string, sourceAddressPrefixes?: string[], expandedSourceAddressPrefix?: string[] | null,
 *   destinationPortRange?: string, destinationPortRanges?: string[] }} EffectiveRule
 * @typedef {{ check: string, subject: string, detail: string }} Violation
 */

const PUBLIC_SOURCES = new Set(["*", "Internet", "0.0.0.0/0", "Any"]);

/**
 * @param {EffectiveRule} rule
 * @returns {string[]}
 */
function sourcesOf(rule) {
	const listed = [
		...(rule.sourceAddressPrefixes ?? []),
		...(rule.sourceAddressPrefix === undefined || rule.sourceAddressPrefix === "" ? [] : [rule.sourceAddressPrefix]),
	];
	return listed.map((source) => (source.startsWith("Tag/") ? source.slice(4) : source));
}

/**
 * @param {EffectiveRule} rule
 */
function portsOf(rule) {
	return [
		...(rule.destinationPortRanges ?? []),
		...(rule.destinationPortRange === undefined || rule.destinationPortRange === ""
			? []
			: [rule.destinationPortRange]),
	];
}

/**
 * @param {EffectiveRule} rule
 */
function coversAllTraffic(rule) {
	return (
		(rule.protocol === "All" || rule.protocol === "*") &&
		portsOf(rule).some((port) => port === "*" || port === "0-65535")
	);
}

/**
 * @param {string} source
 */
function isPrivateCidr(source) {
	return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((block) => cidrWithin(source, block));
}

/**
 * Evaluates one NIC's effective inbound rules against the contract: an explicit Internet deny ahead of every allow;
 * no allow from `*`, `Internet` or any public range; every allow's sources inside the allowlist; and Azure's implicit
 * `AllowVnetInBound` and `AllowAzureLoadBalancerInBound` shadowed by higher-priority denies.
 * @param {string} nic
 * @param {readonly EffectiveRule[]} rules
 * @param {readonly string[]} allowedSources
 * @returns {Violation[]}
 */
export function evaluateEffectiveRules(nic, rules, allowedSources) {
	/** @type {Violation[]} */
	const violations = [];
	const inbound = rules
		.filter((rule) => rule.direction === "Inbound")
		.sort((a, b) => (a.priority ?? 65535) - (b.priority ?? 65535));
	const allows = inbound.filter((rule) => rule.access === "Allow");
	const internetDeny = inbound.find(
		(rule) => rule.access === "Deny" && sourcesOf(rule).includes("Internet") && coversAllTraffic(rule),
	);
	if (internetDeny === undefined) {
		violations.push({
			check: "internet-deny",
			subject: nic,
			detail: "no explicit inbound deny from Internet covering all traffic",
		});
	} else {
		const earlier = allows.filter(
			(rule) => (rule.priority ?? 65535) < (internetDeny.priority ?? 65535) && !isDefaultRule(rule),
		);
		for (const rule of earlier)
			violations.push({
				check: "internet-deny",
				subject: nic,
				detail: `allow ${rule.name} precedes the Internet deny`,
			});
	}
	for (const rule of allows) {
		const sources = sourcesOf(rule);
		const shadowedBy = (/** @type {string} */ tag) =>
			inbound.some(
				(deny) =>
					deny.access === "Deny" &&
					(deny.priority ?? 65535) < (rule.priority ?? 65535) &&
					sourcesOf(deny).includes(tag) &&
					coversAllTraffic(deny),
			);
		if (isDefaultRule(rule)) {
			const tag = sources[0] ?? "";
			if (!shadowedBy(tag))
				violations.push({
					check: "implicit-allow",
					subject: nic,
					detail: `${rule.name} is not overridden by a higher-priority deny from ${tag}`,
				});
			continue;
		}
		for (const source of sources) {
			if (PUBLIC_SOURCES.has(source) || (parseCidr(source) !== undefined && !isPrivateCidr(source))) {
				violations.push({
					check: "public-allow",
					subject: nic,
					detail: `${rule.name} allows inbound from ${source}`,
				});
			} else if (!allowedSources.some((allowed) => allowed === source || cidrWithin(source, allowed))) {
				violations.push({
					check: "unlisted-source",
					subject: nic,
					detail: `${rule.name} allows inbound from ${source}`,
				});
			}
		}
	}
	return violations;
}

/**
 * @param {EffectiveRule} rule
 */
function isDefaultRule(rule) {
	return (
		rule.name === "defaultSecurityRules/AllowVnetInBound" ||
		rule.name === "defaultSecurityRules/AllowAzureLoadBalancerInBound"
	);
}
