#!/bin/sh

set -eu
set -f

LC_ALL=C
export LC_ALL

REPOSITORY=bastani-inc/atomic
GITHUB_WEB=https://github.com
GITHUB_API=https://api.github.com
CHECKSUM_FILE=SHA256SUMS
NEWLINE=$(printf '\n_')
NEWLINE=${NEWLINE%_}

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

normalize_absolute_path() {
    normalize_remaining=${1#/}
    normalize_result=
    while [ -n "$normalize_remaining" ]; do
        case $normalize_remaining in
            */*)
                normalize_segment=${normalize_remaining%%/*}
                normalize_remaining=${normalize_remaining#*/}
                ;;
            *)
                normalize_segment=$normalize_remaining
                normalize_remaining=
                ;;
        esac
        case $normalize_segment in
            ''|.) ;;
            ..)
                case $normalize_result in
                    */*) normalize_result=${normalize_result%/*} ;;
                    *) normalize_result= ;;
                esac
                ;;
            *)
                if [ -n "$normalize_result" ]; then
                    normalize_result=$normalize_result/$normalize_segment
                else
                    normalize_result=$normalize_segment
                fi
                ;;
        esac
    done
    if [ -n "$normalize_result" ]; then
        printf '/%s' "$normalize_result"
    else
        printf '/'
    fi
}

canonicalize_existing_prefix() {
    canonical_input=$1
    canonical_probe=$canonical_input
    canonical_suffix=

    while [ ! -d "$canonical_probe" ]; do
        canonical_segment=${canonical_probe##*/}
        if [ -n "$canonical_suffix" ]; then
            canonical_suffix=$canonical_segment/$canonical_suffix
        else
            canonical_suffix=$canonical_segment
        fi
        canonical_parent=${canonical_probe%/*}
        [ -n "$canonical_parent" ] || canonical_parent=/
        [ "$canonical_parent" != "$canonical_probe" ] || break
        canonical_probe=$canonical_parent
    done

    canonical_physical=$(CDPATH= cd -P "$canonical_probe" 2>/dev/null && pwd && printf '_') || return 1
    canonical_physical=${canonical_physical%_}
    canonical_physical=${canonical_physical%"$NEWLINE"}
    if [ -n "$canonical_suffix" ]; then
        normalize_absolute_path "$canonical_physical/$canonical_suffix"
    else
        normalize_absolute_path "$canonical_physical"
    fi
}

percent_encode() {
    percent_input=$1
    percent_output=
    while [ -n "$percent_input" ]; do
        percent_character=${percent_input%"${percent_input#?}"}
        percent_input=${percent_input#?}
        case $percent_character in
            [abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-])
                percent_output=$percent_output$percent_character
                ;;
            *)
                percent_decimal=$(printf '%d' "'$percent_character")
                if [ "$percent_decimal" -lt 0 ]; then
                    percent_decimal=$((percent_decimal + 256))
                fi
                percent_output=$percent_output%$(printf '%02X' "$percent_decimal")
                ;;
        esac
    done
    printf '%s\n' "$percent_output"
}

hex_nibble() {
    case $1 in
        0|1|2|3|4|5|6|7|8|9) printf '%s' "$1" ;;
        A|a) printf 10 ;;
        B|b) printf 11 ;;
        C|c) printf 12 ;;
        D|d) printf 13 ;;
        E|e) printf 14 ;;
        F|f) printf 15 ;;
        *) return 1 ;;
    esac
}

percent_decode() {
    decode_input=$1
    decode_output=
    while [ -n "$decode_input" ]; do
        decode_character=${decode_input%"${decode_input#?}"}
        if [ "$decode_character" = % ]; then
            decode_after_percent=${decode_input#?}
            decode_high=${decode_after_percent%"${decode_after_percent#?}"}
            decode_after_high=${decode_after_percent#?}
            decode_low=${decode_after_high%"${decode_after_high#?}"}
            [ -n "$decode_high" ] && [ -n "$decode_low" ] || return 1
            decode_high_value=$(hex_nibble "$decode_high") || return 1
            decode_low_value=$(hex_nibble "$decode_low") || return 1
            decode_decimal=$((decode_high_value * 16 + decode_low_value))
            [ "$decode_decimal" -ne 0 ] || return 1
            decode_octal=$(printf '%03o' "$decode_decimal")
            decode_output=$decode_output$(printf "\\$decode_octal")
            decode_input=${decode_after_high#?}
        else
            decode_output=$decode_output$decode_character
            decode_input=${decode_input#?}
        fi
    done
    printf '%s\n' "$decode_output"
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

START_WORKING_DIR=$(pwd -P && printf '_') || fail "unable to resolve the current working directory"
START_WORKING_DIR=${START_WORKING_DIR%_}
START_WORKING_DIR=${START_WORKING_DIR%"$NEWLINE"}
INSTALL_ROOT=${ATOMIC_INSTALL_DIR:-${HOME:?HOME is not set}/.local/share/atomic}
BIN_DIR=${ATOMIC_BIN_DIR:-${HOME:?HOME is not set}/.local/bin}
case $INSTALL_ROOT in
    /*) ;;
    *) INSTALL_ROOT=$START_WORKING_DIR/$INSTALL_ROOT ;;
esac
case $BIN_DIR in
    /*) ;;
    *) BIN_DIR=$START_WORKING_DIR/$BIN_DIR ;;
esac
INSTALL_ROOT=$(normalize_absolute_path "$INSTALL_ROOT" && printf '_')
INSTALL_ROOT=${INSTALL_ROOT%_}
BIN_DIR=$(normalize_absolute_path "$BIN_DIR" && printf '_')
BIN_DIR=${BIN_DIR%_}
BIN_PATH=$BIN_DIR/atomic
PHYSICAL_INSTALL_ROOT=$(canonicalize_existing_prefix "$INSTALL_ROOT" && printf '_') ||
    fail "unable to resolve ATOMIC_INSTALL_DIR: $INSTALL_ROOT"
PHYSICAL_INSTALL_ROOT=${PHYSICAL_INSTALL_ROOT%_}
PHYSICAL_BIN_PATH=$(canonicalize_existing_prefix "$BIN_PATH" && printf '_') ||
    fail "unable to resolve ATOMIC_BIN_DIR/atomic: $BIN_PATH"
PHYSICAL_BIN_PATH=${PHYSICAL_BIN_PATH%_}
case $PHYSICAL_INSTALL_ROOT/ in
    "$PHYSICAL_BIN_PATH/"*)
        fail "ATOMIC_INSTALL_DIR cannot equal ATOMIC_BIN_DIR/atomic or be inside that launcher path: $INSTALL_ROOT"
        ;;
esac
if [ -d "$BIN_PATH" ] && [ ! -L "$BIN_PATH" ]; then
    fail "ATOMIC_BIN_DIR/atomic is an unexpected directory; refusing to replace it: $BIN_PATH"
fi

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

if [ "$HOST_OS" = Darwin ]; then
    if command -v sysctl >/dev/null 2>&1; then
        arm64_capable=$(sysctl -in hw.optional.arm64 2>/dev/null || :)
    elif [ -x /usr/sbin/sysctl ]; then
        arm64_capable=$(/usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null || :)
    else
        arm64_capable=
    fi
    if [ "$arm64_capable" = 1 ]; then
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
        if [ -n "${ANDROID_ROOT:-}" ] || [ -n "${ANDROID_DATA:-}" ] || [ -n "${TERMUX_VERSION:-}" ] ||
            [ -e /system/bin/linker ] || [ -e /system/bin/linker64 ]; then
            fail "unsupported Linux libc: bionic"
        fi

        if [ -f /etc/alpine-release ]; then
            LIBC_SUFFIX=-musl
        else
            command -v ldd >/dev/null 2>&1 || fail "unable to identify Linux libc: ldd not found"
            ldd_version=$(ldd --version 2>&1 || :)
            case $ldd_version in
                *uClibc*|*uclibc*|*UCLIBC*) fail "unsupported Linux libc: uClibc" ;;
                *bionic*|*Bionic*|*BIONIC*) fail "unsupported Linux libc: bionic" ;;
                *musl*|*Musl*|*MUSL*) LIBC_SUFFIX=-musl ;;
                *GLIBC*|*glibc*|*GNU\ libc*|*GNU\ C\ Library*) LIBC_SUFFIX= ;;
                *) fail "unsupported Linux libc: unknown" ;;
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

VERSIONS_DIR=
CURRENT_PATH=

set -- "${GITHUB_TOKEN:-}" "${GH_TOKEN:-}"
unset GITHUB_TOKEN GH_TOKEN TOKEN
TOKEN=$1
if [ -z "$TOKEN" ]; then
    TOKEN=$2
fi
set --
token_line_feed=$(printf '\n_')
token_line_feed=${token_line_feed%_}
token_carriage_return=$(printf '\r_')
token_carriage_return=${token_carriage_return%_}
case $TOKEN in
    *"$token_line_feed"*|*"$token_carriage_return"*) fail "GitHub API token contains a forbidden newline" ;;
esac

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
API_AUTH_PATH=$TEMP_DIR/github-api-auth
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
INSTALL_DIRECTORY_STOP=
BIN_DIRECTORY_STOP=
ROLLBACK_RETRY_LIMIT=3

path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

nearest_existing_directory() {
    existing_candidate=$1
    while [ ! -d "$existing_candidate" ]; do
        existing_parent=${existing_candidate%/*}
        [ -n "$existing_parent" ] || existing_parent=/
        [ "$existing_parent" != "$existing_candidate" ] || return 1
        existing_candidate=$existing_parent
    done
    printf '%s' "$existing_candidate"
}

remove_created_empty_path() {
    created_candidate=$1
    created_stop=$2
    while [ -n "$created_candidate" ] && [ "$created_candidate" != "$created_stop" ]; do
        if ! rmdir "$created_candidate" 2>/dev/null; then
            return
        fi
        created_parent=${created_candidate%/*}
        [ -n "$created_parent" ] || created_parent=/
        [ "$created_parent" != "$created_candidate" ] || return
        created_candidate=$created_parent
    done
}

rollback_once() {
    rollback_incomplete=0

    if [ "$BIN_INSTALLED" -eq 1 ]; then
        if ! path_exists "$BIN_PATH"; then
            BIN_INSTALLED=0
        elif rm -rf "$BIN_PATH"; then
            BIN_INSTALLED=0
        else
            printf 'warning: failed to remove the unsuccessful atomic launcher: %s\n' "$BIN_PATH" >&2
            rollback_incomplete=1
        fi
    fi
    if [ "$BIN_BACKED_UP" -eq 1 ]; then
        if path_exists "$BIN_BACKUP" && ! path_exists "$BIN_PATH"; then
            if mv "$BIN_BACKUP" "$BIN_PATH"; then
                BIN_BACKED_UP=0
            else
                printf 'warning: failed to restore the previous atomic launcher: %s\n' "$BIN_PATH" >&2
                rollback_incomplete=1
            fi
        elif ! path_exists "$BIN_BACKUP" && path_exists "$BIN_PATH"; then
            BIN_BACKED_UP=0
        else
            printf 'warning: previous atomic launcher restore remains incomplete: %s\n' "$BIN_PATH" >&2
            rollback_incomplete=1
        fi
    fi

    if [ "$CURRENT_INSTALLED" -eq 1 ]; then
        if ! path_exists "$CURRENT_PATH"; then
            CURRENT_INSTALLED=0
        elif rm -rf "$CURRENT_PATH"; then
            CURRENT_INSTALLED=0
        else
            printf 'warning: failed to remove the unsuccessful current pointer: %s\n' "$CURRENT_PATH" >&2
            rollback_incomplete=1
        fi
    fi
    if [ "$CURRENT_BACKED_UP" -eq 1 ]; then
        if path_exists "$CURRENT_BACKUP" && ! path_exists "$CURRENT_PATH"; then
            if mv "$CURRENT_BACKUP" "$CURRENT_PATH"; then
                CURRENT_BACKED_UP=0
            else
                printf 'warning: failed to restore the previous current pointer: %s\n' "$CURRENT_PATH" >&2
                rollback_incomplete=1
            fi
        elif ! path_exists "$CURRENT_BACKUP" && path_exists "$CURRENT_PATH"; then
            CURRENT_BACKED_UP=0
        else
            printf 'warning: previous current pointer restore remains incomplete: %s\n' "$CURRENT_PATH" >&2
            rollback_incomplete=1
        fi
    fi

    if [ "$VERSION_INSTALLED" -eq 1 ]; then
        if ! path_exists "$VERSION_PATH"; then
            VERSION_INSTALLED=0
        elif rm -rf "$VERSION_PATH"; then
            VERSION_INSTALLED=0
        else
            printf 'warning: failed to remove the unsuccessful version: %s\n' "$VERSION_PATH" >&2
            rollback_incomplete=1
        fi
    fi
    if [ "$VERSION_BACKED_UP" -eq 1 ]; then
        if path_exists "$VERSION_BACKUP" && ! path_exists "$VERSION_PATH"; then
            if mv "$VERSION_BACKUP" "$VERSION_PATH"; then
                VERSION_BACKED_UP=0
            else
                printf 'warning: failed to restore the previous version: %s\n' "$VERSION_PATH" >&2
                rollback_incomplete=1
            fi
        elif ! path_exists "$VERSION_BACKUP" && path_exists "$VERSION_PATH"; then
            VERSION_BACKED_UP=0
        else
            printf 'warning: previous version restore remains incomplete: %s\n' "$VERSION_PATH" >&2
            rollback_incomplete=1
        fi
    fi
}

cleanup() {
    cleanup_status=$?
    set +e

    if [ "$INSTALL_COMMITTED" -ne 1 ]; then
        rollback_attempt=0
        rollback_incomplete=1
        while [ "$rollback_attempt" -lt "$ROLLBACK_RETRY_LIMIT" ] && [ "$rollback_incomplete" -eq 1 ]; do
            rollback_attempt=$((rollback_attempt + 1))
            rollback_once
        done
        if [ "$rollback_incomplete" -eq 1 ]; then
            printf 'warning: installation rollback remains incomplete after %s attempts; backups were retained for recovery.\n' "$ROLLBACK_RETRY_LIMIT" >&2
            cleanup_status=1
        fi

        if [ -n "$BIN_NEXT" ] && path_exists "$BIN_NEXT"; then
            rm -rf "$BIN_NEXT" || printf 'warning: failed to remove temporary launcher: %s\n' "$BIN_NEXT" >&2
        fi
        if [ -n "$CURRENT_NEXT" ] && path_exists "$CURRENT_NEXT"; then
            rm -rf "$CURRENT_NEXT" || printf 'warning: failed to remove temporary current pointer: %s\n' "$CURRENT_NEXT" >&2
        fi
        if [ -n "$VERSION_STAGE" ] && path_exists "$VERSION_STAGE"; then
            rm -rf "$VERSION_STAGE" || printf 'warning: failed to remove staged version: %s\n' "$VERSION_STAGE" >&2
        fi

        if [ "$CREATED_BIN_DIR" -eq 1 ]; then
            remove_created_empty_path "$BIN_DIR" "$BIN_DIRECTORY_STOP"
        fi
        if [ "$CREATED_VERSIONS_DIR" -eq 1 ]; then
            rmdir "$VERSIONS_DIR" 2>/dev/null || :
        fi
        if [ "$CREATED_INSTALL_ROOT" -eq 1 ]; then
            remove_created_empty_path "$INSTALL_ROOT" "$INSTALL_DIRECTORY_STOP"
        fi
    fi

    rm -rf "$TEMP_DIR"
    trap - 0 HUP INT TERM
    exit "$cleanup_status"
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

prepare_api_auth() {
    [ -n "$TOKEN" ] || return 0
    if [ "$DOWNLOADER" = curl ]; then
        printf 'Authorization: Bearer %s\n' "$TOKEN" > "$API_AUTH_PATH"
    else
        wget_version=$(wget --version 2>/dev/null || :)
        case $wget_version in
            *'GNU Wget'*) ;;
            *) fail "authenticated GitHub API requests require curl or GNU Wget; this wget cannot protect the token" ;;
        esac
        printf 'header = Authorization: Bearer %s\n' "$TOKEN" > "$API_AUTH_PATH"
    fi
    chmod 600 "$API_AUTH_PATH"
}

clear_api_auth() {
    rm -f "$API_AUTH_PATH"
    unset TOKEN
}

http_get() {
    http_url=$1
    if [ "$DOWNLOADER" = curl ]; then
        if [ -n "$TOKEN" ]; then
            curl -fsSL -H 'Accept: application/vnd.github+json' -H "@$API_AUTH_PATH" "$http_url"
        else
            curl -fsSL -H 'Accept: application/vnd.github+json' "$http_url"
        fi
    else
        if [ -n "$TOKEN" ]; then
            WGETRC="$API_AUTH_PATH" wget -q -O - --header='Accept: application/vnd.github+json' "$http_url"
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
            percent_decode "$resolved_url_tag"
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

is_release_number() {
    case $1 in
        ''|*[!0123456789]*) return 1 ;;
        0|[123456789]*) return 0 ;;
        *) return 1 ;;
    esac
}

is_atomic_release_tag() {
    release_version=$1
    case $release_version in
        *-alpha.*)
            release_revision=${release_version##*-alpha.}
            release_core=${release_version%-alpha.*}
            is_release_number "$release_revision" || return 1
            [ "$release_revision" != 0 ] || return 1
            ;;
        *-*) return 1 ;;
        *) release_core=$release_version ;;
    esac

    release_ifs=$IFS
    IFS=.
    set -- $release_core
    IFS=$release_ifs
    [ "$#" -eq 3 ] || return 1
    is_release_number "$1" && is_release_number "$2" && is_release_number "$3"
}

parse_release_tag() {
    release_json=$1
    case $release_json in
        *\"tag_name\"*) release_json_tail=${release_json#*\"tag_name\"} ;;
        *) return 1 ;;
    esac

    release_tab=$(printf '\t_')
    release_tab=${release_tab%_}
    release_line_feed=$(printf '\n_')
    release_line_feed=${release_line_feed%_}
    release_carriage_return=$(printf '\r_')
    release_carriage_return=${release_carriage_return%_}
    while [ -n "$release_json_tail" ]; do
        release_character=${release_json_tail%"${release_json_tail#?}"}
        case $release_character in
            ' '|"$release_tab"|"$release_line_feed"|"$release_carriage_return")
                release_json_tail=${release_json_tail#?}
                ;;
            *) break ;;
        esac
    done
    case $release_json_tail in
        :*) release_json_tail=${release_json_tail#?} ;;
        *) return 1 ;;
    esac
    while [ -n "$release_json_tail" ]; do
        release_character=${release_json_tail%"${release_json_tail#?}"}
        case $release_character in
            ' '|"$release_tab"|"$release_line_feed"|"$release_carriage_return")
                release_json_tail=${release_json_tail#?}
                ;;
            *) break ;;
        esac
    done
    case $release_json_tail in
        \"*) release_json_tail=${release_json_tail#?} ;;
        *) return 1 ;;
    esac
    case $release_json_tail in
        *\"*) parsed_release_tag=${release_json_tail%%\"*} ;;
        *) return 1 ;;
    esac
    is_atomic_release_tag "$parsed_release_tag" || return 1
    printf '%s\n' "$parsed_release_tag"
}

TAGS_API=$GITHUB_API/repos/$REPOSITORY/releases/tags
RELEASE_TAG=
RELEASE_TAG_ENCODED=
API_URL=
if [ -n "$REQUESTED_REF" ]; then
    is_atomic_release_tag "$REQUESTED_REF" ||
        fail "unsupported release tag: expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-alpha.REVISION"
    REQUESTED_REF_ENCODED=$(percent_encode "$REQUESTED_REF")
    API_URL=$TAGS_API/$REQUESTED_REF_ENCODED
else
    REDIRECT_TAG=
    if REDIRECT_TAG=$(resolve_redirect_tag); then
        is_atomic_release_tag "$REDIRECT_TAG" ||
            fail "latest release redirect returned an unsupported Atomic release tag"
        RELEASE_TAG=$REDIRECT_TAG
    else
        API_URL=$GITHUB_API/repos/$REPOSITORY/releases/latest
    fi
fi

if [ -z "$RELEASE_TAG" ]; then
    prepare_api_auth
    if ! RELEASE_JSON=$(http_get "$API_URL"); then
        fail "failed to resolve the GitHub release"
    fi
    if ! RELEASE_TAG=$(parse_release_tag "$RELEASE_JSON"); then
        fail "GitHub release response did not contain a valid tag_name"
    fi
    if [ -n "$REQUESTED_REF" ] && [ "$RELEASE_TAG" != "$REQUESTED_REF" ]; then
        fail "GitHub returned release $RELEASE_TAG for requested tag $REQUESTED_REF"
    fi
fi
clear_api_auth
RELEASE_TAG_ENCODED=$(percent_encode "$RELEASE_TAG")
case $RELEASE_TAG_ENCODED in
    ''|.|..) fail "release tag cannot be used as a version directory: $RELEASE_TAG" ;;
esac

RELEASE_BASE=$GITHUB_WEB/$REPOSITORY/releases/download/$RELEASE_TAG_ENCODED
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

VERSIONS_DIR=$INSTALL_ROOT/versions
CURRENT_PATH=$INSTALL_ROOT/current

INSTALL_DIRECTORY_STOP=$(nearest_existing_directory "$INSTALL_ROOT" && printf '_') ||
    fail "unable to find an existing parent for ATOMIC_INSTALL_DIR: $INSTALL_ROOT"
INSTALL_DIRECTORY_STOP=${INSTALL_DIRECTORY_STOP%_}
BIN_DIRECTORY_STOP=$(nearest_existing_directory "$BIN_DIR" && printf '_') ||
    fail "unable to find an existing parent for ATOMIC_BIN_DIR: $BIN_DIR"
BIN_DIRECTORY_STOP=${BIN_DIRECTORY_STOP%_}

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

VERSION_PATH=$VERSIONS_DIR/$RELEASE_TAG_ENCODED
VERSION_STAGE=$VERSIONS_DIR/.stage-$TRANSACTION_ID
VERSION_BACKUP=$VERSIONS_DIR/.backup-$TRANSACTION_ID
CURRENT_NEXT=$INSTALL_ROOT/.current-$TRANSACTION_ID
CURRENT_BACKUP=$INSTALL_ROOT/.current-backup-$TRANSACTION_ID
BIN_NEXT=$BIN_DIR/.atomic-$TRANSACTION_ID
BIN_BACKUP=$BIN_DIR/.atomic-backup-$TRANSACTION_ID

mv "$PAYLOAD_ROOT" "$VERSION_STAGE"
PAYLOAD_ROOT=
if path_exists "$VERSION_PATH"; then
    VERSION_BACKED_UP=1
    mv "$VERSION_PATH" "$VERSION_BACKUP"
fi
VERSION_INSTALLED=1
mv "$VERSION_STAGE" "$VERSION_PATH"
VERSION_STAGE=

ln -s "versions/$RELEASE_TAG_ENCODED" "$CURRENT_NEXT"
if path_exists "$CURRENT_PATH"; then
    CURRENT_BACKED_UP=1
    mv "$CURRENT_PATH" "$CURRENT_BACKUP"
fi
CURRENT_INSTALLED=1
mv "$CURRENT_NEXT" "$CURRENT_PATH"
CURRENT_NEXT=

ln -s "$CURRENT_PATH/atomic" "$BIN_NEXT"
if path_exists "$BIN_PATH"; then
    BIN_BACKED_UP=1
    mv "$BIN_PATH" "$BIN_BACKUP"
fi
BIN_INSTALLED=1
mv "$BIN_NEXT" "$BIN_PATH"
BIN_NEXT=

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

shell_quote() {
    shell_quote_input=$1
    printf '%s' "'"
    while [ -n "$shell_quote_input" ]; do
        shell_quote_character=${shell_quote_input%"${shell_quote_input#?}"}
        shell_quote_input=${shell_quote_input#?}
        case $shell_quote_character in
            "'") printf '%s' "'\\''" ;;
            *) printf '%s' "$shell_quote_character" ;;
        esac
    done
    printf '%s' "'"
}

printf 'Atomic %s installed successfully.\n' "$RELEASE_TAG"
printf 'Binary: %s\n' "$BIN_PATH"
case $BIN_DIR in
    *:*)
        printf '%s\n' "ATOMIC_BIN_DIR contains ':' and cannot be represented as one POSIX PATH entry."
        printf 'Run Atomic directly: '
        shell_quote "$BIN_PATH"
        printf '\n'
        printf '%s\n' "Choose a colon-free ATOMIC_BIN_DIR to add Atomic to PATH."
        ;;
    *)
        case :${PATH:-}: in
            *:"$BIN_DIR":*) ;;
            *)
                printf 'Add Atomic to PATH for this shell:\n'
                printf '  export PATH='
                shell_quote "$BIN_DIR"
                printf ':"$PATH"\n'
                ;;
        esac
        ;;
esac
