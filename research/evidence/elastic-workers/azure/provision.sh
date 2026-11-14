#!/usr/bin/env bash
# Provisions the #4768 experiment: one sqld VM, one root VM and N worker-host VMs in a dedicated, tagged resource group.
#   RG=atomic-elastic-exp-20261114 WORKERS=20 STATE=~/.elastic-exp bash provision.sh
# SSH is open only to the controller's egress address; sqld (8080) is reachable only inside the VNet.
set -euo pipefail
RG=${RG:?set RG}
LOCATION=${LOCATION:-eastus}
WORKERS=${WORKERS:-3}
FIRST=${FIRST:-1}
STATE=${STATE:-$HOME/.elastic-exp/$RG}
WORKER_SIZE=${WORKER_SIZE:-Standard_D4s_v5}
DB_SIZE=${DB_SIZE:-Standard_D4ds_v5}
ROOT_SIZE=${ROOT_SIZE:-Standard_D4as_v5}
IMAGE=${IMAGE:-Canonical:ubuntu-24_04-lts:server:latest}
TAGS=(purpose=atomic-4768 "expires=$(date -u -d '+12 hours' +%Y-%m-%dT%H:%MZ)")
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$STATE" && chmod 700 "$STATE"
[ -f "$STATE/ssh_key" ] || ssh-keygen -q -t ed25519 -N "" -f "$STATE/ssh_key"
CONTROLLER_IP=${CONTROLLER_IP:-$(curl -fsS https://ifconfig.me)}

if [ "$FIRST" = 1 ]; then
	az group create -n "$RG" -l "$LOCATION" --tags "${TAGS[@]}" -o none
	az network vnet create -g "$RG" -n vnet --address-prefixes 10.77.0.0/16 --subnet-name hosts --subnet-prefixes 10.77.0.0/20 --tags "${TAGS[@]}" -o none
	az network nsg create -g "$RG" -n nsg --tags "${TAGS[@]}" -o none
	az network nsg rule create -g "$RG" --nsg-name nsg -n ssh-from-controller --priority 100 --access Allow --protocol Tcp \
		--direction Inbound --source-address-prefixes "$CONTROLLER_IP/32" --destination-port-ranges 22 -o none
	az network vnet subnet update -g "$RG" --vnet-name vnet -n hosts --network-security-group nsg -o none
fi

create() { # name size
	az vm create -g "$RG" -n "$1" --size "$2" --image "$IMAGE" --admin-username azureuser \
		--ssh-key-values "$STATE/ssh_key.pub" --vnet-name vnet --subnet hosts --nsg "" \
		--public-ip-sku Standard --custom-data "$here/cloud-init.yaml" --tags "${TAGS[@]}" role="$3" --no-wait -o none
}
if [ "$FIRST" = 1 ]; then
	create db "$DB_SIZE" db
	create root "$ROOT_SIZE" root
fi
for i in $(seq "${START_INDEX:-1}" "$WORKERS"); do create "w$i" "$WORKER_SIZE" worker; done
echo "requested VMs in $RG; wait with: az vm wait -g $RG --created --ids \$(az vm list -g $RG --query '[].id' -o tsv)"
