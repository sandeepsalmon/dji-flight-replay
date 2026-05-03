// DJI per-frame telemetry extractor.
//
// Operates on the `djmd` track samples that mp4.js exposes. Each sample is a
// protobuf message with a known schema (per DJI model). The schema is shared
// with — and reverse-engineered from — exiftool's DJI module, specifically:
//
//   djmd field path  3.3.4.1.2  → GPSLatitude   (double, radians)
//                    3.3.4.1.3  → GPSLongitude  (double, radians)
//                    3.3.4.1.1  → CoordinateUnits (1 = already in degrees)
//                    3.3.4.2    → AbsoluteAltitude (int64 mm → /1000 = m)
//                    3.3.5.1    → RelativeAltitude (float, /1000 = m)
//                    3.3.3.1    → DroneRoll  (int64, /10 = degrees)
//                    3.3.3.2    → DronePitch
//                    3.3.3.3    → DroneYaw
//                    3.4.3.1    → GimbalPitch
//                    3.4.3.3    → GimbalYaw
//                    3.2.7.1    → ISO         (float)
//                    3.2.10.1   → ShutterSpeed (rational: 1/2 = numerator/denominator)
//                    3.2.11.1   → FNumber      (rational)
//                    3.2.32.1   → ColorTemperature (uint)
//                    3.2.37.1   → Temperature  (float)
//
// These paths are identical for Mini 4 Pro, Mavic 3, Air 3, Phantom 4, etc.
// — DJI keeps them stable across newer firmwares. Older drones (Mavic 1,
// Spark) used different paths; for those the parser falls back to "no
// in-MP4 telemetry" and the user should use scripts/extract_srt.py.

import { openDJI, readSampleRange } from './mp4.js';

// ---------- Protobuf reading ----------
// We decode raw protobuf without a schema, then walk known field paths.

function readVarint(buf, p) {
  let v = 0n; let sh = 0n;
  while (true) {
    if (p >= buf.length) return [null, p];
    const b = buf[p++];
    v |= BigInt(b & 0x7f) << sh;
    if ((b & 0x80) === 0) break;
    sh += 7n;
  }
  return [v, p];
}

// Get the raw (wire-type, payload) of `targetField` in the message at
// buf[start..end]. Skips other fields. Returns null if not found.
function getField(buf, start, end, targetField) {
  let p = start;
  while (p < end) {
    let key;
    [key, p] = readVarint(buf, p);
    if (key === null) return null;
    const fn = Number(key >> 3n);
    const wt = Number(key & 7n);
    if (wt === 0) {
      let v;
      [v, p] = readVarint(buf, p);
      if (v === null) return null;
      if (fn === targetField) return { wt, varint: v, p };
    } else if (wt === 1) {
      if (p + 8 > end) return null;
      if (fn === targetField) return { wt, bytes: buf.subarray(p, p + 8), p: p + 8 };
      p += 8;
    } else if (wt === 2) {
      let ln;
      [ln, p] = readVarint(buf, p);
      if (ln === null) return null;
      const ln_ = Number(ln);
      if (p + ln_ > end) return null;
      if (fn === targetField) return { wt, bytes: buf.subarray(p, p + ln_), p: p + ln_ };
      p += ln_;
    } else if (wt === 5) {
      if (p + 4 > end) return null;
      if (fn === targetField) return { wt, bytes: buf.subarray(p, p + 4), p: p + 4 };
      p += 4;
    } else {
      return null;
    }
  }
  return null;
}

// Walk a path of nested length-delimited fields to a leaf.
function walkPath(buf, path) {
  let cur = buf;
  let start = 0, end = cur.length;
  for (let i = 0; i < path.length - 1; i++) {
    const f = getField(cur, start, end, path[i]);
    if (!f || f.wt !== 2) return null;
    cur = f.bytes;
    start = 0; end = cur.length;
  }
  return getField(cur, start, end, path[path.length - 1]);
}

const _dv = new DataView(new ArrayBuffer(8));
function asFloat(bytes) {
  for (let i = 0; i < 4; i++) _dv.setUint8(i, bytes[i]);
  return _dv.getFloat32(0, true);
}
function asDouble(bytes) {
  for (let i = 0; i < 8; i++) _dv.setUint8(i, bytes[i]);
  return _dv.getFloat64(0, true);
}
// Protobuf int64 stored as varint is unsigned by default; cast to signed.
function asSignedInt(big) {
  const u = BigInt.asUintN(64, big);
  const s = BigInt.asIntN(64, u);
  return Number(s);
}

// Extract a single record from one djmd sample's bytes.
function extractRecord(sample) {
  const r = {};
  // GPS
  const coordUnits = walkPath(sample, [3, 3, 4, 1, 1]);
  const isDeg = coordUnits && coordUnits.wt === 0 && Number(coordUnits.varint) === 1;
  const lat = walkPath(sample, [3, 3, 4, 1, 2]);
  const lon = walkPath(sample, [3, 3, 4, 1, 3]);
  if (lat && lat.wt === 1) {
    let v = asDouble(lat.bytes);
    if (!isDeg) v = v * 180 / Math.PI;
    if (Number.isFinite(v) && Math.abs(v) <= 90) r.lat = v;
  }
  if (lon && lon.wt === 1) {
    let v = asDouble(lon.bytes);
    if (!isDeg) v = v * 180 / Math.PI;
    if (Number.isFinite(v) && Math.abs(v) <= 180) r.lon = v;
  }
  // Altitude (absolute mm as int64)
  const absAlt = walkPath(sample, [3, 3, 4, 2]);
  if (absAlt && absAlt.wt === 0) {
    const v = asSignedInt(absAlt.varint) / 1000;
    if (Number.isFinite(v)) r.alt = v;
  }
  // Relative altitude (float, also stored as scaled ÷1000 per exiftool convention)
  const relAlt = walkPath(sample, [3, 3, 5, 1]);
  if (relAlt) {
    if (relAlt.wt === 5) r.alt_rel = asFloat(relAlt.bytes) / 1000;
    else if (relAlt.wt === 0) r.alt_rel = asSignedInt(relAlt.varint) / 1000;
  }
  // Drone yaw/pitch/roll (×10)
  const droneInfo = walkPath(sample, [3, 3, 3]);
  if (droneInfo && droneInfo.wt === 2) {
    const sub = droneInfo.bytes;
    const r1 = getField(sub, 0, sub.length, 1);
    const r2 = getField(sub, 0, sub.length, 2);
    const r3 = getField(sub, 0, sub.length, 3);
    if (r1 && r1.wt === 0) r.roll = asSignedInt(r1.varint) / 10;
    if (r2 && r2.wt === 0) r.pitch = asSignedInt(r2.varint) / 10;
    if (r3 && r3.wt === 0) r.yaw = asSignedInt(r3.varint) / 10;
  }
  // Gimbal (×10)
  const gimbal = walkPath(sample, [3, 4, 3]);
  if (gimbal && gimbal.wt === 2) {
    const sub = gimbal.bytes;
    const r1 = getField(sub, 0, sub.length, 1);
    const r3 = getField(sub, 0, sub.length, 3);
    if (r1 && r1.wt === 0) r.g_pitch = asSignedInt(r1.varint) / 10;
    if (r3 && r3.wt === 0) r.g_yaw   = asSignedInt(r3.varint) / 10;
  }
  // ISO
  const iso = walkPath(sample, [3, 2, 7, 1]);
  if (iso && iso.wt === 5) r.iso = Math.round(asFloat(iso.bytes));
  // Shutter / FNumber: DJI stores these as a "rational" — two packed varints
  // (numerator, denominator) inside the leaf's length-delimited payload.
  // (See exiftool DJI.pm Format => 'rational' for details.)
  function readRational(leaf) {
    if (!leaf || leaf.wt !== 2) return null;
    const b = leaf.bytes;
    let p = 0;
    let n; [n, p] = readVarint(b, p); if (n === null) return null;
    let d; [d, p] = readVarint(b, p); if (d === null) return null;
    return [Number(n), Number(d)];
  }
  const shr = readRational(walkPath(sample, [3, 2, 10, 1]));
  if (shr && shr[1] > 0) r.shutter = `${shr[0]}/${shr[1]}`;
  const fnr = readRational(walkPath(sample, [3, 2, 11, 1]));
  if (fnr && fnr[1] > 0) r.fnum = fnr[0] / fnr[1];
  // CCT
  const cct = walkPath(sample, [3, 2, 32, 1]);
  if (cct && cct.wt === 0) r.cct = Number(cct.varint);
  // Temperature
  const temp = walkPath(sample, [3, 2, 37, 1]);
  if (temp && temp.wt === 5) r.temp = asFloat(temp.bytes);
  return r;
}

// Public: extract telemetry from a DJI MP4 File. onProgress(done, total).
export async function extractTelemetry(file, onProgress) {
  const handle = await openDJI(file);
  const tab = handle.djmd;
  if (!tab) throw new Error('No djmd track found.');
  const N = tab.sampleCount;
  const records = new Array(N);

  // Process in batches to stream IO and provide progress.
  const BATCH = 1500;
  for (let i = 0; i < N; i += BATCH) {
    const j = Math.min(i + BATCH, N);
    const samples = await readSampleRange(handle, 'djmd', i, j);
    for (let k = 0; k < samples.length; k++) {
      const idx = i + k;
      const rec = extractRecord(samples[k]);
      rec.t = tab.times[idx];
      records[idx] = rec;
    }
    if (onProgress) onProgress(j, N);
    // Yield to UI between batches
    await new Promise(r => setTimeout(r, 0));
  }

  // Forward-fill GPS and altitude through pre-lock frames.
  const last = {};
  for (const r of records) {
    for (const k of ['lat', 'lon', 'alt', 'alt_rel']) {
      if (r[k] !== undefined && Number.isFinite(r[k])) last[k] = r[k];
      else if (last[k] !== undefined) r[k] = last[k];
    }
  }

  // Per-sample times come from the djmd track's stts box (parsed in mp4.js,
  // attached as rec.t at extraction time). Those are precise to the track's
  // own timescale, so we use them as-is — anchoring to a hardcoded fps would
  // double-time 60 fps recordings and miscalibrate any future variable-rate
  // capture.
  return records;
}
