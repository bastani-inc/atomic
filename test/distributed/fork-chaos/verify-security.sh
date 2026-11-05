#!/usr/bin/env bash
# Mandatory pre-test security verification of the fork chaos topology (#4321), per the network security contract:
#   1. az vm list-ip-addresses: zero public IPs on every run VM (and no public IP or load balancer in the run groups);
#   2. effective NSG rules of every run NIC: no inbound Allow from Internet or *;
#   3. from nodes in two regions: sqld rejects requests without a token and without TLS, and nodes verify its
#      certificate against the per-run CA (curl and the Atomic libSQL client stack);
#   4. sqld is unreachable from outside the run's peered test VNets: it listens on its private IP (TLS) and loopback
#      only, has no public endpoint, and the peered control host (not an allowed source) cannot open its port.
# Writes security-verification.json to $ARTIFACT_DIR (or $STATE_DIR) and exits non-zero when any check fails.
#
#   RUN_ID=<id> test/distributed/fork-chaos/verify-security.sh
set -uo pipefail

: "${RUN_ID:?set RUN_ID}"
STATE_DIR="${STATE_DIR:-$HOME/.fork-chaos/$RUN_ID}"
OUT_DIR="${ARTIFACT_DIR:-$STATE_DIR}"
MANIFEST="$STATE_DIR/manifest.json"
SSH_OPTS=(-i "$STATE_DIR/ssh_key" -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$STATE_DIR/known_hosts"
	-o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR)
ip_of() { jq -r --arg n "$1" '.nodes[] | select(.name == $n) | .ip' "$MANIFEST"; }
remote() { ssh "${SSH_OPTS[@]}" "azureuser@$(ip_of "$1")" "${@:2}"; }
SQLD_IP=$(ip_of sqld)
failures=()
fail() { failures+=("$1"); echo "FAIL: $1" >&2; }

# 1. Public IPs.
vm_ips='[]'
public_ip_resources=0
load_balancers=0
for rg in $(jq -r '.regions[].resourceGroup' "$MANIFEST"); do
	vm_ips=$(jq -s 'add' <(echo "$vm_ips") <(az vm list-ip-addresses -g "$rg" -o json))
	public_ip_resources=$((public_ip_resources + $(az network public-ip list -g "$rg" --query "length(@)" -o tsv)))
	load_balancers=$((load_balancers + $(az network lb list -g "$rg" --query "length(@)" -o tsv)))
done
public_ip_count=$(jq '[.[].virtualMachine.network.publicIpAddresses[]?] | length' <<<"$vm_ips")
vm_count=$(jq 'length' <<<"$vm_ips")
[ "$public_ip_count" -eq 0 ] || fail "VMs have $public_ip_count public IPs"
[ "$public_ip_resources" -eq 0 ] || fail "$public_ip_resources public IP resources exist in the run groups"
[ "$load_balancers" -eq 0 ] || fail "$load_balancers load balancers exist in the run groups"
private_ips=$(jq -c '[.[] | {vm: .virtualMachine.name, private: [.virtualMachine.network.privateIpAddresses[]], public: [.virtualMachine.network.publicIpAddresses[]?]}]' <<<"$vm_ips")

# 2. Effective NSG rules on every NIC.
nic_reports='[]'
for rg in $(jq -r '.regions[].resourceGroup' "$MANIFEST"); do
	for nic in $(az network nic list -g "$rg" --query "[].name" -o tsv); do
		effective=$(az network nic list-effective-nsg -g "$rg" -n "$nic" -o json)
		report=$(jq --arg nic "$nic" '
			[.value[]?.effectiveSecurityRules[]? | select(.direction == "Inbound")] as $in
			| {
				nic: $nic,
				internetOrAnyInboundAllows: [$in[] | select(.access == "Allow") | select(
					((.sourceAddressPrefix // "") | IN("*", "Internet", "0.0.0.0/0"))
					or ((.sourceAddressPrefixes // []) | any(IN("*", "Internet", "0.0.0.0/0")))) | .name],
				inboundAllows: [$in[] | select(.access == "Allow") | {name, priority, sources: ((.sourceAddressPrefixes // []) + [.sourceAddressPrefix // empty] | unique), ports: ((.destinationPortRanges // []) + [.destinationPortRange // empty] | unique)}],
				explicitDenies: [$in[] | select(.access == "Deny") | {name, priority, sources: ((.sourceAddressPrefixes // []) + [.sourceAddressPrefix // empty] | unique)}]
			}' <<<"$effective")
		bad=$(jq '.internetOrAnyInboundAllows | length' <<<"$report")
		[ "$bad" -eq 0 ] || fail "NIC $nic has inbound allows from Internet/*"
		for rule in deny-internet-in deny-vnet-in deny-lb-in; do
			jq -e --arg r "$rule" '[.explicitDenies[].name] | any(endswith($r))' <<<"$report" >/dev/null || fail "NIC $nic lacks $rule"
		done
		nic_reports=$(jq -c --argjson r "$report" '. + [$r]' <<<"$nic_reports")
	done
done

# 3. sqld rejects missing token and plain HTTP; nodes verify TLS. Run from two regions.
probe_script=$(
	cat <<EOF
set -u
url=https://$SQLD_IP:8443/v2/pipeline
body='{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}'
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "\$@"; }
with_token=\$(code --cacert /opt/fork-chaos/tls/ca.crt -H @<(printf 'Authorization: Bearer %s\n' "\$(cat /opt/fork-chaos/secrets/sqld.token)") -X POST -d "\$body" "\$url")
without_token=\$(code --cacert /opt/fork-chaos/tls/ca.crt -X POST -d "\$body" "\$url")
plain_http=\$(code -X POST -d "\$body" "http://$SQLD_IP:8443/v2/pipeline")
curl -s -o /dev/null --max-time 10 -X POST -d "\$body" "\$url"; untrusted_ca_exit=\$?
curl -s -o /dev/null --max-time 5 "http://$SQLD_IP:8080/"; backend_port_exit=\$?
cd /opt/fork-chaos/repo && source /opt/fork-chaos/env
client=\$(timeout 60 bun run test/distributed/fork-chaos/workload.ts tlscheck 2>/dev/null | tail -1)
client_no_ca=\$(env -u NODE_EXTRA_CA_CERTS timeout 60 bun run test/distributed/fork-chaos/workload.ts tlscheck 2>/dev/null | tail -1)
printf '{"withTokenAndCa": "%s", "withoutToken": "%s", "plainHttpToTlsPort": "%s", "curlWithoutRunCaExit": %s, "sqldBackendPort8080Exit": %s, "atomicClient": %s, "atomicClientWithoutRunCa": %s}\n' \
	"\$with_token" "\$without_token" "\$plain_http" "\$untrusted_ca_exit" "\$backend_port_exit" "\${client:-null}" "\${client_no_ca:-null}"
EOF
)
probes='{}'
for name in a b; do
	result=$(remote "$name" "bash -s" <<<"$probe_script")
	if ! jq -e . >/dev/null 2>&1 <<<"$result"; then
		fail "probe from $name returned no JSON"
		continue
	fi
	probes=$(jq -c --arg n "$name" --argjson r "$result" '. + {($n): $r}' <<<"$probes")
	jq -e '.withTokenAndCa == "200"' <<<"$result" >/dev/null || fail "$name: authorized TLS request did not succeed"
	jq -e '.withoutToken == "401"' <<<"$result" >/dev/null || fail "$name: request without token was not rejected with 401"
	jq -e '.plainHttpToTlsPort != "200"' <<<"$result" >/dev/null || fail "$name: plain HTTP was accepted"
	jq -e '.curlWithoutRunCaExit == 60' <<<"$result" >/dev/null || fail "$name: certificate not verified against the run CA"
	jq -e '.sqldBackendPort8080Exit != 0' <<<"$result" >/dev/null || fail "$name: sqld backend port reachable"
	jq -e '.atomicClient.withTokenAndCa == "ok"' <<<"$result" >/dev/null || fail "$name: Atomic client with token failed"
	jq -e '.atomicClient.withoutToken.rejected == true' <<<"$result" >/dev/null || fail "$name: Atomic client without token accepted"
	jq -e '.atomicClient.plainHttpWithoutTls.rejected == true' <<<"$result" >/dev/null || fail "$name: Atomic client over plain HTTP accepted"
	jq -e '.atomicClientWithoutRunCa.withTokenAndCa != "ok"' <<<"$result" >/dev/null || fail "$name: Atomic client accepted sqld without the run CA"
done

# 4. Not reachable from outside the run's test VNets.
listeners=$(remote sqld "ss -ltnH | awk '{print \$4}' | sort -u | paste -sd, -")
for listener in ${listeners//,/ }; do
	case "$listener" in
		"$SQLD_IP:8443" | 0.0.0.0:22 | "[::]:22" | 127.* | "[::1]:"*) ;;
		*) fail "sqld VM listens on $listener" ;;
	esac
done
if timeout 8 bash -c "exec 3<>/dev/tcp/$SQLD_IP/8443" 2>/dev/null; then
	control_reach="connected"
	fail "the control host (peered, not an allowed source) reached sqld:8443"
else
	control_reach="blocked"
fi
sqld_nic_public=$(jq --arg ip "$SQLD_IP" '[.[] | select(.virtualMachine.network.privateIpAddresses | index($ip)) | .virtualMachine.network.publicIpAddresses[]?] | length' <<<"$vm_ips")

passed=true
[ "${#failures[@]}" -eq 0 ] || passed=false
jq -n --arg run "$RUN_ID" --argjson passed "$passed" --argjson vms "$vm_count" --argjson pub "$public_ip_count" \
	--argjson pubres "$public_ip_resources" --argjson lbs "$load_balancers" --argjson ips "$private_ips" \
	--argjson nics "$nic_reports" --argjson probes "$probes" --arg listeners "$listeners" --arg control "$control_reach" \
	--argjson sqldpub "$sqld_nic_public" --args '{
		runId: $run, checkedAt: (now | todate), passed: $passed,
		publicIps: {query: "az vm list-ip-addresses -g <each run group>", vms: $vms, publicIpCount: $pub, publicIpResources: $pubres, loadBalancers: $lbs, addresses: $ips},
		effectiveNsg: {query: "az network nic list-effective-nsg (every run NIC)", nics: $nics},
		sqldAuthAndTls: $probes,
		sqldExposure: {sqldNicPublicIps: $sqldpub, sqldListeners: ($listeners | split(",")), controlHostPeeredButNotAllowedTcp8443: $control},
		failures: $ARGS.positional
	}' "${failures[@]}" >"$OUT_DIR/security-verification.json"
cat "$OUT_DIR/security-verification.json" | jq '{passed, failures}'
[ "$passed" = true ]
