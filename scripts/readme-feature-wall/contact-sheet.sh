#!/usr/bin/env bash
# Contact sheets for visual review.
#
#   contact-sheet.sh raw 1.1        grid from the raw capture, with timestamps
#   contact-sheet.sh gif 1.1        grid from the shipped GIF
#   contact-sheet.sh gif --all      one sheet per shipped GIF
#
# "raw" sheets are how a trim window gets chosen: each tile is labelled with its
# source timestamp, so a window can be read straight off the sheet.
# "gif" sheets are the review artifact - they show what actually ships.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
FW_BUILD="${FW_BUILD:-/private/tmp/atomic-feature-wall}"
OUT="$FW_BUILD/sheets"
MANIFEST="$HERE/manifest.json"
FONT="/System/Library/Fonts/Menlo.ttc"

# Tile labels need drawtext, which the plain homebrew ffmpeg is built without.
# Prefer a build that has it; fall back to unlabelled tiles rather than failing.
FFT="ffmpeg"
LABEL=1
if [ -x /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg ]; then
	FFT=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
elif ! ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' drawtext '; then
	LABEL=0
fi
mkdir -p "$OUT"

mode="${1:?usage: contact-sheet.sh raw|gif <id|--all>}"
shift

slug_for() {
	node -e 'const m=require(process.argv[1]);const l=m.lessons.find(x=>x.id===process.argv[2]);process.stdout.write(l?l.slug:"")' "$MANIFEST" "$1"
}

fps_for() {
	node -e 'const m=require(process.argv[1]);const l=m.lessons.find(x=>x.id===process.argv[2]);process.stdout.write(String(l?.render?.fps??12))' "$MANIFEST" "$1"
}

render_field() {
	node -e 'const m=require(process.argv[1]);const path=process.argv[2].split(".");let v=m.render;for(const k of path)v=v?.[k];process.stdout.write(v==null?"":String(v))' "$MANIFEST" "$1"
}

longest_hold() {
	ffprobe -v error -select_streams v:0 \
		-show_entries frame=best_effort_timestamp_time,duration_time -of json "$1" | node -e '
const fs = require("node:fs");
const frames = JSON.parse(fs.readFileSync(0, "utf8")).frames ?? [];
let longest = { start: 0, duration: 0 };
for (const frame of frames) {
	const duration = Number(frame.duration_time);
	if (Number.isFinite(duration) && duration > longest.duration) {
		longest = { start: Number(frame.best_effort_timestamp_time) || 0, duration };
	}
}
process.stdout.write(`${longest.start.toFixed(2)}\t${longest.duration.toFixed(2)}\n`);'
}

sheet_one() {
	local id="$1" src
	if [ "$mode" = "raw" ]; then
		src="$FW_BUILD/raw/$id.mp4"
	else
		src="$REPO/assets/feature-wall/$(slug_for "$id").gif"
	fi
	[ -f "$src" ] || { echo "skip $id: no $src" >&2; return 0; }

	local dur hold_start="" hold_duration=""
	dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")
	if [ "$mode" = "gif" ]; then
		IFS=$'\t' read -r hold_start hold_duration < <(longest_hold "$src")
	fi

	local tiles=9 tmp i t vf fps
	fps="$(fps_for "$id")"
	tmp="$(mktemp -d)"
	for i in $(seq 0 $((tiles - 1))); do
		t=$(node -e 'const d=+process.argv[1],i=+process.argv[2],n=+process.argv[3];console.log((d*(i+0.5)/n).toFixed(2))' "$dur" "$i" "$tiles")
		vf="scale=480:270"
		if [ "$mode" = "gif" ]; then
			# Expand frame delays to the declared timing grid before trimming. A
			# held GIF frame has no later packet at an interior timestamp, so a
			# plain seek can return a later state or blank output instead of the
			# state actually visible at that time.
			vf="fps=$fps,trim=start=$t,setpts=PTS-STARTPTS,$vf"
		fi
		if [ "$LABEL" = "1" ]; then
			vf="$vf,drawtext=fontfile=${FONT}:text='${id} @ ${t}s':fontsize=18:x=8:y=8:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4"
		fi
		if [ "$mode" = "gif" ]; then
			"$FFT" -y -v error -i "$src" -frames:v 1 -vf "$vf" "$tmp/$(printf '%02d' "$i").png"
		else
			"$FFT" -y -v error -i "$src" -ss "$t" -frames:v 1 -vf "$vf" "$tmp/$(printf '%02d' "$i").png"
		fi
	done
	"$FFT" -y -v error -i "$tmp/%02d.png" -filter_complex "tile=3x3" -q:v 4 "$OUT/$mode-$id.jpg"
	rm -rf "$tmp"
	if [ "$mode" = "gif" ]; then
		printf '%s\t%s\t%s\t%s\n' "$id" "$dur" "$hold_start" "$hold_duration" >>"$HOLD_REPORT"
		local warning
		warning=""
		if awk -v hold="$hold_duration" -v threshold="$HOLD_WARNING" 'BEGIN { exit !(hold >= threshold) }'; then
			warning="; REVIEW longest held frame ${hold_duration}s at ${hold_start}s"
		fi
		echo "$OUT/$mode-$id.jpg  (source ${dur}s; longest hold ${hold_duration}s at ${hold_start}s${warning})"
	else
		echo "$OUT/$mode-$id.jpg  (source ${dur}s)"
	fi
}

HOLD_REPORT="$OUT/gif-holds.tsv"
HOLD_WARNING="$(render_field review_hold_warning_s)"
HOLD_WARNING="${HOLD_WARNING:-3}"
if [ "${1:-}" = "--all" ]; then
	if [ "$mode" = "gif" ]; then
		printf 'row\tduration_s\thold_start_s\thold_duration_s\n' >"$HOLD_REPORT"
	fi
	set -- $(node -e 'require(process.argv[1]).lessons.forEach(l=>console.log(l.id))' "$MANIFEST")
elif [ "$mode" = "gif" ]; then
	printf 'row\tduration_s\thold_start_s\thold_duration_s\n' >"$HOLD_REPORT"
fi
for id in "$@"; do sheet_one "$id"; done
