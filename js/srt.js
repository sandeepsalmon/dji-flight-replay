// DJI SRT telemetry parser.
//
// DJI Fly produces a sidecar .SRT subtitle file alongside the recorded MP4 when
// "Video Subtitles" is enabled. The file has gone through several formats over
// the years; this parser auto-detects and handles the major ones used by all
// current DJI consumer drones (Mini, Air, Mavic, Avata, Phantom).
//
// Output: array of { t, lat, lon, alt, alt_rel, yaw, pitch, roll,
//                    g_pitch, g_yaw, g_roll, iso, shutter, fnum, ... }
// where t is seconds from start of video.

const TIMECODE_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function timecodeToSec(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

// --- Format A: bracketed key/value (Mini 4 Pro, Mavic 3, Air 3, recent fw) ---
// Examples:
//   [iso: 100] [shutter: 1/100.0] [fnum: 280] [ev: 0]
//   [latitude: 10.003490] [longitude: 76.360330]
//   [rel_alt: 12.5 abs_alt: 22.0]
//   [drone_speed: 0.000] [gb_yaw: 0.0 gb_pitch: 0.0 gb_roll: 0.0]
//
// Also seen: "GPS: (lon, lat, alt)" inside brackets on some firmwares.
function parseBracketed(body) {
  const out = {};
  // Find every [...] group, then split inner text into "key: value" pairs.
  const groups = body.match(/\[([^\]]+)\]/g);
  if (!groups) return null;
  for (const g of groups) {
    const inner = g.slice(1, -1);
    // Split on whitespace before a "word:"; supports "rel_alt: 1 abs_alt: 2"
    const parts = inner.split(/(?=\s[a-z_]+\s*:)/i).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const colon = p.indexOf(':');
      if (colon < 0) continue;
      const key = p.slice(0, colon).trim().toLowerCase();
      const val = p.slice(colon + 1).trim();
      out[key] = val;
    }
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

function recordFromBracketed(kv) {
  const r = {};
  const num = (k) => kv[k] !== undefined ? Number(kv[k]) : undefined;
  // Some firmwares store latitude as integer*1e7 — detect by magnitude.
  let lat = num('latitude');
  let lon = num('longitude');
  if (lat !== undefined && Math.abs(lat) > 180) lat = lat / 1e7;
  if (lon !== undefined && Math.abs(lon) > 180) lon = lon / 1e7;
  if (lat !== undefined && !Number.isNaN(lat)) r.lat = lat;
  if (lon !== undefined && !Number.isNaN(lon)) r.lon = lon;
  // GPS triple inside one bracket: "GPS: -122.4194,37.7749,42"
  if (r.lat === undefined && kv.gps) {
    const m = kv.gps.match(/\(?\s*(-?[0-9.]+)\s*[,;]\s*(-?[0-9.]+)\s*[,;]\s*(-?[0-9.]+)\s*\)?/);
    if (m) { r.lon = +m[1]; r.lat = +m[2]; r.alt = +m[3]; }
  }
  if (kv.abs_alt !== undefined) r.alt = +kv.abs_alt;
  if (kv.rel_alt !== undefined) r.alt_rel = +kv.rel_alt;
  if (kv.altitude !== undefined && r.alt === undefined) r.alt = +kv.altitude;
  if (kv.height !== undefined && r.alt_rel === undefined) r.alt_rel = +kv.height;
  // Drone yaw/pitch/roll — DJI uses both "yaw"/"pitch"/"roll" and
  // "drone_yaw"/etc. across firmwares.
  for (const [src, dst] of [
    ['yaw', 'yaw'], ['pitch', 'pitch'], ['roll', 'roll'],
    ['drone_yaw', 'yaw'], ['drone_pitch', 'pitch'], ['drone_roll', 'roll'],
    ['gb_yaw', 'g_yaw'], ['gb_pitch', 'g_pitch'], ['gb_roll', 'g_roll'],
    ['gimbal_yaw', 'g_yaw'], ['gimbal_pitch', 'g_pitch'], ['gimbal_roll', 'g_roll'],
  ]) {
    if (kv[src] !== undefined && r[dst] === undefined) {
      const v = Number(kv[src]);
      if (!Number.isNaN(v)) r[dst] = v;
    }
  }
  if (kv.iso !== undefined) r.iso = parseInt(kv.iso, 10);
  if (kv.shutter !== undefined) r.shutter = kv.shutter;
  if (kv.fnum !== undefined) {
    // DJI bracketed format reports f-number as int *100: 280 → f/2.8
    const f = Number(kv.fnum);
    r.fnum = f >= 50 ? f / 100 : f;
  } else if (kv.f_number !== undefined) {
    r.fnum = Number(kv.f_number);
  }
  if (kv.ev !== undefined) r.ev = Number(kv.ev);
  if (kv.ct !== undefined) r.cct = parseInt(kv.ct, 10);
  if (kv.color_md !== undefined) r.color_md = kv.color_md;
  if (kv.focal_len !== undefined) r.focal = Number(kv.focal_len);
  if (kv.drone_speed !== undefined) r.speed = Number(kv.drone_speed);
  return r;
}

// --- Format B: compact CSV (older Mini, Mavic 2 Pro / Zoom, Spark) ---
// Example:
//   F/2.8, SS 1/100, ISO 100, EV 0, GPS (76.36033, 10.00349, 22), D 5.43m,
//   H 12.5m, H.S 0.0m/s, V.S 0.0m/s
//
// Note GPS ordering is (longitude, latitude, satellites?) on the original
// Mavic 2 export, but (longitude, latitude, altitude) on others. We assume
// the third value is altitude when it's > 5 — small ints are satellite count.
function recordFromCSV(body) {
  const r = {};
  // F/2.8 or F2.8
  let m = body.match(/F\/?\s*([0-9.]+)/i);
  if (m) r.fnum = Number(m[1]);
  m = body.match(/SS\s+([0-9./]+)/i);
  if (m) r.shutter = m[1];
  m = body.match(/ISO\s+(\d+)/i);
  if (m) r.iso = parseInt(m[1], 10);
  m = body.match(/EV\s+([+-]?[0-9.]+)/i);
  if (m) r.ev = Number(m[1]);
  m = body.match(/GPS\s*\(?\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)?/i);
  if (m) {
    const a = +m[1], b = +m[2], c = +m[3];
    r.lon = a; r.lat = b;
    if (Math.abs(c) > 5) r.alt = c;
  }
  m = body.match(/H\s+([-0-9.]+)\s*m\b/i);
  if (m) r.alt_rel = Number(m[1]);
  m = body.match(/H\.S\s+([-0-9.]+)\s*m\/s/i);
  if (m) r.speed_h = Number(m[1]);
  m = body.match(/V\.S\s+([-0-9.]+)\s*m\/s/i);
  if (m) r.speed_v = Number(m[1]);
  return Object.keys(r).length ? r : null;
}

// --- Public API ---
//
// parse(text) → array of telemetry records, each with { t, ... }, sorted by t.
// Throws on completely unrecognised input. Empty / GPS-less input returns []
// without throwing — caller should check for length.
export function parseSRT(text) {
  // Normalise newlines and strip BOM
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n\n+/);
  const records = [];
  let format = null; // 'bracketed' | 'csv'
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    // Locate timecode line (sometimes line 0, sometimes line 1 if cue index present)
    let tcLine = -1;
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      if (TIMECODE_RE.test(lines[i])) { tcLine = i; break; }
    }
    if (tcLine < 0) continue;
    const tc = lines[tcLine].match(TIMECODE_RE);
    const t = timecodeToSec(tc[1], tc[2], tc[3], tc[4]);
    const body = stripTags(lines.slice(tcLine + 1).join(' ')).trim();
    if (!body) continue;
    let rec = null;
    if (format === 'bracketed' || (format === null && body.includes('['))) {
      const kv = parseBracketed(body);
      if (kv) {
        rec = recordFromBracketed(kv);
        format = 'bracketed';
      }
    }
    if (!rec) {
      rec = recordFromCSV(body);
      if (rec && format === null) format = 'csv';
    }
    if (!rec) continue;
    rec.t = t;
    records.push(rec);
  }
  records.sort((a, b) => a.t - b.t);

  // Forward-fill GPS / altitude for early frames before lock
  const last = {};
  for (const r of records) {
    for (const k of ['lat', 'lon', 'alt', 'alt_rel']) {
      if (r[k] !== undefined && Number.isFinite(r[k])) last[k] = r[k];
      else if (last[k] !== undefined) r[k] = last[k];
    }
  }
  return records;
}
