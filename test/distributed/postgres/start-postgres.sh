#!/bin/sh
# Starts a PostgreSQL server of the distributed tests. ADT_ROLE is `primary` or `replica`.
#
# The data directory lives on a disk of its own: an ext4 image of ADT_DISK_MB megabytes in the container's volume,
# loop-mounted at /var/lib/postgresql/disk, so the disk faults (disk.sh) can fill or slow it without touching the
# host. The server runs in a cgroup of its own, whose io.max disk.sh sets to slow the disk.
#
# The server uses the run's TLS certificate and pg_hba.conf from this directory, which admits Atomic's roles over TLS
# with SCRAM and nobody else over the network. PostgreSQL only reads a key its own user owns, so the key is copied out
# of the read-only mount first.
set -eu
image=/var/lib/postgresql/volume/disk.img
mountpoint=/var/lib/postgresql/disk
if [ ! -s "$image" ]; then
	truncate -s "${ADT_DISK_MB:-2048}M" "$image"
	# No blocks reserved for root, so a full disk is full for PostgreSQL too.
	mkfs.ext4 -q -F -m 0 "$image"
fi
mkdir -p "$mountpoint"
mountpoint -q "$mountpoint" || mount -o loop "$image" "$mountpoint"
# A fill the previous run of this container left behind would keep the server from starting.
rm -f "$mountpoint/adt-fill"
export PGDATA="$mountpoint/pgdata"
install -d -o postgres -g postgres -m 700 "$PGDATA"

mkdir -p /sys/fs/cgroup/postgres
echo $$ > /sys/fs/cgroup/postgres/cgroup.procs
echo +io > /sys/fs/cgroup/cgroup.subtree_control

install -d -o postgres -g postgres -m 700 /var/lib/postgresql/tls
install -o postgres -g postgres -m 600 /adt-tls/server.key /var/lib/postgresql/tls/server.key
install -o postgres -g postgres -m 644 /adt-tls/server.crt /var/lib/postgresql/tls/server.crt
install -o postgres -g postgres -m 644 /adt-tls/root.crt /var/lib/postgresql/tls/root.crt
set -- \
	-c ssl=on \
	-c ssl_cert_file=/var/lib/postgresql/tls/server.crt \
	-c ssl_key_file=/var/lib/postgresql/tls/server.key \
	-c hba_file=/adt/pg_hba.conf \
	-c password_encryption=scram-sha-256 \
	-c max_connections=200 \
	-c hot_standby=on \
	"$@"

if [ "${ADT_ROLE:-primary}" = primary ]; then
	exec docker-entrypoint.sh postgres -c wal_level=replica -c max_wal_senders=4 -c max_replication_slots=4 "$@"
fi

# The replica: on first start, copy the primary with pg_basebackup over TLS, as the replicator role, through a
# replication slot of its own; then run as a read-only hot standby.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
	printf 'primary:5432:replication:replicator:%s\n' "$ADT_REPLICATION_PASSWORD" > /var/lib/postgresql/.pgpass
	chown postgres:postgres /var/lib/postgresql/.pgpass
	chmod 600 /var/lib/postgresql/.pgpass
	gosu postgres env PGPASSFILE=/var/lib/postgresql/.pgpass pg_basebackup \
		--dbname "host=primary port=5432 user=replicator sslmode=verify-full sslrootcert=/var/lib/postgresql/tls/root.crt" \
		--pgdata "$PGDATA" --write-recovery-conf --wal-method stream --create-slot --slot replica
fi
exec gosu postgres postgres "$@"
