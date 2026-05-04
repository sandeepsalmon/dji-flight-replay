# DJI Flight Replay

> **Try it:** [**dji-flight-replay.vercel.app**](https://dji-flight-replay.vercel.app)
> **Source:** github.com/sandeepsalmon/dji-flight-replay

```
                          ___
                       __/   \__              "Fly it again."
                      /   __    \
        +----+      _/   /  \    \_         drop a DJI video and the
       /    /     _/    |    |    \_       whole flight plays back —
      +----+    _/      \____/      \_       on the original footage,
                /                    \      on a satellite map, and
               (         <==>         )    inside a 3D chase camera.
                \                    /
                 \__       __       /
                    \_____/  \_____/
                     o            o          all in sync. all in
                                              your browser.
```

Drop a DJI video. The flight plays back across the original footage, a 2D satellite map, and a 3D chase camera, all in sync. Telemetry is parsed directly from the MP4's `djmd` metadata track, so most users don't need a sidecar `.SRT`.

The page is static. Your video never leaves your machine.

---

## What you get

```
   +--------------------+   +-----------+
   |                    |   |  2D MAP   |
   |   ORIGINAL VIDEO   |   |     ^     |
   |        + HUD       |   |    /|\    |
   |                    |   |   / | \   |
   +--------------------+   +-----------+
                            |  3D SCENE |
   +-----------------------+|  drone +  |
   |  Play  scrub   1x 2x  ||  trail    |
   +-----------------------++-----------+
```

- **Video pane** — the original footage with a quiet ALT / YAW / LAT / LON overlay
- **Map pane** — Esri satellite tiles, full flight path drawn, drone marker that tracks playback
- **3D pane** — the path in real-world meters, an orange drone that pitches/rolls/yaws with the actual flight
- **Footer controls** — Play, Restart, scrubber, speed (0.25× to 8×). Video is the master clock; the other panes follow.

The whole thing is one HTML file. ~87 KB. No build, no server, no upload.

---

## 3D scene controls

Bottom-right of the 3D pane:

```
   [+]  [−]  [Expand]
   zoom in   cycles Normal -> Bigger -> Fullscreen -> Normal
        zoom out
```

Top-right of the 3D pane:

```
   [Grid | Satellite | Map]   [Free | Follow]
   ground texture switcher    chase-camera toggle
```

- **Grid** is the default — abstract wireframe floor.
- **Satellite** stitches Esri World Imagery tiles onto the ground at zoom 18.
- **Map** uses Esri's road map tiles (zoom 16) so you can see streets and labels under the flight.
- **Free** lets you orbit/pan/zoom the camera. **Follow** chases the drone like a video game's third-person camera.
- **Expand** widens the 3D pane in-place; one more click goes browser-fullscreen on the 3D scene.

Drone height in the 3D scene reads DJI's `alt_rel` (height above takeoff), so the drone floats at its real height above the ground plane.

---

## Quick start

Run the hosted build:

> [**dji-flight-replay.vercel.app**](https://dji-flight-replay.vercel.app)

Or run it locally:

```bash
git clone https://github.com/sandeepsalmon/dji-flight-replay.git
cd dji-flight-replay
open index.html        # macOS
xdg-open index.html    # Linux
start index.html       # Windows
```

Then drag your DJI MP4 onto the page (or click the blue button to pick one).

If Chrome blocks the local file due to its `file://` rules, serve it over HTTP:

```bash
python3 -m http.server 8000
# visit http://localhost:8000
```

---

## How telemetry works

```
            DJI MP4
            +------+
            | moov |  <- read top-level boxes
            +------+
                |
                v
       +---------------+
       | trak (djmd)   |  <- protobuf metadata, one sample per video frame
       +---------------+
                |
                v
       per-sample protobuf
       3.3.4.1.2  -> GPS lat (radians, double)
       3.3.4.1.3  -> GPS lon (radians, double)
       3.3.4.2    -> abs altitude (int64 mm)
       3.3.5.1    -> rel altitude (float, /1000)
       3.3.3.x    -> drone roll/pitch/yaw (int64 deg/10)
       3.4.3.x    -> gimbal pitch/yaw (int64 deg/10)
       3.2.7.1    -> ISO (float)
       3.2.10.1   -> shutter (rational)
       3.2.11.1   -> f-number (rational)
                |
                v
        records: [{ t, lat, lon, alt, alt_rel, yaw, ... }, ...]
                |
                v
        viewer: video.currentTime drives sampleAt(t)
                with linear interpolation between samples
```

The schema came from reverse-engineering [exiftool](https://exiftool.org/)'s DJI module. Same field paths work on Mini 4 Pro, Mavic 3, Air 3, and most recent DJI consumer drones.

For older drones whose proto we don't recognise — or `.LRF` proxy files that don't carry telemetry — drop a matching `.SRT` sidecar (DJI Fly → gear → Camera → turn on Video Subtitles). The parser auto-detects two SRT format families.

If you have folders of footage with no SRTs, run the helper once:

```bash
python3 scripts/extract_srt.py /path/to/dji/folder
```

It calls `exiftool` for each MP4 and writes a sidecar SRT next to it.

---

## Multi-segment flights

DJI auto-splits long recordings at ~4 GB. Files end up named like:

```
DJI_20260503131609_0003_D.MP4   <- 3.7 GB
DJI_20260503131953_0004_D.MP4   <- 3.7 GB
DJI_20260503132336_0005_D.MP4   <- 1.7 GB
```

Select all the parts together (cmd-click in Finder, then drag in, or use the picker with multi-select). The loader sorts by the `_NNNN_` counter, reads telemetry from each, concatenates the records with cumulative time offsets, and swaps the video element's source on segment boundaries. Scrubbing across boundaries works the same as scrubbing inside a single segment.

Frame rate doesn't matter — 30 fps and 60 fps clips both line up against the video clock per-sample, so a 60 fps recording stays in sync with the map and the 3D scene throughout.

---

## Project layout

```
dji-flight-replay/
+-- index.html              <- bundled, what end users open
+-- src/
|   `-- index.html          <- template before the bundler
+-- css/
|   `-- style.css           <- Apple-style design tokens
+-- js/
|   +-- main.js             <- drag/drop, segment grouping
|   +-- mp4.js              <- minimal MP4 box parser
|   +-- dji.js              <- DJI protobuf telemetry extractor
|   +-- srt.js              <- DJI SRT format auto-detect parser
|   +-- satellite-plane.js  <- ground-plane tile stitcher (sat & streets)
|   `-- viewer.js           <- Leaflet 2D, Three.js 3D, sync engine
+-- scripts/
|   +-- build.py            <- bundles js+css into index.html (dedup imports)
|   `-- extract_srt.py      <- exiftool helper for older flights
+-- vercel.json             <- static-host config
+-- LICENSE
`-- README.md
```

Edit anything in `src/`, `js/`, or `css/`, then run `python3 scripts/build.py` to refresh `index.html`.

---

## Privacy

```
   user's drive                   browser
   +----------+                   +----------+
   |   .mp4   |  ----- read ----> |  parser  |
   +----------+                   +----------+
                                       |
                                       v
                                   +--------+
                                   | viewer |
                                   +--------+

   network: <Esri tiles, Leaflet/Three.js CDN — nothing else>
```

The `<video>` element plays the file via `URL.createObjectURL` — no upload. Map tiles come from Esri (third-party) and the JS libraries (Leaflet, Three.js) come from a CDN. That's all the network traffic. Open DevTools → Network tab and confirm.

---

## Browser support

```
   Safari     17+    works (file:// or hosted)
   Chrome     120+   hosted works; file:// needs python3 -m http.server
   Firefox    120+   works (file:// or hosted)
```

The hosted version at [dji-flight-replay.vercel.app](https://dji-flight-replay.vercel.app) avoids all of this — Chrome's `file://` module restriction doesn't apply over HTTPS.

---

## License

[CC BY 4.0](LICENSE) — free to use, modify, and redistribute. **Credit is required if you reuse or redistribute this code.** Keep the "Made by @sandeep" attribution somewhere visible: in the page footer, in your README, or in the source. That's the whole license, in one line.

If you build on this and ship something cool, I'd love to hear about it.

---

## Credits

```
                          @sandeep
                       made this thing
```

- Telemetry schema reverse-engineered from [exiftool](https://exiftool.org/)'s DJI module
- 2D map: [Leaflet](https://leafletjs.com/) + [Esri World Imagery](https://www.esri.com/en-us/arcgis/products/arcgis-online) tiles
- 3D scene: [Three.js](https://threejs.org/) (`Line2` for the thick path lines, `OrbitControls` for the camera)
- 3D ground texture: Esri World_Imagery (satellite) and World_Street_Map (roads)
- Design language adapted from Apple's product pages (no affiliation)

If you found a bug, broke the parser on an unusual DJI model, or have a flight that doesn't work, open an issue with the model name and a 30-second sample if you can share one.
