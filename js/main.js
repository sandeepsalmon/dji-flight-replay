// Drag-and-drop loader. The good UX is: drop just the MP4. We try to read
// telemetry directly from the MP4's djmd track. If the user dropped an SRT
// alongside, that's used as a fallback for older drone firmwares whose proto
// schema we don't recognise.
//
// Multi-segment flights: DJI auto-splits long recordings at ~4 GB into
// consecutively-numbered files (DJI_<ts>_0003_D.MP4, _0004_D.MP4, …). The
// loader detects siblings by filename and concatenates them into one
// continuous flight (telemetry stitched, video clips played back-to-back).

import { parseSRT } from './srt.js';
import { extractTelemetry } from './dji.js';
import { initViewer } from './viewer.js';

const dropEl = document.getElementById('drop');
const zoneEl = document.getElementById('zone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const errEl = document.getElementById('err');
const appEl = document.getElementById('app');
const reloadBtn = document.getElementById('reload');

let pendingVideos = [];   // sorted by DJI counter
let pendingSRT = null;
let currentBlobURLs = [];
let teardown = null;

function setError(msg) { errEl.textContent = msg || ''; errEl.classList.remove('busy'); }
function setBusy(msg)  { errEl.textContent = msg || ''; errEl.classList.add('busy'); }

function renderFileList() {
  fileList.innerHTML = '';
  for (const v of pendingVideos) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = `📹 ${v.name} · ${(v.size / 1024 / 1024).toFixed(0)} MB`;
    fileList.appendChild(pill);
  }
  if (pendingSRT) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = `SRT · ${pendingSRT.name}`;
    fileList.appendChild(pill);
  }
}

function classify(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.mp4') || name.endsWith('.mov') || name.endsWith('.m4v') || name.endsWith('.lrf')) return 'video';
  if (name.endsWith('.srt')) return 'srt';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type === 'application/x-subrip' || file.type === 'text/srt') return 'srt';
  return null;
}

function videoBlobURL(file) {
  if (file.name.toLowerCase().endsWith('.lrf')) {
    return URL.createObjectURL(new Blob([file], { type: 'video/mp4' }));
  }
  return URL.createObjectURL(file);
}

// DJI naming: DJI_YYYYMMDDHHMMSS_NNNN_<suffix>.<ext>. Files of one flight
// share the timestamp prefix when split (rare) — but more commonly each
// segment carries its own start-time. The reliable signal across all DJI
// models is the consecutive NNNN counter when the user provides multiple
// files in one batch. We sort by that counter.
function parseDJIName(name) {
  const m = name.match(/^DJI_(\d{14})_(\d{4})_(\w+)\.(MP4|MOV|LRF)$/i);
  if (!m) return null;
  return {
    ts: m[1],
    counter: parseInt(m[2], 10),
    suffix: m[3].toUpperCase(),
    ext: m[4].toUpperCase(),
  };
}

function sortVideosByCounter(files) {
  return files.slice().sort((a, b) => {
    const ai = parseDJIName(a.name);
    const bi = parseDJIName(b.name);
    if (ai && bi) return ai.counter - bi.counter;
    return a.name.localeCompare(b.name);
  });
}

async function tryStart() {
  if (pendingVideos.length === 0) return;
  setError('');

  const segmentRecords = [];   // per-file telemetry (each starts at t=0)
  const segmentDurations = []; // per-file video duration in seconds
  let useSRTFallback = false;

  // 1) Try in-MP4 telemetry per segment.
  for (let si = 0; si < pendingVideos.length; si++) {
    const f = pendingVideos[si];
    const isMP4 = /\.(mp4|mov|m4v)$/i.test(f.name);
    if (!isMP4) { useSRTFallback = true; segmentRecords.push(null); continue; }
    setBusy(`Reading telemetry from segment ${si + 1}/${pendingVideos.length} (${f.name})…`);
    console.log('[dji-replay] extracting from', f.name);
    try {
      const recs = await extractTelemetry(f, (done, total) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        setBusy(`Reading telemetry from segment ${si + 1}/${pendingVideos.length} — ${pct}%`);
      });
      segmentRecords.push(recs);
    } catch (e) {
      console.warn('[dji-replay] segment parse failed:', f.name, e.message);
      segmentRecords.push(null);
      useSRTFallback = true;
    }
  }

  // 2) Get each segment's video duration (we read it via a hidden <video>).
  setBusy('Measuring video durations…');
  for (let si = 0; si < pendingVideos.length; si++) {
    segmentDurations.push(await measureDuration(pendingVideos[si]));
  }

  // 3) If any segment failed in-MP4 parse, fall back to SRT for that one.
  let records = null;
  let source = 'mp4';
  if (useSRTFallback || segmentRecords.some(r => r === null || r.length === 0 ||
        r.filter(x => x.lat !== undefined).length === 0)) {
    if (pendingSRT && pendingVideos.length === 1) {
      // Single-segment SRT fallback (the simple case).
      try {
        records = parseSRT(await pendingSRT.text());
        source = 'srt';
      } catch (e) {
        setError(`SRT parse failed: ${e.message}`);
        return;
      }
    } else {
      setError('Some segments had no readable telemetry. Try the .SRT sidecar files instead, ' +
               'or run scripts/extract_srt.py on the folder once.');
      return;
    }
  } else {
    // Concatenate per-segment records with cumulative time offsets aligned
    // to the actual video durations (not telemetry's frame-anchored time).
    records = [];
    let offset = 0;
    for (let si = 0; si < segmentRecords.length; si++) {
      const segRecs = segmentRecords[si];
      const vDur = segmentDurations[si] || (segRecs[segRecs.length - 1].t + 1 / 29.97);
      for (const r of segRecs) records.push({ ...r, t: r.t + offset });
      offset += vDur;
    }
  }

  if (records.length === 0 || records.filter(r => r.lat !== undefined).length === 0) {
    setError('No GPS telemetry found in any segment.');
    return;
  }

  // Build segment list for the viewer (URL + start time + duration each)
  for (const u of currentBlobURLs) URL.revokeObjectURL(u);
  currentBlobURLs = pendingVideos.map(videoBlobURL);
  const segments = pendingVideos.map((f, i) => ({
    name: f.name,
    url: currentBlobURLs[i],
    start: segmentDurations.slice(0, i).reduce((s, d) => s + d, 0),
    duration: segmentDurations[i],
  }));

  if (teardown) { try { teardown(); } catch (_) {} teardown = null; }

  dropEl.style.display = 'none';
  appEl.classList.add('active');

  try {
    teardown = initViewer(records, segments);
    const meta = document.getElementById('meta');
    if (meta) {
      const totalDur = segments.reduce((s, x) => s + x.duration, 0);
      meta.textContent += `  ·  ${pendingVideos.length} segment${pendingVideos.length > 1 ? 's' : ''} · ${totalDur.toFixed(1)}s · source: ${source.toUpperCase()}`;
    }
  } catch (e) {
    console.error(e);
    setError(`Viewer failed to start: ${e.message}`);
    appEl.classList.remove('active');
    dropEl.style.display = '';
  }
}

// Read a video file's duration via a one-shot detached <video>.
function measureDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const url = URL.createObjectURL(
      file.name.toLowerCase().endsWith('.lrf')
        ? new Blob([file], { type: 'video/mp4' })
        : file,
    );
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      URL.revokeObjectURL(url);
      resolve(d);
    });
    v.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      resolve(0);
    });
  });
}

function acceptFiles(files) {
  if (!files || files.length === 0) return;
  const newVideos = [];
  for (const f of files) {
    const kind = classify(f);
    if (kind === 'video') newVideos.push(f);
    else if (kind === 'srt') pendingSRT = f;
  }
  if (newVideos.length) {
    // Merge with any already-pending videos (in case of multi-step drop)
    const all = [...pendingVideos, ...newVideos];
    // De-dupe by name
    const seen = new Set();
    pendingVideos = all.filter(f => seen.has(f.name) ? false : (seen.add(f.name), true));
    pendingVideos = sortVideosByCounter(pendingVideos);
  }
  renderFileList();
  if (pendingVideos.length === 0 && pendingSRT) {
    setError('Got the .SRT. Now drop the matching video(s).');
    return;
  }
  if (pendingVideos.length === 0) return;

  // Hint about siblings if user dropped a single file from a multi-counter set.
  const counters = pendingVideos.map(f => parseDJIName(f.name)?.counter).filter(c => c != null);
  if (counters.length === 1) {
    setError('Tip: long DJI flights split across multiple files (counter _0003, _0004, …). ' +
             'If this segment looks shorter than the actual flight, drop the others too.');
    // Still try to start with the single file — it works for short flights.
  }
  setError('');
  tryStart();
}

['dragenter', 'dragover'].forEach(evt => {
  document.body.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    zoneEl.classList.add('over');
  });
});
['dragleave', 'drop'].forEach(evt => {
  document.body.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (evt === 'dragleave' && e.target !== document.body && e.relatedTarget) return;
    zoneEl.classList.remove('over');
  });
});
document.body.addEventListener('drop', (e) => acceptFiles(e.dataTransfer?.files));
fileInput.addEventListener('change', () => acceptFiles(fileInput.files));

reloadBtn.addEventListener('click', () => {
  if (teardown) { try { teardown(); } catch (_) {} teardown = null; }
  for (const u of currentBlobURLs) URL.revokeObjectURL(u);
  currentBlobURLs = [];
  pendingVideos = [];
  pendingSRT = null;
  fileInput.value = '';
  renderFileList();
  setError('');
  appEl.classList.remove('active');
  dropEl.style.display = '';
});

renderFileList();
