#!/bin/sh
# Starts PgBouncer with pgbouncer.ini. Its auth_file holds only the lookup role's password, which comes from the
# environment so it never lands in the repository.
set -eu
umask 077
printf '"pgbouncer_auth" "%s"\n' "$ADT_PGBOUNCER_AUTH_PASSWORD" > /tmp/pgbouncer-userlist.txt
exec pgbouncer /adt/pgbouncer.ini
