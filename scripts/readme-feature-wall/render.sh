#!/usr/bin/env bash
# Turn a raw 1080p capture into the shipped GIF and JPG poster.
#
#   scripts/readme-feature-wall/render.sh 1.1 [1.2 ...]
#   scripts/readme-feature-wall/render.sh --all
#
# Pipeline, per row, driven by the trim/speed/poster fields in manifest.json:
#
#   raw mp4 -> ffmpeg trim + privacy mask + speed + 2:1 downscale -> PNG frames
#           -> gifski (final GIF encoder)                          -> .gif
#           -> ffmpeg single frame                                 -> .jpg poster
#
# gifski is the encoder for every shipped GIF. It keeps terminal text legible at
# a half-width README column far better than a palettegen/paletteuse GIF at the
# same byte budget.
#
# The privacy mask paints the statusline's provider/model segment with the
# terminal background colour. It masks one field; it never adds or invents UI.
# Everything else in frame is the real product.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
FW_BUILD="${FW_BUILD:-/private/tmp/atomic-feature-wall}"
OUT="$REPO/assets/feature-wall"
MANIFEST="$HERE/manifest.json"

# Shipped media contract (mirrored by validate.mjs).
W=960
H=540
BG="#1e1e2e"
# Statusline provider/model segment in the 1920x1080 capture, masked out.
MASK="x=0:y=918:w=592:h=54"

mkdir -p "$OUT" "$FW_BUILD/frames"

field() {
	node -e '
const m = require(process.argv[1]);
const l = m.lessons.find(x => x.id === process.argv[2]);
if (!l) { console.error("unknown row " + process.argv[2]); process.exit(1); }
const path = process.argv[3].split(".");
let v = l;
for (const k of path) v = v?.[k];
process.stdout.write(v === undefined || v === null ? "" : String(v));
' "$MANIFEST" "$1" "$2"
}

field_json() {
	node -e '
const m = require(process.argv[1]);
const l = m.lessons.find(x => x.id === process.argv[2]);
const path = process.argv[3].split(".");
let v = l;
for (const k of path) v = v?.[k];
process.stdout.write(v === undefined ? "" : JSON.stringify(v));
' "$MANIFEST" "$1" "$2"
}

render_one() {
	local id="$1"
	local slug start end segments speed fps quality poster_at mask extra_mask
	slug="$(field "$id" slug)"
	start="$(field "$id" render.start)"
	end="$(field "$id" render.end)"
	segments="$(field_json "$id" render.segments)"
	speed="$(field "$id" render.speed)"
	fps="$(field "$id" render.fps)"
	quality="$(field "$id" render.quality)"
	poster_at="$(field "$id" render.poster_at)"
	mask="$(field "$id" render.mask)"
	extra_mask="$(field "$id" render.extra_mask)"

	local raw="$FW_BUILD/raw/$id.mp4"
	[ -f "$raw" ] || { echo "missing capture: $raw" >&2; return 1; }

	local fdir="$FW_BUILD/frames/$id"
	rm -rf "$fdir"
	mkdir -p "$fdir"

	local vf="setpts=PTS/$speed,fps=$fps,scale=$W:$H:flags=lanczos"
	if [ "$mask" != "false" ]; then
		vf="drawbox=$MASK:color=$BG@1.0:t=fill,$vf"
		if [ -n "$extra_mask" ]; then
			vf="drawbox=$extra_mask:color=$BG@1.0:t=fill,$vf"
		fi
	fi

	if [ -n "$segments" ] && [ "$segments" != "null" ]; then
		# Some long real sessions need a chronological cut so the shipped clip
		# can show both the request and the result without holding unrelated work.
		# Every segment still comes from this row's one raw recording.
		local filter_complex
		filter_complex=$(node -e '
const segments = JSON.parse(process.argv[1]);
const vf = process.argv[2];
const trims = segments.map((segment, i) =>
	`[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${i}]`,
);
const inputs = segments.map((_, i) => `[v${i}]`).join("");
process.stdout.write(`${trims.join(";")};${inputs}concat=n=${segments.length}:v=1:a=0,${vf}[out]`);
' "$segments" "$vf")
		ffmpeg -y -v error -i "$raw" -filter_complex "$filter_complex" -map "[out]" -vsync 0 "$fdir/%05d.png"
	else
		ffmpeg -y -v error -ss "$start" -to "$end" -i "$raw" -vf "$vf" -vsync 0 "$fdir/%05d.png"
	fi

	# Second privacy pass: find and paint over private text wherever it sits in
	# the frame, not just in the statusline. See mask-frames.mjs.
	local maskargs=""
	[ "$mask" = "false" ] && maskargs="--no-statusline"
	node "$HERE/mask-frames.mjs" "$fdir" $maskargs

	gifski --fps "$fps" --width "$W" --height "$H" --quality "$quality" \
		--no-sort --output "$OUT/$slug.gif" "$fdir"/*.png >/dev/null 2>&1

	# Poster: a real frame of the finished clip, so it carries exactly the same
	# masking the GIF does and cannot disagree with it. The manifest's
	# poster_at is a timestamp in the raw capture, so it is converted into a
	# position inside the trimmed window. It used to be ignored in favour of a
	# flat 75%, which is how a poster came to show a different beat from the
	# one the row's alt text describes. POSTER_FRAC still overrides.
	local pframe
	pframe=$(node -e '
const {readdirSync}=require("node:fs");
const f=readdirSync(process.argv[1]).filter(n=>n.endsWith(".png")).sort();
const [start,end,posterAt,override,segmentsJson]=process.argv.slice(2);
let frac=Number(override);
if(!Number.isFinite(frac)||override===""){
  const p=Number(posterAt);
  const segments=segmentsJson&&segmentsJson!=="null"?JSON.parse(segmentsJson):null;
  if(Array.isArray(segments)&&segments.length>0&&Number.isFinite(p)){
    const total=segments.reduce((sum,segment)=>sum+segment.end-segment.start,0);
    let elapsed=0;
    for(const segment of segments){
      if(p>=segment.start&&p<=segment.end){elapsed+=p-segment.start;break;}
      elapsed+=segment.end-segment.start;
    }
    frac=total>0?elapsed/total:0.75;
  }else{
    const s=Number(start),e=Number(end);
    frac=Number.isFinite(s)&&Number.isFinite(e)&&Number.isFinite(p)&&e>s?(p-s)/(e-s):0.75;
  }
}
frac=Math.min(1,Math.max(0,frac));
const at=Math.min(f.length-1,Math.max(0,Math.round(frac*(f.length-1))));
process.stdout.write(f[at]??"");' "$fdir" "$start" "$end" "$poster_at" "${POSTER_FRAC:-}" "$segments")
	ffmpeg -y -v error -i "$fdir/$pframe" -q:v 3 "$OUT/$slug.jpg"

	local gsz jsz dur nframes efps
	gsz=$(du -k "$OUT/$slug.gif" | cut -f1)
	jsz=$(du -k "$OUT/$slug.jpg" | cut -f1)
	dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$slug.gif")
	nframes=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$OUT/$slug.gif")
	efps=$(node -e 'console.log((+process.argv[1]/+process.argv[2]).toFixed(2))' "$nframes" "$dur")
	printf '%-5s %-46s %6s KiB gif %5s KiB jpg  %5.5ss  %4s frames  %5s fps\n' "$id" "$slug" "$gsz" "$jsz" "$dur" "$nframes" "$efps"
}

if [ "${1:-}" = "--all" ]; then
	set -- $(node -e 'require(process.argv[1]).lessons.forEach(l=>console.log(l.id))' "$MANIFEST")
fi

for id in "$@"; do
	render_one "$id"
done
