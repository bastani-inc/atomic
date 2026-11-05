#!/usr/bin/env bash
# Deletes every Azure resource of a fork chaos run (#4321) and records the queries that prove nothing remains.
#
#   RUN_ID=<id> test/distributed/fork-chaos/teardown.sh
#
# Deletes the control VNet's side of every peering whose name carries the run id, then each run resource group (VMs,
# disks, NICs, NSGs, VNets and their peerings go with it), then verifies: no resource or group tagged with the run,
# no control-VNet peering naming the run, no VNet peering pointing at a deleted run VNet. Proof goes to
# $ARTIFACT_DIR/teardown-proof.json when ARTIFACT_DIR is set.
set -uo pipefail

: "${RUN_ID:?set RUN_ID}"
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

for peering in $(az network vnet peering list -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" --query "[?contains(name, '$RUN_ID')].name" -o tsv); do
	log "deleting control VNet peering $peering"
	az network vnet peering delete -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" -n "$peering" -o none
done

groups=$(az group list --query "[?tags.\"atomic-run\"=='$RUN_ID' || contains(name, '$RUN_ID')].name" -o tsv)
for group in $groups; do
	log "deleting resource group $group"
	az group delete -n "$group" --yes --no-wait
done
for group in $groups; do
	az group wait -n "$group" --deleted --timeout 3600 2>/dev/null || true
	log "resource group $group deleted"
done

# A subscription policy may have attached VNet flow logs (in the shared Network Watcher group) to the run's VNets; they
# are named after the VNet, so they carry the run id, and outlive it unless deleted.
for id in $(az resource list --resource-type Microsoft.Network/networkWatchers/flowLogs --query "[?contains(name, '$RUN_ID')].id" -o tsv); do
	log "deleting flow log ${id##*/}"
	az resource delete --ids "$id" -o none
done

resources=$(az resource list --tag "atomic-run=$RUN_ID" --query "length(@)" -o tsv)
named=$(az resource list --query "[?contains(name, '$RUN_ID') || contains(resourceGroup, '$RUN_ID')] | length(@)" -o tsv)
branch_resources=$(az resource list --tag "atomic-distributed-test=feat-issue-4321-fork-and-time-travel" --query "[?tags.\"atomic-run\"=='$RUN_ID'] | length(@)" -o tsv)
remaining_groups=$(az group list --query "[?tags.\"atomic-run\"=='$RUN_ID' || contains(name, '$RUN_ID')] | length(@)" -o tsv)
control_peerings=$(az network vnet peering list -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" --query "[?contains(name, '$RUN_ID')] | length(@)" -o tsv)
control_disconnected=$(az network vnet peering list -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" --query "[?contains(remoteVirtualNetwork.id, '$RUN_ID')] | length(@)" -o tsv)
public_ips=$(az network public-ip list --query "[?tags.\"atomic-run\"=='$RUN_ID' || contains(resourceGroup, '$RUN_ID')] | length(@)" -o tsv)
disks=$(az resource list --resource-type Microsoft.Compute/disks --query "[?contains(resourceGroup, '$RUN_ID') || tags.\"atomic-run\"=='$RUN_ID'] | length(@)" -o tsv)
# A query that failed leaves its count empty: the proof is then invalid JSON-wise and "clean" must not be claimed.
for count in resources named branch_resources remaining_groups control_peerings control_disconnected public_ips disks; do
	[[ "${!count}" =~ ^[0-9]+$ ]] || printf -v "$count" '"query failed"'
done
proof=$(
	cat <<EOF
{
  "runId": "$RUN_ID",
  "checkedAt": "$(date -u +%FT%TZ)",
  "queries": {
    "az resource list --tag atomic-run=$RUN_ID --query length(@)": $resources,
    "az resource list --query [?contains(name,'$RUN_ID') || contains(resourceGroup,'$RUN_ID')] | length(@)": $named,
    "az resource list --tag atomic-distributed-test=feat-issue-4321-fork-and-time-travel --query [?tags.atomic-run=='$RUN_ID'] | length(@)": $branch_resources,
    "az group list --query [?tags.atomic-run=='$RUN_ID' || contains(name,'$RUN_ID')] | length(@)": $remaining_groups,
    "az network vnet peering list -g <control resource group> --vnet-name <control vnet> --query [?contains(name,'$RUN_ID')] | length(@)": $control_peerings,
    "az network vnet peering list -g <control resource group> --vnet-name <control vnet> --query [?contains(remoteVirtualNetwork.id,'$RUN_ID')] | length(@)": $control_disconnected,
    "az network public-ip list --query [?tags.atomic-run=='$RUN_ID' || contains(resourceGroup,'$RUN_ID')] | length(@)": $public_ips,
    "az resource list --resource-type Microsoft.Compute/disks --query [?contains(resourceGroup,'$RUN_ID') || tags.atomic-run=='$RUN_ID'] | length(@)": $disks
  },
  "clean": $([ "$resources$named$branch_resources$remaining_groups$control_peerings$control_disconnected$public_ips$disks" = "00000000" ] && echo true || echo false)
}
EOF
)
echo "$proof" | tee "$STATE_DIR/teardown-proof.json"
[ -n "$ARTIFACT_DIR" ] && echo "$proof" >"$ARTIFACT_DIR/teardown-proof.json"
log "teardown verification written"
