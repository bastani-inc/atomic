#!/usr/bin/env bash
# Installs the fork chaos scenario (#4321) on the VMs provision.sh created, over SSH to private IPs only.
#
#   RUN_ID=<id> test/distributed/fork-chaos/setup-nodes.sh
#
# - Per-run secrets in $STATE_DIR/secrets (mode 700, files 600): a CA, the sqld server certificate (SAN = the sqld
#   private IP, backdated a day so ±10 min of node clock skew still validates), an Ed25519 JWT key pair and one JWT.
#   The token is copied with scp from its file, installed mode 600 on the workers and never printed or put on a
#   command line. sqld only receives the public key.
# - sqld VM: a managed data disk at /data, sqld bound to 127.0.0.1:8080 with JWT auth, nginx terminating TLS on the
#   private IP only (no other listener), Internet egress denied by the NSG after setup.
# - Workers: Node 22 (for npm ci), Bun 1.4.4, this worktree (tracked + untracked source files and the prebuilt ai
#   dist, model data and native module), npm ci --ignore-scripts, a 64 MiB loop-mounted ext4 for the node-local
#   SQLite journal.
set -euo pipefail

: "${RUN_ID:?set RUN_ID}"
STATE_DIR="${STATE_DIR:-$HOME/.fork-chaos/$RUN_ID}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANIFEST="$STATE_DIR/manifest.json"
NODE_VERSION="${NODE_VERSION:-v22.23.4}"
SQLD_VERSION="${SQLD_VERSION:-0.24.32}"
SQLD_PORT=8443
umask 077
mkdir -p "$STATE_DIR/cache" "$STATE_DIR/secrets"
chmod 700 "$STATE_DIR" "$STATE_DIR/secrets"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$STATE_DIR/setup.log" >&2; }

SSH_OPTS=(-i "$STATE_DIR/ssh_key" -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$STATE_DIR/known_hosts"
	-o ConnectTimeout=10 -o ServerAliveInterval=15 -o BatchMode=yes -o LogLevel=ERROR)
ip_of() { jq -r --arg n "$1" '.nodes[] | select(.name == $n) | .ip' "$MANIFEST"; }
region_of() { jq -r --arg n "$1" '.nodes[] | select(.name == $n) | .region' "$MANIFEST"; }
remote() { ssh "${SSH_OPTS[@]}" "azureuser@$(ip_of "$1")" "${@:2}"; }
push() { scp -q "${SSH_OPTS[@]}" "${@:2}" "azureuser@$(ip_of "$1"):/tmp/fc/"; }
SQLD_IP=$(ip_of sqld)
WORKERS=($(jq -r '.nodes[] | select(.role == "worker") | .name' "$MANIFEST"))

log "waiting for ssh on every node"
for name in sqld "${WORKERS[@]}"; do
	for attempt in $(seq 1 60); do
		remote "$name" true 2>/dev/null && break
		[ "$attempt" -eq 60 ] && { log "ssh to $name never came up"; exit 1; }
		sleep 10
	done
	remote "$name" 'cloud-init status --wait >/dev/null 2>&1 || true; mkdir -p /tmp/fc && chmod 700 /tmp/fc'
done

log "fetching node $NODE_VERSION and sqld $SQLD_VERSION"
cd "$STATE_DIR/cache"
node_tar="node-$NODE_VERSION-linux-x64.tar.xz"
[ -f "$node_tar" ] || curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$node_tar"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $node_tar\$" | sha256sum -c -
sqld_tar="libsql-server-x86_64-unknown-linux-gnu.tar.xz"
base="https://github.com/tursodatabase/libsql/releases/download/libsql-server-v$SQLD_VERSION"
[ -f "$sqld_tar" ] || curl -fsSLO "$base/$sqld_tar"
curl -fsSL "$base/$sqld_tar.sha256" | sha256sum -c -
tar -xJf "$sqld_tar"
cp "$(command -v bun)" bun
[ "$(./bun --version)" = "1.4.4" ] || { log "bun on this host is not 1.4.4"; exit 1; }

log "packing the worktree"
cd "$REPO"
{
	git ls-files -co --exclude-standard | while IFS= read -r file; do [ -e "$file" ] && printf '%s\n' "$file"; done
	echo packages/ai/dist
	echo packages/ai/src/providers/data
	ls packages/natives/native/*.node
} >"$STATE_DIR/cache/files.txt"
tar -czf "$STATE_DIR/cache/repo.tgz" -T "$STATE_DIR/cache/files.txt"

log "generating per-run CA, sqld certificate and JWT"
cd "$STATE_DIR/secrets"
not_before=$(date -u -d '-1 day' +%Y%m%d%H%M%SZ)
if [ ! -f ca.crt ]; then
	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key 2>/dev/null
	openssl req -x509 -new -key ca.key -sha256 -subj "/CN=fork-chaos-$RUN_ID-ca" -not_before "$not_before" -days 3 \
		-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt
	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key 2>/dev/null
	openssl req -new -key server.key -subj "/CN=$SQLD_IP" -out server.csr
	printf 'subjectAltName=IP:%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' \
		"$SQLD_IP" >server.ext
	openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -not_before "$not_before" -days 3 \
		-sha256 -extfile server.ext -out server.crt 2>/dev/null
	python3 - <<'EOF'
import base64, json, os, time
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
key = Ed25519PrivateKey.generate()
open("jwt-public.pem", "wb").write(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
header = b64(json.dumps({"alg": "EdDSA", "typ": "JWT"}).encode())
claims = b64(json.dumps({"iat": int(time.time()) - 86400, "exp": int(time.time()) + 3 * 86400, "a": "rw"}).encode())
token = f"{header}.{claims}.{b64(key.sign(f'{header}.{claims}'.encode()))}"
fd = os.open("sqld.token", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, token.encode())
os.close(fd)
EOF
fi
chmod 600 ./*

log "setting up sqld on $SQLD_IP"
push sqld "$STATE_DIR/cache/libsql-server-x86_64-unknown-linux-gnu/sqld" jwt-public.pem server.crt server.key
remote sqld "sudo SQLD_IP=$SQLD_IP SQLD_PORT=$SQLD_PORT bash -s" <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
dev=$(readlink -f /dev/disk/azure/scsi1/lun0 2>/dev/null || true)
if [ -z "$dev" ] || [ ! -b "$dev" ]; then dev=$(lsblk -dpno NAME,SIZE,TYPE | awk '$2 == "8G" && $3 == "disk" {print $1; exit}'); fi
if ! mountpoint -q /data; then
	mkfs.ext4 -q -F -L fcdata "$dev"
	mkdir -p /data
	mount "$dev" /data
	echo "LABEL=fcdata /data ext4 defaults,nofail 0 2" >>/etc/fstab
fi
apt-get update -q >/dev/null
apt-get install -y -q nginx >/dev/null
id sqld >/dev/null 2>&1 || useradd --system --home-dir /data/sqld --shell /usr/sbin/nologin sqld
mkdir -p /data/sqld /etc/fork-chaos
chown sqld:sqld /data/sqld
install -m 755 /tmp/fc/sqld /usr/local/bin/sqld
install -m 644 /tmp/fc/jwt-public.pem /etc/fork-chaos/jwt-public.pem
install -m 644 /tmp/fc/server.crt /etc/fork-chaos/server.crt
install -m 600 -o root -g root /tmp/fc/server.key /etc/fork-chaos/server.key
cat >/etc/systemd/system/sqld.service <<UNIT
[Unit]
Description=libSQL sqld (fork chaos)
After=network-online.target data.mount
[Service]
User=sqld
ExecStart=/usr/local/bin/sqld --db-path /data/sqld/data.sqld --http-listen-addr 127.0.0.1:8080 --auth-jwt-key-file /etc/fork-chaos/jwt-public.pem --no-welcome
Restart=always
RestartSec=1
[Install]
WantedBy=multi-user.target
UNIT
rm -f /etc/nginx/sites-enabled/default
cat >/etc/nginx/conf.d/sqld-tls.conf <<CONF
server {
	listen ${SQLD_IP}:${SQLD_PORT} ssl;
	ssl_certificate /etc/fork-chaos/server.crt;
	ssl_certificate_key /etc/fork-chaos/server.key;
	ssl_protocols TLSv1.2 TLSv1.3;
	client_max_body_size 64m;
	location / {
		proxy_pass http://127.0.0.1:8080;
		proxy_http_version 1.1;
		proxy_set_header Connection "";
		proxy_read_timeout 600s;
		proxy_send_timeout 600s;
		proxy_buffering off;
	}
}
CONF
systemctl daemon-reload
systemctl enable --now sqld >/dev/null 2>&1
nginx -t 2>/dev/null
systemctl restart nginx
systemctl enable nginx >/dev/null 2>&1
rm -rf /tmp/fc
sleep 1
ss -ltnH | awk '{print $4}' | sort
EOF

setup_worker() {
	local name="$1"
	local ip
	ip=$(ip_of "$name")
	push "$name" "$STATE_DIR/cache/node-$NODE_VERSION-linux-x64.tar.xz" "$STATE_DIR/cache/bun" "$STATE_DIR/cache/repo.tgz" \
		"$STATE_DIR/secrets/ca.crt" "$STATE_DIR/secrets/sqld.token"
	remote "$name" "sudo NODE_NAME=$name NODE_REGION=$(region_of "$name") SQLD_URL=https://$SQLD_IP:$SQLD_PORT NODE_VERSION=$NODE_VERSION bash -s" <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null
apt-get install -y -q unzip jq iptables >/dev/null
root=/opt/fork-chaos
mkdir -p $root/bin $root/repo $root/state $root/home $root/work/alt $root/tls $root/localfs
tar -xJf /tmp/fc/node-$NODE_VERSION-linux-x64.tar.xz -C $root
ln -sfn $root/node-$NODE_VERSION-linux-x64 $root/node
install -m 755 /tmp/fc/bun $root/bin/bun
tar -xzf /tmp/fc/repo.tgz -C $root/repo
install -m 644 /tmp/fc/ca.crt $root/tls/ca.crt
install -d -m 700 -o azureuser -g azureuser $root/secrets
install -m 600 -o azureuser -g azureuser /tmp/fc/sqld.token $root/secrets/sqld.token
if ! mountpoint -q $root/localfs; then
	truncate -s 64M $root/localfs.img
	mkfs.ext4 -q -F $root/localfs.img
	mount -o loop $root/localfs.img $root/localfs
fi
cat >$root/node.json <<JSON
{"node": "$NODE_NAME", "region": "$NODE_REGION", "url": "$SQLD_URL", "tokenFile": "$root/secrets/sqld.token", "stateDir": "$root/state", "altCwd": "$root/work/alt", "toolMs": 250}
JSON
cat >$root/env <<ENV
export FC_CONFIG=$root/node.json
export NODE_EXTRA_CA_CERTS=$root/tls/ca.crt
export HOME=$root/home
export PATH=$root/bin:$root/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ENV
chown -R azureuser:azureuser $root
rm -rf /tmp/fc
sudo -u azureuser bash -c "source $root/env && cd $root/repo && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null && node scripts/alias-pi-ai.mjs >/dev/null"
echo "worker $NODE_NAME ready: node $($root/node/bin/node --version), bun $($root/bin/bun --version)"
EOF
}

pids=()
for name in "${WORKERS[@]}"; do
	setup_worker "$name" >"$STATE_DIR/setup-$name.log" 2>&1 &
	pids+=($!)
done
failed=0
for index in "${!pids[@]}"; do
	if ! wait "${pids[$index]}"; then
		log "worker ${WORKERS[$index]} setup failed: $(tail -5 "$STATE_DIR/setup-${WORKERS[$index]}.log")"
		failed=1
	else
		log "$(tail -1 "$STATE_DIR/setup-${WORKERS[$index]}.log")"
	fi
done
[ "$failed" -eq 0 ] || exit 1

log "denying Internet egress on every run subnet now that installs are done"
for row in $(jq -r '.regions[] | "\(.region),\(.resourceGroup)"' "$MANIFEST"); do
	region="${row%%,*}"
	rg="${row##*,}"
	for nsg in $(az network nsg list -g "$rg" --query "[].name" -o tsv); do
		az network nsg rule create -g "$rg" --nsg-name "$nsg" -n deny-internet-out --priority 100 --direction Outbound \
			--access Deny --protocol '*' --source-address-prefixes '*' --source-port-ranges '*' \
			--destination-address-prefixes Internet --destination-port-ranges '*' -o none
	done
done
log "setup complete"
