#!/bin/sh
set -eu
# Do not add macOS AppleDouble metadata after the runtime inventory is sealed.
COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --no-xattrs --no-acls -czf "$1" -C "$2" "$3"
