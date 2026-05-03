// Minimal MP4 (ISO BMFF) parser. Just enough to locate the `djmd` metadata
// track in a DJI MP4 and return a list of {offset, size, time} pointers into
// the file so the protobuf extractor can read each sample.
//
// We never load the whole file — only the box headers we need (a few KB) and
// the moov atom (typically a few hundred KB even for hour-long recordings).

const TEXT = new TextDecoder('latin1');

function fourcc(arr, off) { return TEXT.decode(arr.subarray(off, off + 4)); }

class Reader {
  constructor(buf) { this.buf = buf; this.dv = new DataView(buf); this.p = 0; }
  get end() { return this.buf.byteLength; }
  read(n) { const r = new Uint8Array(this.buf, this.p, n); this.p += n; return r; }
  u8()    { return this.dv.getUint8(this.p++); }
  u16()   { const v = this.dv.getUint16(this.p);  this.p += 2; return v; }
  u24()   { const v = (this.dv.getUint16(this.p) << 8) | this.dv.getUint8(this.p + 2); this.p += 3; return v; }
  u32()   { const v = this.dv.getUint32(this.p);  this.p += 4; return v; }
  u64()   {
    const hi = this.dv.getUint32(this.p);
    const lo = this.dv.getUint32(this.p + 4);
    this.p += 8;
    // Number is fine for values < 2^53; MP4 sizes/offsets never exceed that.
    return hi * 0x100000000 + lo;
  }
  s32()   { const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  fourcc() { const s = TEXT.decode(this.read(4)); return s; }
  skip(n) { this.p += n; }
}

// Read top-level boxes from the File until we find moov. We do this by
// streaming 8-byte (or 16-byte) headers and seeking via File.slice() — most
// of the file is one giant `mdat` we want to skip without reading.
async function findMoov(file) {
  let pos = 0;
  while (pos < file.size) {
    const hdrEnd = Math.min(pos + 16, file.size);
    const hdrBuf = await file.slice(pos, hdrEnd).arrayBuffer();
    const hdr = new Uint8Array(hdrBuf);
    if (hdr.byteLength < 8) throw new Error('Unexpected EOF reading box header');
    const dv = new DataView(hdrBuf);
    let size = dv.getUint32(0);
    const type = fourcc(hdr, 4);
    let headerLen = 8;
    if (size === 1) {
      // 64-bit largesize
      const hi = dv.getUint32(8);
      const lo = dv.getUint32(12);
      size = hi * 0x100000000 + lo;
      headerLen = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (type === 'moov') {
      const moov = await file.slice(pos, pos + size).arrayBuffer();
      return { offset: pos, size, headerLen, data: moov };
    }
    pos += size;
  }
  throw new Error('moov atom not found');
}

// Walk every box recursively under a given parent buffer (bytes between
// `start` and `end`), yielding {type, start, end, payloadStart}. Container
// boxes (with sub-boxes) include a payload that itself contains boxes.
function* iterBoxes(buf, start, end) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(u8, p + 4);
    let headerLen = 8;
    if (size === 1) {
      const hi = dv.getUint32(p + 8), lo = dv.getUint32(p + 12);
      size = hi * 0x100000000 + lo;
      headerLen = 16;
    } else if (size === 0) {
      size = end - p;
    }
    yield { type, start: p, end: p + size, payloadStart: p + headerLen };
    p += size;
  }
}

// Container-box types. Boxes whose payload is a sequence of child boxes.
const CONTAINERS = new Set(['moov','trak','mdia','minf','stbl','dinf','udta','edts','mvex']);

// Build a tree of boxes for easy lookup.
function parseTree(buf, start, end) {
  const node = { children: [], byType: new Map() };
  for (const box of iterBoxes(buf, start, end)) {
    const child = { ...box, ...((CONTAINERS.has(box.type) ? parseTree(buf, box.payloadStart, box.end) : { children: [], byType: new Map() })) };
    node.children.push(child);
    if (!node.byType.has(box.type)) node.byType.set(box.type, []);
    node.byType.get(box.type).push(child);
  }
  return node;
}

function get(node, ...types) {
  let cur = node;
  for (const t of types) {
    const arr = cur.byType.get(t);
    if (!arr || arr.length === 0) return null;
    cur = arr[0];
  }
  return cur;
}

// Parse the boxes we need (stsd, stsz, stco/co64, stsc, stts, mdhd) for a
// given trak. Returns the per-sample (offset, size, time_seconds) tuples and
// the codec tag (so caller can confirm 'djmd').
function parseSampleTable(buf, trak) {
  const dv = new DataView(buf);
  const mdia = get(trak, 'mdia'); if (!mdia) return null;
  const mdhd = get(mdia, 'mdhd'); if (!mdhd) return null;
  const minf = get(mdia, 'minf'); if (!minf) return null;
  const stbl = get(minf, 'stbl'); if (!stbl) return null;
  const stsd = get(stbl, 'stsd');
  const stsz = get(stbl, 'stsz');
  const stco = get(stbl, 'stco') || get(stbl, 'co64');
  const stsc = get(stbl, 'stsc');
  const stts = get(stbl, 'stts');
  if (!stsd || !stsz || !stco || !stsc || !stts) return null;

  // mdhd: timescale at offset depending on version
  const mdhdVer = dv.getUint8(mdhd.payloadStart);
  const tsOff = mdhd.payloadStart + (mdhdVer === 1 ? 4 + 8 + 8 : 4 + 4 + 4);
  const timescale = dv.getUint32(tsOff);

  // stsd: ver+flags(4), entry_count(4), then entries. First entry: size(4) + format(4)
  const stsdEntries = dv.getUint32(stsd.payloadStart + 4);
  let codecTag = '';
  if (stsdEntries > 0) {
    const entryStart = stsd.payloadStart + 8;
    codecTag = fourcc(new Uint8Array(buf), entryStart + 4);
  }

  // stsz: ver+flags(4), sample_size(4), sample_count(4), [entries(4) each]
  const stszVF = dv.getUint32(stsz.payloadStart);
  void stszVF;
  const sampleSize = dv.getUint32(stsz.payloadStart + 4);
  const sampleCount = dv.getUint32(stsz.payloadStart + 8);
  const sizes = new Array(sampleCount);
  if (sampleSize !== 0) {
    sizes.fill(sampleSize);
  } else {
    let p = stsz.payloadStart + 12;
    for (let i = 0; i < sampleCount; i++) { sizes[i] = dv.getUint32(p); p += 4; }
  }

  // stco/co64
  const isCo64 = stco.type === 'co64';
  const chunkCount = dv.getUint32(stco.payloadStart + 4);
  const chunkOffsets = new Array(chunkCount);
  {
    let p = stco.payloadStart + 8;
    for (let i = 0; i < chunkCount; i++) {
      if (isCo64) {
        const hi = dv.getUint32(p), lo = dv.getUint32(p + 4);
        chunkOffsets[i] = hi * 0x100000000 + lo;
        p += 8;
      } else {
        chunkOffsets[i] = dv.getUint32(p);
        p += 4;
      }
    }
  }

  // stsc: entries of (first_chunk, samples_per_chunk, sample_desc_index)
  const stscCount = dv.getUint32(stsc.payloadStart + 4);
  const stscEntries = new Array(stscCount);
  {
    let p = stsc.payloadStart + 8;
    for (let i = 0; i < stscCount; i++) {
      stscEntries[i] = {
        firstChunk: dv.getUint32(p),
        samplesPerChunk: dv.getUint32(p + 4),
      };
      p += 12;
    }
  }
  // Expand to per-chunk samples-per-chunk
  const samplesPerChunk = new Array(chunkCount);
  for (let i = 0; i < stscCount; i++) {
    const cur = stscEntries[i];
    const nextFirst = i + 1 < stscCount ? stscEntries[i + 1].firstChunk : chunkCount + 1;
    for (let c = cur.firstChunk; c < nextFirst; c++) samplesPerChunk[c - 1] = cur.samplesPerChunk;
  }

  // Compute per-sample offsets
  const offsets = new Array(sampleCount);
  let si = 0;
  for (let ci = 0; ci < chunkCount && si < sampleCount; ci++) {
    let off = chunkOffsets[ci];
    const spc = samplesPerChunk[ci] || 0;
    for (let j = 0; j < spc && si < sampleCount; j++) {
      offsets[si] = off;
      off += sizes[si];
      si++;
    }
  }

  // stts: ver+flags(4), entry_count(4), entries(sample_count(4), sample_delta(4))
  const sttsCount = dv.getUint32(stts.payloadStart + 4);
  const times = new Array(sampleCount);
  let acc = 0, ti = 0;
  let pp = stts.payloadStart + 8;
  for (let i = 0; i < sttsCount; i++) {
    const cnt = dv.getUint32(pp);
    const dt = dv.getUint32(pp + 4);
    pp += 8;
    for (let j = 0; j < cnt && ti < sampleCount; j++) {
      times[ti++] = acc / timescale;
      acc += dt;
    }
  }

  return { codecTag, sizes, offsets, times, timescale, sampleCount };
}

// Public: given a File handle to a DJI MP4, return a parsed handle that
// contains the djmd track sample table. Throws if no djmd track found.
export async function openDJI(file) {
  const moov = await findMoov(file);
  const tree = parseTree(moov.data, 8, moov.size);
  const traks = tree.byType.get('trak') || [];
  let djmd = null;
  let dbgi = null;
  for (const trak of traks) {
    const tab = parseSampleTable(moov.data, trak);
    if (!tab) continue;
    if (tab.codecTag === 'djmd') djmd = tab;
    else if (tab.codecTag === 'dbgi') dbgi = tab;
  }
  if (!djmd && !dbgi) {
    throw new Error('No DJI metadata track (djmd/dbgi) found in this MP4. Is this a DJI drone recording?');
  }
  return { file, djmd, dbgi };
}

// Read a single sample's bytes from the file.
export async function readSample(handle, track, idx) {
  const tab = handle[track];
  if (!tab) throw new Error(`No ${track} track`);
  const off = tab.offsets[idx];
  const sz = tab.sizes[idx];
  const buf = await handle.file.slice(off, off + sz).arrayBuffer();
  return new Uint8Array(buf);
}

// Read a contiguous range of samples in one IO. The samples don't have to be
// contiguous on disk; we issue one slice() spanning min..max offsets and copy
// out per-sample slices. Faster than per-sample slice() in browsers.
export async function readSampleRange(handle, track, fromIdx, toIdx) {
  const tab = handle[track];
  let minOff = Infinity, maxEnd = 0;
  for (let i = fromIdx; i < toIdx; i++) {
    const o = tab.offsets[i];
    if (o < minOff) minOff = o;
    if (o + tab.sizes[i] > maxEnd) maxEnd = o + tab.sizes[i];
  }
  if (!Number.isFinite(minOff)) return [];
  const buf = await handle.file.slice(minOff, maxEnd).arrayBuffer();
  const u = new Uint8Array(buf);
  const out = new Array(toIdx - fromIdx);
  for (let i = fromIdx; i < toIdx; i++) {
    const off = tab.offsets[i] - minOff;
    out[i - fromIdx] = u.subarray(off, off + tab.sizes[i]);
  }
  return out;
}
