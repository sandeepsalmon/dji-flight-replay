// Flight viewer: 2D map + 3D scene + telemetry HUD, all driven by the
// HTML <video> element as the master playback clock. Ported from the original
// inline viewer at /tmp/build_html.py.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSatellitePlane } from './satellite-plane.js';

// init(records, segments): set up everything and start the render loop.
// records:  array of telemetry records sorted by .t (seconds from flight start)
// segments: array of {url, start, duration} describing one or more video clips
//           that play back-to-back, e.g. DJI's auto-split chunks.
//           Pass a single-element array for a non-split flight.
//           For backwards-compat we also accept a plain string URL.
export function initViewer(records, segments) {
  if (!records.length) throw new Error('No telemetry records');

  const SEGMENTS = (typeof segments === 'string')
    ? [{ url: segments, start: 0, duration: records[records.length - 1].t - records[0].t + 0.04 }]
    : segments;
  if (!SEGMENTS.length) throw new Error('No video segments provided');

  const DATA = records;
  const T0 = DATA[0].t;
  const T_END = DATA[DATA.length - 1].t;
  const TIMES = DATA.map(d => d.t);
  // Total playback duration is the sum of segment durations (so the scrubber
  // matches what the eye sees, even if telemetry covers slightly more/less).
  let DURATION = SEGMENTS.reduce((s, x) => s + x.duration, 0) || (T_END - T0);

  document.getElementById('meta').textContent =
    `${DATA.length} samples · ${DURATION.toFixed(1)}s · ` +
    `${DATA.filter(d => d.lat !== undefined).length} GPS fixes`;

  // ---------- Interpolation helpers ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  function lerpAngle(a, b, t) {
    const d = ((b - a) % 360 + 540) % 360 - 180;
    return a + d * t;
  }
  function findIndex(t) {
    let lo = 0, hi = TIMES.length - 1;
    if (t <= TIMES[0]) return 0;
    if (t >= TIMES[hi]) return hi - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      if (TIMES[m] <= t) lo = m; else hi = m;
    }
    return lo;
  }
  function sampleAt(t) {
    const i = findIndex(t);
    const a = DATA[i], b = DATA[Math.min(i + 1, DATA.length - 1)];
    const span = b.t - a.t;
    const u = span > 0 ? Math.max(0, Math.min(1, (t - a.t) / span)) : 0;
    const out = { t, _idx: i };
    for (const k of ['lat', 'lon', 'alt', 'alt_rel', 'iso', 'fnum', 'temp', 'cct']) {
      if (a[k] !== undefined && b[k] !== undefined) out[k] = lerp(a[k], b[k], u);
      else out[k] = a[k] ?? b[k];
    }
    for (const k of ['yaw', 'pitch', 'roll', 'g_pitch', 'g_yaw', 'g_roll']) {
      if (a[k] !== undefined && b[k] !== undefined) out[k] = lerpAngle(a[k], b[k], u);
      else out[k] = a[k] ?? b[k];
    }
    out.shutter = a.shutter ?? b.shutter;
    return out;
  }

  // ---------- 2D Map ----------
  const gpsPoints = DATA.filter(d => d.lat !== undefined && d.lon !== undefined);
  const latlngs = gpsPoints.map(d => [d.lat, d.lon]);
  const map = L.map('map', { zoomControl: true, preferCanvas: true });
  // Esri World_Imagery only ships native tiles up to ~zoom 19 (and ~20 in
  // dense urban areas). Cap requests at 19 and let Leaflet upscale beyond
  // that — otherwise tight flight paths trigger "Map data not available".
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri', maxZoom: 22, maxNativeZoom: 19 }).addTo(map);
  L.polyline(latlngs, { color: '#58a6ff', weight: 2, opacity: 0.85 }).addTo(map);
  const traveledCoords = [];
  const traveled = L.polyline(traveledCoords, { color: '#ff6b35', weight: 3, opacity: 0.95 }).addTo(map);
  let traveledIdx = 0;
  if (latlngs.length) {
    // Clamp auto-zoom: very tight flights would otherwise zoom past native
    // tile resolution, leaving a single stretched tile.
    map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 18 });
  } else {
    map.setView([0, 0], 2);
  }
  // The map container often resolves its size after the browser does layout.
  // Tell Leaflet to re-tile once that's settled — otherwise it commits to a
  // stale (often tiny) viewport size and only loads one or two tiles.
  setTimeout(() => map.invalidateSize(), 50);
  requestAnimationFrame(() => map.invalidateSize());
  const droneIcon = L.divIcon({
    className: 'drone-icon',
    html: '<div style="width:18px;height:18px;background:#ff6b35;border:3px solid #fff;border-radius:50%;box-shadow:0 0 14px #ff6b35"></div>',
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  const droneMarker = L.marker(latlngs[0] || [0, 0], { icon: droneIcon }).addTo(map);

  // ---------- 3D Scene ----------
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 200, 1500);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Equirectangular local-meter projection centred on the first GPS fix.
  const meterPerLat = 111320;
  const lonScale = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
  const cx = gpsPoints.length ? gpsPoints[0].lon : 0;
  const cy = gpsPoints.length ? gpsPoints[0].lat : 0;
  const baseAlt = gpsPoints.length ? Math.min(...gpsPoints.map(d => d.alt || 0)) : 0;
  function projectXYZ(lat, lon, alt) {
    const x = (lon - cx) * lonScale(cy);
    const z = -(lat - cy) * meterPerLat;
    const y = ((alt ?? baseAlt) - baseAlt);
    return [x, y, z];
  }
  function projectVec(lat, lon, alt) {
    const [x, y, z] = projectXYZ(lat, lon, alt);
    return new THREE.Vector3(x, y, z);
  }

  // Ground floor: start with a grid for instant feedback, then swap in a
  // satellite-textured plane once the Esri tiles for the flight bbox load.
  const grid = new THREE.GridHelper(2000, 80, 0x30363d, 0x21262d);
  scene.add(grid);
  if (gpsPoints.length) {
    const lats = gpsPoints.map(p => p.lat);
    const lons = gpsPoints.map(p => p.lon);
    createSatellitePlane({
      latMin: Math.min(...lats), latMax: Math.max(...lats),
      lonMin: Math.min(...lons), lonMax: Math.max(...lons),
      projectXYZ,
    }).then(plane => {
      if (plane) {
        scene.remove(grid);
        scene.add(plane);
        console.log('[satellite-plane] loaded, size=' + plane.geometry.parameters.width.toFixed(1) + 'x' + plane.geometry.parameters.height.toFixed(1) + ' at y=' + plane.position.y);
      } else {
        console.warn('[satellite-plane] returned null, keeping grid');
      }
    }).catch((e) => { console.warn('[satellite-plane] error:', e?.message); });
  }

  const pathPts = gpsPoints.map(d => projectVec(d.lat, d.lon, d.alt || baseAlt));
  let pathSize = 200;
  let trailPos = null, trail = null;
  if (pathPts.length) {
    scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pathPts),
      new THREE.LineBasicMaterial({ color: 0x58a6ff }),
    ));
    trailPos = new Float32Array(pathPts.length * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    trailGeo.setDrawRange(0, 0);
    trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xff6b35 }));
    scene.add(trail);
    const box = new THREE.Box3().setFromPoints(pathPts);
    const center = box.getCenter(new THREE.Vector3());
    pathSize = Math.max(box.getSize(new THREE.Vector3()).length(), 50);
    camera.position.set(center.x + pathSize * 0.7, Math.max(pathSize * 0.5, 80), center.z + pathSize * 0.7);
    controls.target.copy(center);
  }

  // Drone mesh (scales with the flight bounding box so it's always visible).
  const droneScale = Math.max(pathSize * 0.04, 4);
  const droneGroup = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.3, 1),
    new THREE.MeshStandardMaterial({ color: 0xff6b35, metalness: 0.6, roughness: 0.3, emissive: 0x551100, emissiveIntensity: 0.5 }),
  );
  droneGroup.add(body);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 0.15), new THREE.MeshStandardMaterial({ color: 0xc9d1d9 }));
  droneGroup.add(arm);
  const arm2 = arm.clone(); arm2.rotation.y = Math.PI / 2; droneGroup.add(arm2);
  for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const r = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 0.05, 16),
      new THREE.MeshStandardMaterial({ color: 0x222, transparent: true, opacity: 0.6 }),
    );
    r.position.set(dx, 0.1, dz);
    droneGroup.add(r);
  }
  const dropLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -200, 0)]),
    new THREE.LineDashedMaterial({ color: 0xff6b35, dashSize: 1, gapSize: 0.5, transparent: true, opacity: 0.45 }),
  );
  dropLine.computeLineDistances();
  droneGroup.add(dropLine);
  droneGroup.scale.setScalar(droneScale);
  scene.add(droneGroup);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(50, 200, 100);
  scene.add(sun);

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
  new ResizeObserver(resize).observe(canvas);
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));

  // ---------- Telemetry HUD ----------
  const tel = document.getElementById('tel');
  tel.innerHTML = '';
  const FIELDS = [
    ['lat', 'Lat'], ['lon', 'Lon'],
    ['alt', 'Alt', 'm'], ['alt_rel', 'Alt Rel', 'm'],
    ['yaw', 'Yaw', '°'], ['pitch', 'Pitch', '°'], ['roll', 'Roll', '°'],
    ['g_pitch', 'Gim Pitch', '°'], ['g_yaw', 'Gim Yaw', '°'],
    ['iso', 'ISO'], ['shutter', 'Shutter'], ['fnum', 'f'],
  ];
  const cells = {};
  for (const [k, label] of FIELDS) {
    const div = document.createElement('div');
    div.className = 'tel-row';
    div.innerHTML = `<span class="k">${label}</span><span class="v">—</span>`;
    tel.appendChild(div);
    cells[k] = div.querySelector('.v');
  }
  const hud = document.getElementById('hud');
  hud.innerHTML = `<div><span class="kv"><b>ALT</b><span id="hud-alt">—</span></span><span class="kv"><b>YAW</b><span id="hud-yaw">—</span></span></div>
                   <div><span class="kv"><b>LAT</b><span id="hud-lat">—</span></span><span class="kv"><b>LON</b><span id="hud-lon">—</span></span></div>`;
  const hudAlt = document.getElementById('hud-alt');
  const hudYaw = document.getElementById('hud-yaw');
  const hudLat = document.getElementById('hud-lat');
  const hudLon = document.getElementById('hud-lon');

  // ---------- Playback (multi-segment) ----------
  // The single <video> element is the canonical playhead clock. We swap its
  // src on segment boundaries and treat `currentSegmentIdx + video.currentTime`
  // as the global flight time. Wrappers globalTime / setGlobalTime hide that
  // bookkeeping from the rest of the viewer.
  const video = document.getElementById('video');
  video.innerHTML = '';
  let curSegIdx = 0;
  let pendingSeekLocal = 0;
  let wantPlaying = false;
  let suppressEnded = false;  // set true while we hot-swap to next segment

  function loadSeg(idx, localTime = 0) {
    curSegIdx = idx;
    pendingSeekLocal = localTime;
    suppressEnded = true;
    video.src = SEGMENTS[idx].url;
    video.load();
  }
  loadSeg(0, 0);

  const playBtn = document.getElementById('play');
  const scrub = document.getElementById('scrub');
  const timeLbl = document.getElementById('time');

  function fmtTime(s) {
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function globalTime() {
    return SEGMENTS[curSegIdx].start + (video.currentTime || 0);
  }
  async function setGlobalTime(t) {
    t = Math.max(0, Math.min(DURATION, t));
    // Find which segment contains t
    let idx = SEGMENTS.length - 1;
    for (let i = 0; i < SEGMENTS.length; i++) {
      if (t < SEGMENTS[i].start + SEGMENTS[i].duration) { idx = i; break; }
    }
    const local = Math.max(0, t - SEGMENTS[idx].start);
    if (idx !== curSegIdx) {
      loadSeg(idx, local);
    } else {
      try { video.currentTime = local; } catch (_) {}
    }
  }

  // Once metadata for the current segment is ready, apply any pending seek
  // and resume playing if the user was watching.
  video.addEventListener('loadedmetadata', () => {
    try { video.currentTime = pendingSeekLocal; } catch (_) {}
    if (wantPlaying) video.play().catch(() => {});
    suppressEnded = false;
  });

  // When the current segment ends, advance to the next; otherwise stop.
  video.addEventListener('ended', () => {
    if (suppressEnded) return;
    if (curSegIdx + 1 < SEGMENTS.length) {
      loadSeg(curSegIdx + 1, 0);
    } else {
      wantPlaying = false;
      playBtn.textContent = 'Play';
    }
  });

  // ---------- Camera modes ----------
  let followMode = false;
  const followForward = new THREE.Vector3(0, 0, -1);
  const _tmpFwd = new THREE.Vector3();
  const _camTarget = new THREE.Vector3();
  const _camDesired = new THREE.Vector3();
  const camBtn = document.getElementById('cam-mode');
  camBtn.textContent = 'Free';
  camBtn.addEventListener('click', () => {
    followMode = !followMode;
    controls.enabled = !followMode;
    camBtn.textContent = followMode ? 'Follow' : 'Free';
    camBtn.classList.toggle('is-follow', followMode);
  });

  let _lastFrameMs = performance.now();

  function update() {
    const nowMs = performance.now();
    const dtSec = Math.min(0.1, (nowMs - _lastFrameMs) / 1000);
    _lastFrameMs = nowMs;

    const curT = T0 + globalTime();
    const r = sampleAt(curT);

    if (r.lat !== undefined) droneMarker.setLatLng([r.lat, r.lon]);

    if (gpsPoints.length) {
      if (traveledIdx > 0 && gpsPoints[traveledIdx - 1].t > curT) {
        traveledIdx = 0;
        traveledCoords.length = 0;
      }
      while (traveledIdx < gpsPoints.length && gpsPoints[traveledIdx].t <= curT) {
        traveledCoords.push([gpsPoints[traveledIdx].lat, gpsPoints[traveledIdx].lon]);
        traveledIdx++;
      }
      const live = (r.lat !== undefined) ? [[r.lat, r.lon]] : [];
      traveled.setLatLngs(traveledCoords.concat(live));
    }

    if (r.lat !== undefined) {
      const [x, y, z] = projectXYZ(r.lat, r.lon, r.alt);
      droneGroup.position.set(x, y, z);
      if (r.yaw !== undefined) droneGroup.rotation.y = -r.yaw * Math.PI / 180;
      if (r.pitch !== undefined) droneGroup.rotation.x = r.pitch * Math.PI / 180;
      if (r.roll !== undefined) droneGroup.rotation.z = -r.roll * Math.PI / 180;
      droneGroup.visible = true;
    } else {
      droneGroup.visible = false;
    }

    if (trail && trailPos) {
      let visible = 0;
      for (let i = 0; i < gpsPoints.length; i++) {
        if (gpsPoints[i].t > curT) break;
        const p = pathPts[i];
        trailPos[visible * 3] = p.x;
        trailPos[visible * 3 + 1] = p.y;
        trailPos[visible * 3 + 2] = p.z;
        visible++;
      }
      if (r.lat !== undefined && visible < pathPts.length) {
        const [x, y, z] = projectXYZ(r.lat, r.lon, r.alt);
        trailPos[visible * 3] = x;
        trailPos[visible * 3 + 1] = y;
        trailPos[visible * 3 + 2] = z;
        visible++;
      }
      trail.geometry.attributes.position.needsUpdate = true;
      trail.geometry.setDrawRange(0, visible);
    }

    for (const [k, , unit] of FIELDS) {
      let v = r[k];
      if (v === undefined || v === null) { cells[k].textContent = '—'; continue; }
      if (typeof v === 'number') {
        v = (k === 'lat' || k === 'lon') ? v.toFixed(6) : v.toFixed(2);
      }
      cells[k].textContent = unit ? `${v} ${unit}` : `${v}`;
    }
    if (r.alt !== undefined) hudAlt.textContent = r.alt.toFixed(1) + ' m';
    if (r.yaw !== undefined) hudYaw.textContent = r.yaw.toFixed(1) + '°';
    if (r.lat !== undefined) hudLat.textContent = r.lat.toFixed(6);
    if (r.lon !== undefined) hudLon.textContent = r.lon.toFixed(6);

    if (followMode && r.lat !== undefined) {
      const past = sampleAt(Math.max(T0, curT - 0.6));
      if (past.lat !== undefined) {
        const [px, , pz] = projectXYZ(past.lat, past.lon, past.alt);
        const [cx2, , cz2] = projectXYZ(r.lat, r.lon, r.alt);
        _tmpFwd.set(cx2 - px, 0, cz2 - pz);
        if (_tmpFwd.lengthSq() > 0.04) {
          _tmpFwd.normalize();
          const blend = 1 - Math.exp(-dtSec * 2.5);
          followForward.lerp(_tmpFwd, blend).normalize();
        }
      }
      const back = Math.max(pathSize * 0.10, 25);
      const up = Math.max(pathSize * 0.05, 12);
      const [dx, dy, dz] = projectXYZ(r.lat, r.lon, r.alt);
      _camTarget.set(dx, dy, dz);
      _camDesired.copy(_camTarget).addScaledVector(followForward, -back);
      _camDesired.y += up;
      const k = 1 - Math.exp(-dtSec * 4);
      camera.position.lerp(_camDesired, k);
      controls.target.lerp(_camTarget, k);
      camera.lookAt(controls.target);
    }

    const elapsed = globalTime();
    timeLbl.textContent = `${fmtTime(elapsed)} / ${fmtTime(DURATION)}`;
    if (document.activeElement !== scrub) {
      scrub.value = (elapsed / DURATION) * 10000;
    }
  }

  let rafId;
  function loop() {
    update();
    controls.update();
    resize();
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  }
  loop();

  // ---------- Controls ----------
  const onPlayClick = () => {
    // If we're at the very end of the last segment, rewind to the start.
    if (curSegIdx === SEGMENTS.length - 1 && video.currentTime >= (video.duration - 0.05)) {
      loadSeg(0, 0);
      wantPlaying = true;
      return;
    }
    if (video.paused) {
      wantPlaying = true;
      video.play().catch(() => {});
    } else {
      wantPlaying = false;
      video.pause();
    }
  };
  const onVidPlay = () => { playBtn.textContent = 'Pause'; wantPlaying = true; };
  const onVidPause = () => { playBtn.textContent = 'Play'; if (!suppressEnded) wantPlaying = false; };
  const onResetClick = () => {
    wantPlaying = false;
    video.pause();
    if (curSegIdx !== 0) loadSeg(0, 0);
    else { try { video.currentTime = 0; } catch (_) {} }
  };
  const onScrubInput = (e) => {
    const t = (e.target.value / 10000) * DURATION;
    setGlobalTime(t);
  };
  const speedHandlers = [];
  for (const b of document.querySelectorAll('#speed button')) {
    const h = () => {
      video.playbackRate = parseFloat(b.dataset.s);
      document.querySelectorAll('#speed button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
    b.addEventListener('click', h);
    speedHandlers.push([b, h]);
  }

  playBtn.addEventListener('click', onPlayClick);
  video.addEventListener('play', onVidPlay);
  video.addEventListener('pause', onVidPause);
  document.getElementById('reset').addEventListener('click', onResetClick);
  scrub.addEventListener('input', onScrubInput);

  // Return a teardown function so main.js can switch flights without leaks.
  return function destroy() {
    cancelAnimationFrame(rafId);
    playBtn.removeEventListener('click', onPlayClick);
    video.removeEventListener('play', onVidPlay);
    video.removeEventListener('pause', onVidPause);
    document.getElementById('reset').removeEventListener('click', onResetClick);
    scrub.removeEventListener('input', onScrubInput);
    for (const [b, h] of speedHandlers) b.removeEventListener('click', h);
    map.remove();
    renderer.dispose();
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose?.();
      }
    });
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
