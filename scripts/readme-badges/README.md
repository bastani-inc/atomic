# README badges

The root README has three compact generated badge groups: 19 engineering-stack entries, 28 hosted/provider brands, and 15 local/open entries. `manifest.json` owns their exact order, destinations, local SVG paths, alt text, icon geometry, and source or fallback record.

## Contract

- Every README image points to `assets/readme-badges/<group>/<slug>.svg`.
- Every badge is self-contained SVG with a dark `#181825` field, local icon geometry, and visible label text.
- Badges contain no `<image>`, external `href`, imported CSS, or fetched font.
- Vectors come from the pinned `simple-icons@16.28.0` package or a recorded first-party source. A clean monogram or generic terminal glyph is used only when the source audit found no reusable compact vector.
- Provider badges mean Atomic has a documented integration path. Availability still depends on credentials, subscription, region, and the current provider catalog.
- Local/open family badges are representative compatibility examples, not an allowlist or a promise of tool support.

The root README region uses the stable `readme-badges:start/end` markers. Do not hand-edit it or the generated SVG files. Source and fallback notes are generated beside the assets in `assets/readme-badges/README.md`.

## Generate and check

```bash
node scripts/readme-badges/generate.mjs
node scripts/readme-badges/generate.mjs --check
node scripts/readme-feature-wall/validate.mjs
```

Generation needs only Node.js and the checked-in manifest. It does not access the network and adds no package dependency. The feature-wall validator carries an independent copy of all 62 expected entries and checks the manifest, README markup, links, paths, alts, group placement, SVG XML, icon geometry, visible labels, and external-reference bans.
