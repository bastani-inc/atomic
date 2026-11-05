import assert from "node:assert/strict";
import { test } from "vitest";
import {
	allocateAddressSpaces,
	cidrsOverlap,
	cidrWithin,
	evaluateEffectiveRules,
	parseCidr,
	subnetOf,
	subnetRules,
} from "../distributed/harness/network.mjs";

test("parses CIDR blocks and rejects malformed ones", () => {
	assert.deepEqual(parseCidr("10.60.0.0/16"), { base: 0x0a3c0000, bits: 16 });
	assert.deepEqual(parseCidr("10.60.1.7/16"), { base: 0x0a3c0000, bits: 16 });
	assert.deepEqual(parseCidr("10.20.1.4"), { base: 0x0a140104, bits: 32 });
	assert.deepEqual(parseCidr("0.0.0.0/0"), { base: 0, bits: 0 });
	assert.deepEqual(parseCidr("255.255.255.255/32"), { base: 0xffffffff, bits: 32 });
	for (const bad of [
		"10.60.0.0/33",
		"256.1.1.1/8",
		"10.60.0/16",
		"Internet",
		"10.60.0.0/",
		" 10.60.0.0/16",
		"10.60.0.0/16 ",
	])
		assert.equal(parseCidr(bad), undefined, bad);
});

test("detects overlap and containment, treating unparseable input as overlapping", () => {
	assert.ok(cidrsOverlap("10.20.0.0/16", "10.20.1.0/24"));
	assert.ok(cidrsOverlap("10.20.1.0/24", "10.20.0.0/16"));
	assert.ok(!cidrsOverlap("10.60.0.0/16", "10.61.0.0/16"));
	assert.ok(cidrsOverlap("10.60.255.255/32", "10.60.0.0/16"));
	assert.ok(!cidrsOverlap("10.59.255.255/32", "10.60.0.0/16"));
	assert.ok(!cidrsOverlap("10.61.0.0/32", "10.60.0.0/16"));
	assert.ok(cidrsOverlap("10.0.0.0/8", "10.200.0.0/16"));
	assert.ok(cidrsOverlap("garbage", "10.60.0.0/16"));
	assert.ok(cidrsOverlap("10.60.0.0/16", "garbage"));
	assert.ok(cidrWithin("10.20.1.0/24", "10.20.0.0/16"));
	assert.ok(cidrWithin("10.20.0.0/16", "10.20.0.0/16"));
	assert.ok(!cidrWithin("10.20.0.0/16", "10.20.1.0/24"));
	assert.ok(!cidrWithin("10.21.0.0/24", "10.20.0.0/16"));
	assert.ok(!cidrWithin("10.19.255.0/24", "10.20.0.0/16"));
	assert.ok(!cidrWithin("x", "10.20.0.0/16"));
	assert.ok(!cidrWithin("10.20.0.0/16", "x"));
});

test("allocates one free /16 per distinct region from 10.60 upward", () => {
	const pool = { firstSecondOctet: 60, lastSecondOctet: 255 };
	assert.deepEqual(
		[...(allocateAddressSpaces(["eastus2", "westus3"], ["10.20.0.0/16"], pool) ?? [])],
		[
			["eastus2", "10.60.0.0/16"],
			["westus3", "10.61.0.0/16"],
		],
	);
	const used = ["10.20.0.0/16", "10.60.0.0/16", "10.62.128.0/24"];
	assert.deepEqual(
		[...(allocateAddressSpaces(["westus3", "eastus2", "westus3"], used, pool) ?? [])],
		[
			["westus3", "10.61.0.0/16"],
			["eastus2", "10.63.0.0/16"],
		],
	);
	assert.equal(allocateAddressSpaces(["a"], ["10.0.0.0/8"], pool), undefined);
	assert.equal(allocateAddressSpaces(["a", "b"], [], { firstSecondOctet: 255, lastSecondOctet: 255 }), undefined);
	assert.deepEqual(
		[...(allocateAddressSpaces(["a"], [], { firstSecondOctet: 255, lastSecondOctet: 255 }) ?? [])],
		[["a", "10.255.0.0/16"]],
	);
	assert.deepEqual([...(allocateAddressSpaces([], [], pool) ?? [])], []);
});

test("derives the subnet and host addresses from a region's /16", () => {
	const { subnet, host } = subnetOf("10.61.0.0/16");
	assert.equal(subnet, "10.61.0.0/24");
	assert.equal(host(10), "10.61.0.10");
	assert.equal(host(122), "10.61.0.122");
});

test("NSG rules deny Internet first, allow only SSH from control and database ports from run VNets", () => {
	const rules = subnetRules({
		sshSource: "10.20.1.0/24",
		runPrefixes: ["10.60.0.0/16", "10.61.0.0/16"],
		databaseHosts: ["10.60.0.10"],
		replicaHosts: ["10.61.0.11"],
		primaryHosts: ["10.60.0.10"],
		gatewayPort: 8443,
		replicationPort: 5001,
	});
	assert.deepEqual(rules, [
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
			sources: ["10.20.1.0/24"],
			destinations: ["VirtualNetwork"],
			ports: ["22"],
		},
		{
			name: "allow-sqld-gateway",
			priority: 210,
			direction: "Inbound",
			access: "Allow",
			protocol: "Tcp",
			sources: ["10.60.0.0/16", "10.61.0.0/16"],
			destinations: ["10.60.0.10/32"],
			ports: ["8443"],
		},
		{
			name: "allow-sqld-replication",
			priority: 220,
			direction: "Inbound",
			access: "Allow",
			protocol: "Tcp",
			sources: ["10.61.0.11/32"],
			destinations: ["10.60.0.10/32"],
			ports: ["5001"],
		},
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
	]);
	const nodeOnly = subnetRules({
		sshSource: "10.20.1.0/24",
		runPrefixes: ["10.60.0.0/16"],
		databaseHosts: [],
		replicaHosts: ["10.61.0.11"],
		primaryHosts: [],
		gatewayPort: 8443,
		replicationPort: 5001,
	});
	assert.deepEqual(
		nodeOnly.map((rule) => rule.name),
		["deny-internet-in", "allow-ssh-control", "deny-vnet-in", "deny-azure-lb-in", "deny-internet-out"],
	);
	const noReplica = subnetRules({
		sshSource: "s",
		runPrefixes: [],
		databaseHosts: ["10.60.0.10"],
		replicaHosts: [],
		primaryHosts: ["10.60.0.10"],
		gatewayPort: 1,
		replicationPort: 2,
	});
	assert.ok(!noReplica.some((rule) => rule.name === "allow-sqld-replication"));
});

/** Azure's effective-rule rows for a subnet NSG built from `subnetRules`, plus the defaults it inherits. */
function effective(overrides: Record<string, unknown>[] = []) {
	const rule = (
		name: string,
		priority: number,
		access: string,
		source: string,
		port = "0-65535",
		protocol = "All",
	) => ({
		name,
		priority,
		access,
		direction: "Inbound",
		protocol,
		sourceAddressPrefix: source,
		destinationPortRange: port,
	});
	return [
		rule("securityRules/deny-internet-in", 100, "Deny", "Internet"),
		{
			...rule("securityRules/allow-ssh-control", 200, "Allow", "", "22-22", "Tcp"),
			sourceAddressPrefix: undefined,
			sourceAddressPrefixes: ["10.20.1.0/24"],
		},
		{
			...rule("securityRules/allow-sqld-gateway", 210, "Allow", "", "8443-8443", "Tcp"),
			sourceAddressPrefixes: ["10.60.0.0/16", "10.61.0.0/16"],
		},
		rule("securityRules/deny-vnet-in", 4000, "Deny", "VirtualNetwork"),
		rule("securityRules/deny-azure-lb-in", 4010, "Deny", "AzureLoadBalancer"),
		rule("defaultSecurityRules/AllowVnetInBound", 65000, "Allow", "VirtualNetwork"),
		rule("defaultSecurityRules/AllowAzureLoadBalancerInBound", 65001, "Allow", "AzureLoadBalancer"),
		rule("defaultSecurityRules/DenyAllInBound", 65500, "Deny", "0.0.0.0/0"),
		{
			name: "defaultSecurityRules/AllowInternetOutBound",
			priority: 65001,
			access: "Allow",
			direction: "Outbound",
			protocol: "All",
			sourceAddressPrefix: "0.0.0.0/0",
			destinationPortRange: "0-65535",
		},
		...overrides,
	];
}
const allowed = ["10.20.1.0/24", "10.60.0.0/16", "10.61.0.0/16"];

test("accepts the harness's own effective rules", () => {
	assert.deepEqual(evaluateEffectiveRules("nic", effective(), allowed), []);
});

test("reports an Internet, star or public allow regardless of priority", () => {
	const allow = (source: string, priority = 300) => ({
		name: `securityRules/bad-${source}`,
		priority,
		access: "Allow",
		direction: "Inbound",
		protocol: "Tcp",
		sourceAddressPrefix: source,
		destinationPortRange: "22",
	});
	for (const source of ["Internet", "*", "0.0.0.0/0", "Any", "203.0.113.7/32", "Tag/Internet"]) {
		const violations = evaluateEffectiveRules("nic", effective([allow(source)]), allowed);
		assert.deepEqual(
			violations,
			[
				{
					check: "public-allow",
					subject: "nic",
					detail: `securityRules/bad-${source} allows inbound from ${source.replace("Tag/", "")}`,
				},
			],
			source,
		);
	}
	const early = evaluateEffectiveRules("nic", effective([allow("10.60.0.0/16", 50)]), allowed);
	assert.deepEqual(early, [
		{
			check: "internet-deny",
			subject: "nic",
			detail: "allow securityRules/bad-10.60.0.0/16 precedes the Internet deny",
		},
	]);
	const unlisted = evaluateEffectiveRules("nic", effective([allow("10.20.0.0/16")]), allowed);
	assert.deepEqual(unlisted, [
		{
			check: "unlisted-source",
			subject: "nic",
			detail: "securityRules/bad-10.20.0.0/16 allows inbound from 10.20.0.0/16",
		},
	]);
	assert.deepEqual(
		evaluateEffectiveRules("nic", effective([allow("172.16.5.0/24")]), allowed).map((v) => v.check),
		["unlisted-source"],
	);
	assert.deepEqual(
		evaluateEffectiveRules("nic", effective([allow("192.168.1.0/24")]), allowed).map((v) => v.check),
		["unlisted-source"],
	);
	assert.deepEqual(evaluateEffectiveRules("nic", effective([allow("10.60.0.20/32")]), allowed), []);
});

test("requires the Internet deny and overrides of the implicit allows", () => {
	const without = (name: string) => effective().filter((rule) => rule.name !== name);
	assert.deepEqual(evaluateEffectiveRules("nic", without("securityRules/deny-internet-in"), allowed), [
		{ check: "internet-deny", subject: "nic", detail: "no explicit inbound deny from Internet covering all traffic" },
	]);
	assert.deepEqual(evaluateEffectiveRules("nic", without("securityRules/deny-vnet-in"), allowed), [
		{
			check: "implicit-allow",
			subject: "nic",
			detail:
				"defaultSecurityRules/AllowVnetInBound is not overridden by a higher-priority deny from VirtualNetwork",
		},
	]);
	assert.deepEqual(evaluateEffectiveRules("nic", without("securityRules/deny-azure-lb-in"), allowed), [
		{
			check: "implicit-allow",
			subject: "nic",
			detail:
				"defaultSecurityRules/AllowAzureLoadBalancerInBound is not overridden by a higher-priority deny from AzureLoadBalancer",
		},
	]);
	const narrowDeny = effective().map((rule) =>
		rule.name === "securityRules/deny-vnet-in" ? { ...rule, destinationPortRange: "22" } : rule,
	);
	assert.equal(evaluateEffectiveRules("nic", narrowDeny, allowed)[0]?.check, "implicit-allow");
	const tcpOnly = effective().map((rule) =>
		rule.name === "securityRules/deny-internet-in" ? { ...rule, protocol: "Tcp" } : rule,
	);
	assert.equal(evaluateEffectiveRules("nic", tcpOnly, allowed)[0]?.check, "internet-deny");
	const starDeny = effective().map((rule) =>
		rule.name === "securityRules/deny-internet-in" ? { ...rule, protocol: "*", destinationPortRange: "*" } : rule,
	);
	assert.deepEqual(evaluateEffectiveRules("nic", starDeny, allowed), []);
	const listDeny = effective().map((rule) =>
		rule.name === "securityRules/deny-vnet-in"
			? { ...rule, destinationPortRange: undefined, destinationPortRanges: ["0-65535"] }
			: rule,
	);
	assert.deepEqual(evaluateEffectiveRules("nic", listDeny, allowed), []);
	const lateDeny = effective().map((rule) =>
		rule.name === "securityRules/deny-vnet-in" ? { ...rule, priority: 65100 } : rule,
	);
	assert.equal(evaluateEffectiveRules("nic", lateDeny, allowed)[0]?.check, "implicit-allow");
	const unprioritized = effective().map((rule) =>
		rule.name === "securityRules/deny-azure-lb-in" ? { ...rule, priority: undefined } : rule,
	);
	assert.equal(evaluateEffectiveRules("nic", unprioritized, allowed)[0]?.check, "implicit-allow");
	const outboundOnly = effective().map((rule) =>
		rule.name === "securityRules/deny-internet-in" ? { ...rule, direction: "Outbound" } : rule,
	);
	assert.equal(evaluateEffectiveRules("nic", outboundOnly, allowed)[0]?.check, "internet-deny");
	const allowInternet = effective().map((rule) =>
		rule.name === "securityRules/deny-internet-in" ? { ...rule, access: "Allow" } : rule,
	);
	assert.deepEqual(
		evaluateEffectiveRules("nic", allowInternet, allowed).map((v) => v.check),
		["internet-deny", "public-allow"],
	);
	assert.deepEqual(
		evaluateEffectiveRules("nic", [], allowed).map((v) => v.check),
		["internet-deny"],
	);
});
