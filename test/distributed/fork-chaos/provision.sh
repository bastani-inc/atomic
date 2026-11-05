#!/usr/bin/env bash
# Brings up the private, multi-region Azure topology of the fork chaos scenario (#4321).
#
#   RUN_ID=<id> test/distributed/fork-chaos/provision.sh
#
# Creates, per region, a resource group, a dedicated /16 VNet, subnet NSGs (explicit high-priority Deny from Internet,
# SSH only from the control host's prefix, sqld TLS only from the run's test VNets, explicit Deny from VirtualNetwork
# and AzureLoadBalancer), global peerings between the test VNets and with the control host's VNet (both sides), and VMs
# with no public IP.
#
# Required environment: ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP and ATOMIC_DISTRIBUTED_CONTROL_VNET (the control
# host's VNet the run peers with) and ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX (the CIDR SSH is allowed from). Optional:
# SUBSCRIPTION (default: the current az account), REGIONS, PREFIXES, WORKER_REGIONS, VM_SIZES. Every taggable resource carries atomic-distributed-test, atomic-run and atomic-expires tags. The manifest and the
# per-run SSH key live in $STATE_DIR (mode 700); a copy of the manifest without secrets goes to $ARTIFACT_DIR.
set -euo pipefail

: "${RUN_ID:?set RUN_ID}"
BRANCH_TAG="${BRANCH_TAG:-feat-issue-4321-fork-and-time-travel}"
STATE_DIR="${STATE_DIR:-$HOME/.fork-chaos/$RUN_ID}"
ARTIFACT_DIR="${ARTIFACT_DIR:-}"
# The control host's network is environment-specific and comes from the environment, never from this file.
require() { [ -n "${!1:-}" ] || { echo "error: $1 is not set. $2" >&2; exit 2; }; }
require ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP "Set it to the resource group of the control host's VNet; the run's VNets are peered with that VNet."
require ATOMIC_DISTRIBUTED_CONTROL_VNET "Set it to the name of the control host's VNet."
CONTROL_RG="$ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP"
CONTROL_VNET="$ATOMIC_DISTRIBUTED_CONTROL_VNET"
require ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX "Set it to the CIDR of the control host's subnet; it is the only source allowed to SSH to the VMs."
CONTROL_SSH_PREFIX="$ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX"
SUBSCRIPTION="${SUBSCRIPTION:-}"
REGIONS=(${REGIONS:-westus3 centralus eastus})
PREFIXES=(${PREFIXES:-10.64 10.65 10.66})
# Sizes tried in order per VM: regional capacity for a size comes and goes (SkuNotAvailable at preflight).
VM_SIZES=(${VM_SIZES:-Standard_D4s_v5 Standard_D4as_v5 Standard_D4ds_v5 Standard_D4s_v4 Standard_D4as_v4})
VM_SIZE="${VM_SIZES[0]}"
IMAGE="${IMAGE:-Canonical:ubuntu-26_04-lts:server:latest}"
SQLD_PORT=8443
EXPIRES="$(date -u -d '+12 hours' +%Y-%m-%dT%H:%MZ)"
TAGS=("atomic-distributed-test=$BRANCH_TAG" "atomic-run=$RUN_ID" "atomic-expires=$EXPIRES")

[ -z "$SUBSCRIPTION" ] || az account set --subscription "$SUBSCRIPTION"
umask 077
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$STATE_DIR/provision.log" >&2; }

rg_of() { echo "atomic-dt-4321-$RUN_ID-$1"; }
vnet_of() { echo "fc-$RUN_ID-vnet-$1"; }

# Address spaces must not overlap the control VNet or anything already peered with it.
existing=$(az network vnet peering list -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" --query "[].remoteAddressSpace.addressPrefixes[]" -o tsv)
for prefix in "${PREFIXES[@]}"; do
	if [ "${SKIP_NETWORK:-0}" != 1 ] && grep -q "^$prefix\." <<<"$existing" &&
		! az network vnet peering list -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" --query "[?contains(name, '$RUN_ID')].remoteAddressSpace.addressPrefixes[]" -o tsv | grep -q "^$prefix\."; then
		log "address space $prefix.0.0/16 is already peered with the control VNet; pick other PREFIXES"
		exit 1
	fi
done

if [ ! -f "$STATE_DIR/ssh_key" ]; then
	ssh-keygen -q -t ed25519 -N "" -C "fork-chaos-$RUN_ID" -f "$STATE_DIR/ssh_key"
fi
chmod 600 "$STATE_DIR/ssh_key"

test_vnet_spaces=()
for prefix in "${PREFIXES[@]}"; do test_vnet_spaces+=("$prefix.0.0/16"); done

if [ "${SKIP_NETWORK:-0}" != 1 ]; then
for index in "${!REGIONS[@]}"; do
	region="${REGIONS[$index]}"
	prefix="${PREFIXES[$index]}"
	rg=$(rg_of "$region")
	vnet=$(vnet_of "$region")
	if az network vnet show -g "$rg" -n "$vnet" -o none 2>/dev/null; then
		log "vnet $vnet exists"
		continue
	fi
	log "resource group $rg ($region)"
	az group create -n "$rg" -l "$region" --tags "${TAGS[@]}" -o none
	for subnet in work db; do
		[ "$subnet" = db ] && [ "$index" -ne 0 ] && continue
		nsg="fc-$RUN_ID-nsg-$subnet-$region"
		az network nsg create -g "$rg" -n "$nsg" -l "$region" --tags "${TAGS[@]}" -o none
		az network nsg rule create -g "$rg" --nsg-name "$nsg" -n deny-internet-in --priority 100 --direction Inbound \
			--access Deny --protocol '*' --source-address-prefixes Internet --source-port-ranges '*' \
			--destination-address-prefixes '*' --destination-port-ranges '*' -o none
		az network nsg rule create -g "$rg" --nsg-name "$nsg" -n allow-ssh-control --priority 200 --direction Inbound \
			--access Allow --protocol Tcp --source-address-prefixes "$CONTROL_SSH_PREFIX" --source-port-ranges '*' \
			--destination-address-prefixes '*' --destination-port-ranges 22 -o none
		if [ "$subnet" = db ]; then
			az network nsg rule create -g "$rg" --nsg-name "$nsg" -n allow-sqld-tls-from-test-vnets --priority 210 \
				--direction Inbound --access Allow --protocol Tcp --source-address-prefixes "${test_vnet_spaces[@]}" \
				--source-port-ranges '*' --destination-address-prefixes "$prefix.1.0/24" \
				--destination-port-ranges "$SQLD_PORT" -o none
		fi
		az network nsg rule create -g "$rg" --nsg-name "$nsg" -n deny-vnet-in --priority 4000 --direction Inbound \
			--access Deny --protocol '*' --source-address-prefixes VirtualNetwork --source-port-ranges '*' \
			--destination-address-prefixes '*' --destination-port-ranges '*' -o none
		az network nsg rule create -g "$rg" --nsg-name "$nsg" -n deny-lb-in --priority 4010 --direction Inbound \
			--access Deny --protocol '*' --source-address-prefixes AzureLoadBalancer --source-port-ranges '*' \
			--destination-address-prefixes '*' --destination-port-ranges '*' -o none
	done
	log "vnet $vnet $prefix.0.0/16"
	az network vnet create -g "$rg" -n "$vnet" -l "$region" --address-prefixes "$prefix.0.0/16" --tags "${TAGS[@]}" -o none
	az network vnet subnet create -g "$rg" --vnet-name "$vnet" -n work --address-prefixes "$prefix.2.0/24" \
		--network-security-group "fc-$RUN_ID-nsg-work-$region" --default-outbound-access true -o none
	if [ "$index" -eq 0 ]; then
		az network vnet subnet create -g "$rg" --vnet-name "$vnet" -n db --address-prefixes "$prefix.1.0/24" \
			--network-security-group "fc-$RUN_ID-nsg-db-$region" --default-outbound-access true -o none
	fi
done

# The sqld rule admits exactly the run's current test VNets (also when a region was added on a re-run).
az network nsg rule update -g "$(rg_of "${REGIONS[0]}")" --nsg-name "fc-$RUN_ID-nsg-db-${REGIONS[0]}" \
	-n allow-sqld-tls-from-test-vnets --source-address-prefixes "${test_vnet_spaces[@]}" -o none

vnet_id() { az network vnet show -g "$(rg_of "$1")" -n "$(vnet_of "$1")" --query id -o tsv; }
CONTROL_VNET_ID=$(az network vnet show -g "$CONTROL_RG" -n "$CONTROL_VNET" --query id -o tsv)
for region in "${REGIONS[@]}"; do
	id=$(vnet_id "$region")
	if ! az network vnet peering show -g "$(rg_of "$region")" --vnet-name "$(vnet_of "$region")" -n "fc-$RUN_ID-$region-to-control" -o none 2>/dev/null; then
		log "peering $region -> control VNet"
		az network vnet peering create -g "$(rg_of "$region")" --vnet-name "$(vnet_of "$region")" \
			-n "fc-$RUN_ID-$region-to-control" --remote-vnet "$CONTROL_VNET_ID" --allow-vnet-access true -o none
	fi
	if ! az network vnet peering show -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" -n "atomic-dt-$RUN_ID-$region" -o none 2>/dev/null; then
		log "peering control VNet -> $region"
		az network vnet peering create -g "$CONTROL_RG" --vnet-name "$CONTROL_VNET" -n "atomic-dt-$RUN_ID-$region" \
			--remote-vnet "$id" --allow-vnet-access true -o none
	fi
done
for left in "${!REGIONS[@]}"; do
	for right in "${!REGIONS[@]}"; do
		[ "$left" -ge "$right" ] && continue
		a="${REGIONS[$left]}"
		b="${REGIONS[$right]}"
		for pair in "$a $b" "$b $a"; do
			read -r from to <<<"$pair"
			az network vnet peering show -g "$(rg_of "$from")" --vnet-name "$(vnet_of "$from")" -n "fc-$RUN_ID-$from-to-$to" \
				-o none 2>/dev/null && continue
			log "peering $from -> $to"
			az network vnet peering create -g "$(rg_of "$from")" --vnet-name "$(vnet_of "$from")" -n "fc-$RUN_ID-$from-to-$to" \
				--remote-vnet "$(vnet_id "$to")" --allow-vnet-access true -o none
		done
	done
done

fi

# role name region subnet ip. WORKER_REGIONS gives each worker's region index (a b c d); sqld is in region 0.
read -r -a WORKER_REGIONS <<<"${WORKER_REGIONS:-0 1 1 2}"
NODES=("sqld sqld ${REGIONS[0]} db ${PREFIXES[0]}.1.4")
declare -A next_host
for index in "${!WORKER_REGIONS[@]}"; do
	name=$(printf "\\x$(printf %x $((97 + index)))")
	region_index="${WORKER_REGIONS[$index]}"
	host="${next_host[$region_index]:-4}"
	next_host[$region_index]=$((host + 1))
	NODES+=("worker $name ${REGIONS[$region_index]} work ${PREFIXES[$region_index]}.2.$host")
done
for node in "${NODES[@]}"; do
	read -r role name region subnet ip <<<"$node"
	extra=()
	[ "$role" = sqld ] && extra=(--data-disk-sizes-gb 8 --data-disk-caching None --data-disk-delete-option Delete)
	if az vm show -g "$(rg_of "$region")" -n "fc-$RUN_ID-$name" -o none 2>/dev/null; then
		log "vm fc-$RUN_ID-$name exists"
		continue
	fi
	created=0
	for size in "${VM_SIZES[@]}"; do
		log "vm fc-$RUN_ID-$name ($role, $region, $ip, $size)"
		if az vm create -g "$(rg_of "$region")" -n "fc-$RUN_ID-$name" -l "$region" --image "$IMAGE" --size "$size" \
			--vnet-name "$(vnet_of "$region")" --subnet "$subnet" --private-ip-address "$ip" \
			--public-ip-address "" --nsg "" --admin-username azureuser --ssh-key-values "$STATE_DIR/ssh_key.pub" \
			--authentication-type ssh --storage-sku Premium_LRS --os-disk-delete-option Delete \
			--nic-delete-option Delete --tags "${TAGS[@]}" "${extra[@]}" --no-wait -o none 2>"$STATE_DIR/vm-$name.err"; then
			created=1
			break
		fi
		log "size $size unavailable for fc-$RUN_ID-$name: $(grep -o 'SkuNotAvailable\|QuotaExceeded\|AllocationFailed\|[A-Za-z]*Error' "$STATE_DIR/vm-$name.err" | head -1)"
	done
	[ "$created" -eq 1 ] || { log "no size could be created for fc-$RUN_ID-$name"; exit 1; }
done
for node in "${NODES[@]}"; do
	read -r role name region subnet ip <<<"$node"
	az vm wait -g "$(rg_of "$region")" -n "fc-$RUN_ID-$name" --created --timeout 1200
	log "vm fc-$RUN_ID-$name created"
done

{
	printf '{\n  "runId": "%s",\n  "branchTag": "%s",\n  "expires": "%s",\n  "vmSizesTried": "%s",\n  "image": "%s",\n' \
		"$RUN_ID" "$BRANCH_TAG" "$EXPIRES" "${VM_SIZES[*]}" "$IMAGE"
	printf '  "regions": ['
	for index in "${!REGIONS[@]}"; do
		[ "$index" -gt 0 ] && printf ', '
		printf '{"region": "%s", "resourceGroup": "%s", "vnet": "%s", "addressSpace": "%s.0.0/16"}' \
			"${REGIONS[$index]}" "$(rg_of "${REGIONS[$index]}")" "$(vnet_of "${REGIONS[$index]}")" "${PREFIXES[$index]}"
	done
	printf '],\n  "controlPeerings": ['
	for index in "${!REGIONS[@]}"; do
		[ "$index" -gt 0 ] && printf ', '
		printf '"atomic-dt-%s-%s"' "$RUN_ID" "${REGIONS[$index]}"
	done
	printf '],\n  "nodes": ['
	first=1
	for node in "${NODES[@]}"; do
		read -r role name region subnet ip <<<"$node"
		[ "$first" -eq 0 ] && printf ', '
		first=0
		size=$(az vm show -g "$(rg_of "$region")" -n "fc-$RUN_ID-$name" --query hardwareProfile.vmSize -o tsv)
		printf '{"role": "%s", "name": "%s", "vm": "fc-%s-%s", "region": "%s", "resourceGroup": "%s", "ip": "%s", "size": "%s"}' \
			"$role" "$name" "$RUN_ID" "$name" "$region" "$(rg_of "$region")" "$ip" "$size"
	done
	printf ']\n}\n'
} >"$STATE_DIR/manifest.json"
if [ -n "$ARTIFACT_DIR" ]; then
	mkdir -p "$ARTIFACT_DIR"
	cp "$STATE_DIR/manifest.json" "$ARTIFACT_DIR/manifest.json"
fi
log "provisioned; manifest at $STATE_DIR/manifest.json"
