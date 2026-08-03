#!/bin/sh

set -eu
set -f

REPOSITORY=bastani-inc/atomic
GITHUB_WEB=https://github.com
GITHUB_API=https://api.github.com
CHECKSUM_FILE=SHA256SUMS

usage() {
    printf '%s\n' 'Atomic release archive installer

Usage:
  install.sh [--ref <tag> | --ref=<tag> | -r <tag>] [--help]

Options:
  --ref <tag>   Install the exact GitHub release tag.
  --ref=<tag>   Install the exact GitHub release tag.
  -r <tag>      Install the exact GitHub release tag.
  --help        Show this help and exit.

Environment:
  ATOMIC_VERSION      Exact release tag when --ref is not supplied.
  ATOMIC_INSTALL_DIR  Installation root (default: $HOME/.local/share/atomic).
  ATOMIC_BIN_DIR      Directory containing the atomic link (default: $HOME/.local/bin).
  GITHUB_TOKEN        Optional GitHub API token (preferred over GH_TOKEN).
  GH_TOKEN            Optional GitHub API token.'
}

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

REQUESTED_REF=${ATOMIC_VERSION:-}
while [ "$#" -gt 0 ]; do
    case $1 in
        --ref)
            shift
            [ "$#" -gt 0 ] || fail "--ref requires a release tag"
            [ -n "$1" ] || fail "--ref requires a non-empty release tag"
            REQUESTED_REF=$1
            ;;
        --ref=*)
            REQUESTED_REF=${1#--ref=}
            [ -n "$REQUESTED_REF" ] || fail "--ref requires a non-empty release tag"
            ;;
        -r)
            shift
            [ "$#" -gt 0 ] || fail "-r requires a release tag"
            [ -n "$1" ] || fail "-r requires a non-empty release tag"
            REQUESTED_REF=$1
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            fail "unknown option: $1"
            ;;
    esac
    shift
done

for required_command in uname tar mkdir mv chmod ln rm rmdir; do
    command -v "$required_command" >/dev/null 2>&1 || fail "required command not found: $required_command"
done

if command -v curl >/dev/null 2>&1; then
    DOWNLOADER=curl
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER=wget
else
    fail "curl or wget is required"
fi

if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
    CHECKSUM_TOOL=shasum
elif command -v openssl >/dev/null 2>&1; then
    CHECKSUM_TOOL=openssl
else
    fail "sha256sum, shasum, or openssl is required"
fi

HOST_OS=$(uname -s 2>/dev/null) || fail "unable to determine the host operating system"
HOST_MACHINE=$(uname -m 2>/dev/null) || fail "unable to determine the host architecture"

if [ "$HOST_OS" = Darwin ] && command -v sysctl >/dev/null 2>&1; then
    if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || :)" = 1 ]; then
        HOST_MACHINE=arm64
    fi
fi

case $HOST_MACHINE in
    x86_64|amd64) HOST_ARCH=x64 ;;
    arm64|aarch64) HOST_ARCH=arm64 ;;
    *) fail "unsupported architecture: $HOST_MACHINE" ;;
esac

case $HOST_OS in
    Darwin)
        case $HOST_ARCH in
            arm64) ASSET_NAME=atomic-darwin-arm64.tar.gz ;;
            x64) ASSET_NAME=atomic-darwin-x64.tar.gz ;;
        esac
        ;;
    Linux)
        LIBC_SUFFIX=
        if [ -f /etc/alpine-release ]; then
            LIBC_SUFFIX=-musl
        elif command -v ldd >/dev/null 2>&1; then
            ldd_version=$(ldd --version 2>&1 || :)
            case $ldd_version in
                *musl*|*Musl*|*MUSL*) LIBC_SUFFIX=-musl ;;
            esac
        fi
        case "$HOST_ARCH$LIBC_SUFFIX" in
            x64) ASSET_NAME=atomic-linux-x64.tar.gz ;;
            arm64) ASSET_NAME=atomic-linux-arm64.tar.gz ;;
            x64-musl) ASSET_NAME=atomic-linux-x64-musl.tar.gz ;;
            arm64-musl) ASSET_NAME=atomic-linux-arm64-musl.tar.gz ;;
        esac
        ;;
    *)
        fail "unsupported operating system: $HOST_OS"
        ;;
esac

INSTALL_ROOT=${ATOMIC_INSTALL_DIR:-${HOME:?HOME is not set}/.local/share/atomic}
BIN_DIR=${ATOMIC_BIN_DIR:-${HOME:?HOME is not set}/.local/bin}
VERSIONS_DIR=$INSTALL_ROOT/versions
CURRENT_PATH=$INSTALL_ROOT/current
BIN_PATH=$BIN_DIR/atomic

TOKEN=${GITHUB_TOKEN:-}
if [ -z "$TOKEN" ]; then
    TOKEN=${GH_TOKEN:-}
fi

umask 077
TEMP_BASE=${TMPDIR:-/tmp}/atomic-install.$$
TEMP_DIR=$TEMP_BASE
TEMP_ATTEMPT=0
while ! mkdir "$TEMP_DIR" 2>/dev/null; do
    TEMP_ATTEMPT=$((TEMP_ATTEMPT + 1))
    [ "$TEMP_ATTEMPT" -lt 100 ] || fail "unable to create a temporary directory under ${TMPDIR:-/tmp}"
    TEMP_DIR=$TEMP_BASE.$TEMP_ATTEMPT
done

TRANSACTION_ID=$$.$TEMP_ATTEMPT
ARCHIVE_PATH=$TEMP_DIR/$ASSET_NAME
CHECKSUM_PATH=$TEMP_DIR/$CHECKSUM_FILE
EXTRACT_ROOT=$TEMP_DIR/extract
PAYLOAD_ROOT=
VERSION_PATH=
VERSION_STAGE=
VERSION_BACKUP=
CURRENT_NEXT=
CURRENT_BACKUP=
BIN_NEXT=
BIN_BACKUP=
VERSION_INSTALLED=0
VERSION_BACKED_UP=0
CURRENT_INSTALLED=0
CURRENT_BACKED_UP=0
BIN_INSTALLED=0
BIN_BACKED_UP=0
INSTALL_COMMITTED=0
CREATED_INSTALL_ROOT=0
CREATED_VERSIONS_DIR=0
CREATED_BIN_DIR=0

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

cleanup() {
    cleanup_status=$?
    set +e

    if [ "$INSTALL_COMMITTED" -ne 1 ]; then
        if [ "$BIN_INSTALLED" -eq 1 ] && path_exists "$BIN_PATH"; then
            rm -rf "$BIN_PATH"
        fi
        if [ "$BIN_BACKED_UP" -eq 1 ] && path_exists "$BIN_BACKUP"; then
            mv "$BIN_BACKUP" "$BIN_PATH"
        fi
        if [ -n "$BIN_NEXT" ] && path_exists "$BIN_NEXT"; then
            rm -rf "$BIN_NEXT"
        fi

        if [ "$CURRENT_INSTALLED" -eq 1 ] && path_exists "$CURRENT_PATH"; then
            rm -rf "$CURRENT_PATH"
        fi
        if [ "$CURRENT_BACKED_UP" -eq 1 ] && path_exists "$CURRENT_BACKUP"; then
            mv "$CURRENT_BACKUP" "$CURRENT_PATH"
        fi
        if [ -n "$CURRENT_NEXT" ] && path_exists "$CURRENT_NEXT"; then
            rm -rf "$CURRENT_NEXT"
        fi

        if [ "$VERSION_INSTALLED" -eq 1 ] && path_exists "$VERSION_PATH"; then
            rm -rf "$VERSION_PATH"
        fi
        if [ "$VERSION_BACKED_UP" -eq 1 ] && path_exists "$VERSION_BACKUP"; then
            mv "$VERSION_BACKUP" "$VERSION_PATH"
        fi
        if [ -n "$VERSION_STAGE" ] && path_exists "$VERSION_STAGE"; then
            rm -rf "$VERSION_STAGE"
        fi

        if [ "$CREATED_BIN_DIR" -eq 1 ]; then
            rmdir "$BIN_DIR" 2>/dev/null
        fi
        if [ "$CREATED_VERSIONS_DIR" -eq 1 ]; then
            rmdir "$VERSIONS_DIR" 2>/dev/null
        fi
        if [ "$CREATED_INSTALL_ROOT" -eq 1 ]; then
            rmdir "$INSTALL_ROOT" 2>/dev/null
        fi
    fi

    rm -rf "$TEMP_DIR"
    trap - 0 HUP INT TERM
    exit "$cleanup_status"
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

http_get() {
    http_url=$1
    if [ "$DOWNLOADER" = curl ]; then
        if [ -n "$TOKEN" ]; then
            curl -fsSL -H 'Accept: application/vnd.github+json' -H "Authorization: Bearer $TOKEN" "$http_url"
        else
            curl -fsSL -H 'Accept: application/vnd.github+json' "$http_url"
        fi
    else
        if [ -n "$TOKEN" ]; then
            wget -q -O - --header='Accept: application/vnd.github+json' --header="Authorization: Bearer $TOKEN" "$http_url"
        else
            wget -q -O - --header='Accept: application/vnd.github+json' "$http_url"
        fi
    fi
}

download_file() {
    download_url=$1
    download_destination=$2
    if [ "$DOWNLOADER" = curl ]; then
        curl -fsSL -o "$download_destination" "$download_url"
    else
        wget -q -O "$download_destination" "$download_url"
    fi
}

tag_from_release_url() {
    release_url=$1
    case $release_url in
        */releases/tag/*)
            resolved_url_tag=${release_url##*/releases/tag/}
            resolved_url_tag=${resolved_url_tag%%\?*}
            resolved_url_tag=${resolved_url_tag%%\#*}
            [ -n "$resolved_url_tag" ] || return 1
            printf '%s\n' "$resolved_url_tag"
            ;;
        *) return 1 ;;
    esac
}

resolve_redirect_tag() {
    latest_url=$GITHUB_WEB/$REPOSITORY/releases/latest
    if [ "$DOWNLOADER" = curl ]; then
        if latest_effective_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$latest_url" 2>/dev/null); then
            tag_from_release_url "$latest_effective_url"
            return
        fi
        return 1
    fi

    latest_headers=$TEMP_DIR/latest-headers
    if ! wget -S --spider "$latest_url" > /dev/null 2>"$latest_headers"; then
        return 1
    fi
    latest_location=
    while IFS= read -r header_line || [ -n "$header_line" ]; do
        case $header_line in
            *Location:*|*location:*)
                header_value=${header_line#*:}
                for header_word in $header_value; do
                    latest_location=$header_word
                    break
                done
                ;;
        esac
    done < "$latest_headers"
    [ -n "$latest_location" ] || return 1
    tag_from_release_url "$latest_location"
}

parse_release_tag() {
    release_json=$1
    case $release_json in
        *\"tag_name\"*) ;;
        *) return 1 ;;
    esac
    release_json_tail=${release_json#*\"tag_name\"}
    release_json_tail=${release_json_tail#*:}
    case $release_json_tail in
        *\"*) ;;
        *) return 1 ;;
    esac
    release_json_tail=${release_json_tail#*\"}
    parsed_release_tag=${release_json_tail%%\"*}
    [ -n "$parsed_release_tag" ] || return 1
    printf '%s\n' "$parsed_release_tag"
}

TAGS_API=$GITHUB_API/repos/$REPOSITORY/releases/tags
if [ -n "$REQUESTED_REF" ]; then
    API_URL=$TAGS_API/$REQUESTED_REF
else
    REDIRECT_TAG=
    if REDIRECT_TAG=$(resolve_redirect_tag); then
        API_URL=$TAGS_API/$REDIRECT_TAG
    else
        API_URL=$GITHUB_API/repos/$REPOSITORY/releases/latest
    fi
fi

if ! RELEASE_JSON=$(http_get "$API_URL"); then
    fail "failed to resolve the GitHub release"
fi
if ! RELEASE_TAG=$(parse_release_tag "$RELEASE_JSON"); then
    fail "GitHub release response did not contain a valid tag_name"
fi
case $RELEASE_TAG in
    ''|.|..|*/*|*\\*) fail "release tag cannot be used as a version directory: $RELEASE_TAG" ;;
esac

RELEASE_BASE=$GITHUB_WEB/$REPOSITORY/releases/download/$RELEASE_TAG
if ! download_file "$RELEASE_BASE/$ASSET_NAME" "$ARCHIVE_PATH"; then
    fail "failed to download release asset: $ASSET_NAME"
fi
if ! download_file "$RELEASE_BASE/$CHECKSUM_FILE" "$CHECKSUM_PATH"; then
    fail "failed to download $CHECKSUM_FILE"
fi

EXPECTED_CHECKSUM=
CHECKSUM_MATCHES=0
while IFS= read -r checksum_line || [ -n "$checksum_line" ]; do
    set -- $checksum_line
    [ "$#" -ge 2 ] || continue
    checksum_value=$1
    checksum_name=$2
    case $checksum_name in
        \*) checksum_name=${checksum_name#\*} ;;
    esac
    if [ "$checksum_name" = "$ASSET_NAME" ]; then
        CHECKSUM_MATCHES=$((CHECKSUM_MATCHES + 1))
        [ "$#" -eq 2 ] || fail "$CHECKSUM_FILE row for $ASSET_NAME is malformed"
        [ "${#checksum_value}" -eq 64 ] || fail "$CHECKSUM_FILE row for $ASSET_NAME is malformed"
        case $checksum_value in
            *[!0123456789abcdef]*|'') fail "$CHECKSUM_FILE row for $ASSET_NAME is malformed" ;;
        esac
        EXPECTED_CHECKSUM=$checksum_value
    fi
done < "$CHECKSUM_PATH"
[ "$CHECKSUM_MATCHES" -eq 1 ] || fail "$CHECKSUM_FILE must contain exactly one row for $ASSET_NAME"

case $CHECKSUM_TOOL in
    sha256sum) checksum_output=$(sha256sum "$ARCHIVE_PATH") || fail "failed to hash $ASSET_NAME" ;;
    shasum) checksum_output=$(shasum -a 256 "$ARCHIVE_PATH") || fail "failed to hash $ASSET_NAME" ;;
    openssl) checksum_output=$(openssl dgst -sha256 "$ARCHIVE_PATH") || fail "failed to hash $ASSET_NAME" ;;
esac
set -- $checksum_output
if [ "$CHECKSUM_TOOL" = openssl ]; then
    ACTUAL_CHECKSUM=
    for checksum_word in "$@"; do
        ACTUAL_CHECKSUM=$checksum_word
    done
else
    ACTUAL_CHECKSUM=$1
fi
[ "$ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM" ] || fail "checksum verification failed for $ASSET_NAME"

mkdir "$EXTRACT_ROOT"
if ! tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_ROOT"; then
    fail "failed to extract release asset: $ASSET_NAME"
fi
PAYLOAD_ROOT=$EXTRACT_ROOT/atomic
[ -d "$PAYLOAD_ROOT" ] || fail "release asset $ASSET_NAME does not contain the top-level atomic directory"
[ -f "$PAYLOAD_ROOT/atomic" ] || fail "release asset $ASSET_NAME does not contain atomic/atomic"
chmod +x "$PAYLOAD_ROOT/atomic"
if ! "$PAYLOAD_ROOT/atomic" --version >/dev/null; then
    fail "staged atomic --version check failed"
fi

if [ ! -d "$INSTALL_ROOT" ]; then
    mkdir -p "$INSTALL_ROOT"
    CREATED_INSTALL_ROOT=1
fi
if [ ! -d "$VERSIONS_DIR" ]; then
    mkdir -p "$VERSIONS_DIR"
    CREATED_VERSIONS_DIR=1
fi
if [ ! -d "$BIN_DIR" ]; then
    mkdir -p "$BIN_DIR"
    CREATED_BIN_DIR=1
fi

VERSION_PATH=$VERSIONS_DIR/$RELEASE_TAG
VERSION_STAGE=$VERSIONS_DIR/.stage-$TRANSACTION_ID
VERSION_BACKUP=$VERSIONS_DIR/.backup-$TRANSACTION_ID
CURRENT_NEXT=$INSTALL_ROOT/.current-$TRANSACTION_ID
CURRENT_BACKUP=$INSTALL_ROOT/.current-backup-$TRANSACTION_ID
BIN_NEXT=$BIN_DIR/.atomic-$TRANSACTION_ID
BIN_BACKUP=$BIN_DIR/.atomic-backup-$TRANSACTION_ID

mv "$PAYLOAD_ROOT" "$VERSION_STAGE"
PAYLOAD_ROOT=
if path_exists "$VERSION_PATH"; then
    mv "$VERSION_PATH" "$VERSION_BACKUP"
    VERSION_BACKED_UP=1
fi
mv "$VERSION_STAGE" "$VERSION_PATH"
VERSION_STAGE=
VERSION_INSTALLED=1

ln -s "versions/$RELEASE_TAG" "$CURRENT_NEXT"
if path_exists "$CURRENT_PATH"; then
    mv "$CURRENT_PATH" "$CURRENT_BACKUP"
    CURRENT_BACKED_UP=1
fi
mv "$CURRENT_NEXT" "$CURRENT_PATH"
CURRENT_NEXT=
CURRENT_INSTALLED=1

ln -s "$CURRENT_PATH/atomic" "$BIN_NEXT"
if path_exists "$BIN_PATH"; then
    mv "$BIN_PATH" "$BIN_BACKUP"
    BIN_BACKED_UP=1
fi
mv "$BIN_NEXT" "$BIN_PATH"
BIN_NEXT=
BIN_INSTALLED=1

if ! "$BIN_PATH" --version >/dev/null; then
    fail "installed atomic --version check failed"
fi

INSTALL_COMMITTED=1
if [ "$BIN_BACKED_UP" -eq 1 ]; then
    rm -rf "$BIN_BACKUP" || :
    BIN_BACKED_UP=0
fi
if [ "$CURRENT_BACKED_UP" -eq 1 ]; then
    rm -rf "$CURRENT_BACKUP" || :
    CURRENT_BACKED_UP=0
fi
if [ "$VERSION_BACKED_UP" -eq 1 ]; then
    rm -rf "$VERSION_BACKUP" || :
    VERSION_BACKED_UP=0
fi

printf 'Atomic %s installed successfully.\n' "$RELEASE_TAG"
printf 'Binary: %s\n' "$BIN_PATH"
case :${PATH:-}: in
    *:$BIN_DIR:*) ;;
    *)
        printf 'Add Atomic to PATH for this shell:\n'
        printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
        ;;
esac
