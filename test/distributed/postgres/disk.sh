#!/bin/sh
# The disk faults of the distributed tests, run inside a PostgreSQL container with `docker compose exec`:
#
#   disk.sh throttle <bytes-per-second>  slow reads and writes of the data disk to this rate
#   disk.sh unthrottle                   lift the limit
#   disk.sh fill                         fill the data disk, so the server's next write that needs space fails
#   disk.sh unfill                       free that space again
#   disk.sh usage                        print the disk's size and free bytes
set -eu
mountpoint=/var/lib/postgresql/disk
device=$(findmnt -n -o SOURCE "$mountpoint")
majmin=$(cat "/sys/block/$(basename "$device")/dev")
case "${1:-}" in
throttle)
	echo "$majmin rbps=$2 wbps=$2" > /sys/fs/cgroup/postgres/io.max
	;;
unthrottle)
	echo "$majmin rbps=max wbps=max" > /sys/fs/cgroup/postgres/io.max
	;;
fill)
	free=$(df --output=avail -B1 "$mountpoint" | tail -n 1)
	fallocate -l "$free" "$mountpoint/adt-fill" 2>/dev/null || true
	# fallocate stops short of the last blocks; take them one write at a time.
	dd if=/dev/zero of="$mountpoint/adt-fill" bs=4096 oflag=append conv=notrunc status=none 2>/dev/null || true
	sync
	;;
unfill)
	rm -f "$mountpoint/adt-fill"
	sync
	;;
usage)
	df --output=size,avail -B1 "$mountpoint" | tail -n 1
	;;
*)
	echo "usage: disk.sh throttle <bytes-per-second> | unthrottle | fill | unfill | usage" >&2
	exit 2
	;;
esac
