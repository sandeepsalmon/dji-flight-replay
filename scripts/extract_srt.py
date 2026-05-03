#!/usr/bin/env python3
"""
Generate DJI-style sidecar .SRT files from DJI MP4s that don't have them.

If "Video Subtitles" was off in DJI Fly when you recorded, your folder has
no .SRT — but the telemetry is still embedded in the MP4's `dbgi` metadata
track. This script reads it via exiftool and writes a .SRT next to each MP4
in the same bracketed-key/value format DJI Fly normally produces, so the
dji-replay-web viewer can consume it directly.

Requirements: exiftool (≥13). On macOS: `brew install exiftool`.

Usage:
  python3 extract_srt.py /path/to/dji/folder           # process every MP4
  python3 extract_srt.py /path/to/file.MP4             # process a single MP4
  python3 extract_srt.py file1.MP4 file2.MP4 ...       # multiple files
  python3 extract_srt.py --force /path/...             # overwrite existing SRTs
"""
import argparse
import os
import re
import subprocess
import sys


def dms_to_dd(s: str):
    m = re.match(r"(\d+)\s+deg\s+(\d+)'\s+([0-9.]+)\"\s+([NSEW])", s)
    if not m:
        return None
    d, mn, sec, hemi = int(m.group(1)), int(m.group(2)), float(m.group(3)), m.group(4)
    dd = d + mn / 60 + sec / 3600
    return -dd if hemi in ("S", "W") else dd


FIELD_MAP = {
    "Sample Time": "t_raw",
    "Sample Duration": "dt",
    "GPS Latitude": "lat",
    "GPS Longitude": "lon",
    "Absolute Altitude": "alt",
    "Relative Altitude": "alt_rel",
    "Drone Roll": "roll",
    "Drone Pitch": "pitch",
    "Drone Yaw": "yaw",
    "Gimbal Roll": "g_roll",
    "Gimbal Pitch": "g_pitch",
    "Gimbal Yaw": "g_yaw",
    "ISO": "iso",
    "Shutter Speed": "shutter",
    "F Number": "fnum",
}

LINE_RE = re.compile(r"^(.+?)\s*:\s*(.*)$")


def parse_exiftool(text: str):
    """Return list of per-frame records."""
    records = []
    cur = None
    for line in text.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        key = m.group(1).rstrip()
        val = m.group(2).strip()
        if key == "Sample Time":
            if cur is not None:
                records.append(cur)
            cur = {}
        if cur is None:
            continue
        short = FIELD_MAP.get(key)
        if not short:
            continue
        try:
            if short in ("lat", "lon"):
                v = dms_to_dd(val)
                if v is not None:
                    cur[short] = v
            elif short in ("alt", "alt_rel", "roll", "pitch", "yaw", "g_roll", "g_pitch", "g_yaw", "fnum"):
                cur[short] = float(val)
            elif short == "iso":
                cur[short] = int(val)
            elif short == "dt":
                cur[short] = float(val.split()[0])
            else:
                cur[short] = val
        except Exception:
            pass
    if cur is not None:
        records.append(cur)
    return records


def fmt_tc(s: float) -> str:
    h = int(s // 3600)
    s -= h * 3600
    m = int(s // 60)
    s -= m * 60
    sec = int(s)
    ms = int(round((s - sec) * 1000))
    if ms == 1000:
        ms = 0
        sec += 1
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


def to_srt(records: list[dict], fps: float = 30000.0 / 1001.0) -> str:
    # Anchor times to true frame rate; exiftool truncates Sample Duration to 0.03.
    out = []
    last = {}
    for i, r in enumerate(records):
        for k in ("lat", "lon", "alt"):
            if k in r:
                last[k] = r[k]
            elif k in last:
                r[k] = last[k]
    for i, r in enumerate(records):
        t0 = i / fps
        t1 = (i + 1) / fps
        parts = []
        if "iso" in r:
            parts.append(f"[iso: {int(r['iso'])}]")
        if "shutter" in r:
            parts.append(f"[shutter: {r['shutter']}]")
        if "fnum" in r:
            parts.append(f"[fnum: {int(round(float(r['fnum']) * 100))}]")
        if "lat" in r:
            parts.append(f"[latitude: {r['lat']:.6f}]")
        if "lon" in r:
            parts.append(f"[longitude: {r['lon']:.6f}]")
        if "alt" in r or "alt_rel" in r:
            parts.append(f"[rel_alt: {r.get('alt_rel', 0):.1f} abs_alt: {r.get('alt', 0):.3f}]")
        if any(k in r for k in ("g_yaw", "g_pitch", "g_roll")):
            parts.append(
                f"[gb_yaw: {r.get('g_yaw', 0):.1f} "
                f"gb_pitch: {r.get('g_pitch', 0):.1f} "
                f"gb_roll: {r.get('g_roll', 0):.1f}]"
            )
        if any(k in r for k in ("yaw", "pitch", "roll")):
            parts.append(
                f"[drone_yaw: {r.get('yaw', 0):.1f} "
                f"drone_pitch: {r.get('pitch', 0):.1f} "
                f"drone_roll: {r.get('roll', 0):.1f}]"
            )
        body = " ".join(parts) if parts else "(no telemetry)"
        out.append(f"{i + 1}\n{fmt_tc(t0)} --> {fmt_tc(t1)}\n{body}\n")
    return "\n".join(out)


def collect_mp4s(paths: list[str]) -> list[str]:
    out = []
    for p in paths:
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if f.lower().endswith((".mp4", ".mov")):
                    out.append(os.path.join(p, f))
        elif os.path.isfile(p):
            out.append(p)
        else:
            print(f"Skipping (not found): {p}", file=sys.stderr)
    return out


def process(mp4_path: str, force: bool) -> bool:
    srt_path = os.path.splitext(mp4_path)[0] + ".SRT"
    if os.path.exists(srt_path) and not force:
        print(f"·  skip   {os.path.basename(mp4_path)}  (SRT already exists; use --force to overwrite)")
        return True
    print(f"→  parse  {os.path.basename(mp4_path)}", flush=True)
    try:
        proc = subprocess.run(
            ["exiftool", "-ee3", "-api", "LargeFileSupport=1", mp4_path],
            check=True, capture_output=True, text=True,
        )
    except FileNotFoundError:
        print("\nexiftool not found. Install with `brew install exiftool` (or your platform's package manager).", file=sys.stderr)
        sys.exit(2)
    except subprocess.CalledProcessError as e:
        print(f"   ✗ exiftool failed: {e.stderr.strip()[:200]}", file=sys.stderr)
        return False
    records = parse_exiftool(proc.stdout)
    if not records:
        print(f"   ✗ no telemetry found (was the drone flying outdoors with GPS lock?)", file=sys.stderr)
        return False
    gps = sum(1 for r in records if "lat" in r and "lon" in r)
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(to_srt(records))
    print(f"   ✓ wrote {os.path.basename(srt_path)}  ({len(records)} cues, {gps} with GPS)")
    return True


def main():
    ap = argparse.ArgumentParser(description="Generate sidecar SRTs for DJI MP4s.")
    ap.add_argument("paths", nargs="+", help="folder or .MP4 file(s)")
    ap.add_argument("--force", action="store_true", help="overwrite existing .SRT files")
    args = ap.parse_args()
    mp4s = collect_mp4s(args.paths)
    if not mp4s:
        print("No MP4 files found.", file=sys.stderr)
        sys.exit(1)
    print(f"Processing {len(mp4s)} file(s)…\n")
    ok = sum(process(p, args.force) for p in mp4s)
    print(f"\nDone. {ok}/{len(mp4s)} succeeded.")


if __name__ == "__main__":
    main()
