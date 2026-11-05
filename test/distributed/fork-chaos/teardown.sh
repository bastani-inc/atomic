#!/usr/bin/env bash
# Deletes every Azure resource of a fork chaos run (#4321) and records the queries that prove nothing remains.
#
#   RUN_ID=<id> test/distributed/fork-chaos/teardown.sh
#
# Selects only what provision.sh created for this run, never anything whose name merely contains the run id:
#   - resource groups tagged atomic-run=<run> and atomic-distributed-test=<branch tag> (exact tag values);
#   - control VNet peerings named exactly atomic-dt-<run>-<region> that point at the run's VNet in that region;
#   - VNet flow logs whose target is a run VNet (/resourceGroups/atomic-dt-4321-<run>-<region>/.../fc-<run>-vnet-<region>).
# Azure region names are lowercase letters and digits, so a name whose remainder after the run prefix holds a hyphen
# belongs to another run whose id starts with this one (demo vs. demo-production) and is left alone.
# Then verifies with the same selectors: no resource or group of the run, no control-VNet peering of the run, no VNet
# peering pointing at a deleted run VNet. Proof goes to $ARTIFACT_DIR/teardown-proof.json when ARTIFACT_DIR is set.
# Exits 1 when the proof is not clean (something of the run remains, or a verification query failed).
set -uo pipefail

: "${RUN_ID:?set RUN_ID}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || {
	echo "error: RUN_ID must be letters, digits and hyphens, as provision.sh used it in resource names." >&2
	exit 2
}
BRANCH_TAG="${BRANCH_TAG:-feat-issue-4321-fork-and-time-travel}"
STATE_DIR="${STATE_DIR:-$HOME/.fork-chaos/$RUN_ID}"
ARTIFACT_DIR="${ARTIFACT_DIR:-}"
# The control host's network is environment-specific and comes from the environment, never from this file.
require() { [ -n "${!1:-}" ] || { echo "error: $1 is not set. $2" >&2; exit 2; }; }
require ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP "Set it to the resource group of the control host's VNet; the run's VNets are peered with that VNet."
require ATOMIC_DISTRIBUTED_CONTROL_VNET "Set it to the name of the control host's VNet."
CONTROL_RG="$ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP"
CONTROL_VNET="$ATOMIC_DISTRIBUTED_CONTROL_VNET"
SUBSCRIPTION="${SUBSCRIPTION:-}"

[ -z "$SUBSCRIPTION" ] || az account set --subscription "$SUBSCRIPTION"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$STATE_DIR/teardown.log" >&2; }
mkdir -p "$STATE_DIR"

run="${RUN_ID,,}"
RG_PREFIX="atomic-dt-4321-$run-"
PEERING_PREFIX="atomic-dt-$run-"

# Prints the region of a name provision.sh built as <prefix><region>; fails for any other name.
region_after() {
	local name="${1,,}" prefix="$2"
	[[ "$name" == "$prefix"* ]] || return 1
	local region="${name#"$prefix"}"
	[[ "$region" =~ ^[a-z0-9]+$ ]] || return 1
	printf '%s' "$region"
}
is_run_group() { region_after "$1" "$RG_PREFIX" >/dev/null; }
# Prints the region of a resource id naming the run's VNet in that region; fails for any other id.
run_vnet_region() {
	local id="${1,,}" region
	[[ "$id" =~ ^/subscriptions/[^/]+/resourcegroups/([^/]+)/providers/microsoft\.network/virtualnetworks/([^/]+)$ ]] || return 1
	region=$(region_after "${BASH_REMATCH[1]}" "$RG_PREFIX") || return 1
	[ "${BASH_REMATCH[2]}" = "fc-$run-vnet-$region" ] || return 1
	printf '%s' "$region"
}
is_run_control_peering() {
	local region target
	region=$(region_after "$1" "$PEERING_PREFIX") || return 1
	target=$(run_vnet_region "$2") || return 1
	[ "$region" = "$target" ]
}

# Fixed queries: the run id never enters a JMESPath filter. '-' stands for a missing value so no TSV field is empty.
control_peerings() {
	az network vnet peering list -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" \
		--query "[].[name, remoteVirtualNetwork.id || '-']" -o tsv
}
all_groups() {
	az group list --query "[].[name, tags.\"atomic-run\" || '-', tags.\"atomic-distributed-test\" || '-']" -o tsv
}

if peerings=$(control_peerings); then
	while IFS=$'\t' read -r name remote; do
		[ -n "$name" ] && is_run_control_peering "$name" "$remote" || continue
		log "deleting control VNet peering $name"
		az network vnet peering delete -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" -n "$name" -o none
	done <<<"$peerings"
else
	log "listing the control VNet's peerings failed; none deleted"
fi

groups=()
if listed=$(all_groups); then
	while IFS=$'\t' read -r name run_tag branch_tag; do
		[ -n "$name" ] && [ "$run_tag" = "$RUN_ID" ] && [ "$branch_tag" = "$BRANCH_TAG" ] && groups+=("$name")
	done <<<"$listed"
else
	log "listing resource groups failed; none deleted"
fi
for group in "${groups[@]}"; do
	log "deleting resource group $group"
	az group delete -n "$group" --yes --no-wait
done
for group in "${groups[@]}"; do
	az group wait -n "$group" --deleted --timeout 3600 2>/dev/null || true
	log "resource group $group deleted"
done

# A subscription policy may have attached VNet flow logs (in the shared Network Watcher group) to the run's VNets; they
# outlive the run unless deleted. Only a flow log whose target is a run VNet is the run's. A failure here leaves the
# flow log in place, and the flow-log count of the proof below reports it.
flow_log_ids() { az resource list --resource-type Microsoft.Network/networkWatchers/flowLogs --query "[].id" -o tsv; }
flow_log_target() { az resource show --ids "$1" --query "properties.targetResourceId" -o tsv; }
if flow_logs=$(flow_log_ids); then
	while read -r id; do
		[ -n "$id" ] || continue
		target=$(flow_log_target "$id") || {
			log "reading flow log ${id##*/} failed; not deleted"
			continue
		}
		run_vnet_region "$target" >/dev/null || continue
		log "deleting flow log ${id##*/}"
		az resource delete --ids "$id" -o none || log "deleting flow log ${id##*/} failed"
	done <<<"$flow_logs"
else
	log "listing flow logs failed; none deleted"
fi

# Verification. A query that failed leaves its count as "query failed", and "clean" is then never claimed.
count_resources() {
	local listed group type run_tag branch_tag
	resources=0 named=0 branch_resources=0 public_ips=0 disks=0
	listed=$(az resource list --query "[].[resourceGroup, type, tags.\"atomic-run\" || '-', tags.\"atomic-distributed-test\" || '-']" -o tsv) || {
		resources='"query failed"' named='"query failed"' branch_resources='"query failed"' public_ips='"query failed"' disks='"query failed"'
		return
	}
	while IFS=$'\t' read -r group type run_tag branch_tag; do
		[ -n "$group" ] || continue
		local tagged=0 in_group=0
		[ "$run_tag" = "$RUN_ID" ] && tagged=1
		is_run_group "$group" && in_group=1
		resources=$((resources + tagged))
		named=$((named + in_group))
		[ "$tagged" = 1 ] && [ "$branch_tag" = "$BRANCH_TAG" ] && branch_resources=$((branch_resources + 1))
		if [ "$tagged" = 1 ] || [ "$in_group" = 1 ]; then
			[ "${type,,}" = "microsoft.network/publicipaddresses" ] && public_ips=$((public_ips + 1))
			[ "${type,,}" = "microsoft.compute/disks" ] && disks=$((disks + 1))
		fi
	done <<<"$listed"
}
count_groups() {
	local listed name run_tag branch_tag
	remaining_groups=0
	listed=$(all_groups) || { remaining_groups='"query failed"'; return; }
	while IFS=$'\t' read -r name run_tag branch_tag; do
		[ -n "$name" ] || continue
		if [ "$run_tag" = "$RUN_ID" ] || is_run_group "$name"; then remaining_groups=$((remaining_groups + 1)); fi
	done <<<"$listed"
}
count_peerings() {
	local listed name remote
	control_peering_count=0 control_disconnected=0
	listed=$(control_peerings) || { control_peering_count='"query failed"' control_disconnected='"query failed"'; return; }
	while IFS=$'\t' read -r name remote; do
		[ -n "$name" ] || continue
		region_after "$name" "$PEERING_PREFIX" >/dev/null && control_peering_count=$((control_peering_count + 1))
		run_vnet_region "$remote" >/dev/null && control_disconnected=$((control_disconnected + 1))
	done <<<"$listed"
}
# Flow logs whose target is a run VNet. A flow log whose target cannot be read might be the run's, so it makes the
# count "query failed" as a failed listing does.
count_flow_logs() {
	local listed id target
	run_flow_logs=0
	listed=$(flow_log_ids) || { run_flow_logs='"query failed"'; return; }
	while read -r id; do
		[ -n "$id" ] || continue
		target=$(flow_log_target "$id") || { run_flow_logs='"query failed"'; return; }
		run_vnet_region "$target" >/dev/null && run_flow_logs=$((run_flow_logs + 1))
	done <<<"$listed"
}
count_resources
count_groups
count_peerings
count_flow_logs
all_counts="$resources$named$branch_resources$remaining_groups$control_peering_count$control_disconnected$public_ips$disks$run_flow_logs"
proof=$(
	cat <<EOF
{
  "runId": "$RUN_ID",
  "checkedAt": "$(date -u +%FT%TZ)",
  "queries": {
    "az resource list: resources tagged atomic-run=$RUN_ID": $resources,
    "az resource list: resources in a group named atomic-dt-4321-$RUN_ID-<region>": $named,
    "az resource list: resources tagged atomic-run=$RUN_ID and atomic-distributed-test=$BRANCH_TAG": $branch_resources,
    "az group list: groups tagged atomic-run=$RUN_ID or named atomic-dt-4321-$RUN_ID-<region>": $remaining_groups,
    "az network vnet peering list -g <control resource group> --vnet-name <control vnet>: peerings named atomic-dt-$RUN_ID-<region>": $control_peering_count,
    "az network vnet peering list -g <control resource group> --vnet-name <control vnet>: peerings to a run VNet": $control_disconnected,
    "az resource list: public IPs tagged atomic-run=$RUN_ID or in a run group": $public_ips,
    "az resource list: disks tagged atomic-run=$RUN_ID or in a run group": $disks,
    "az resource list --resource-type Microsoft.Network/networkWatchers/flowLogs: flow logs targeting a run VNet": $run_flow_logs
  },
  "clean": $([ "$all_counts" = "000000000" ] && echo true || echo false)
}
EOF
)
echo "$proof" | tee "$STATE_DIR/teardown-proof.json"
[ -n "$ARTIFACT_DIR" ] && echo "$proof" >"$ARTIFACT_DIR/teardown-proof.json"
log "teardown verification written"
if [ "$all_counts" != "000000000" ]; then
	log "error: resources of run $RUN_ID remain or a verification query failed; see teardown-proof.json and run teardown again"
	exit 1
fi
