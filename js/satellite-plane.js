// Satellite-textured ground plane for the 3D scene.
//
// Fetches Esri World Imagery tiles covering the flight bbox, stitches them
// onto an offscreen canvas, and returns a THREE.Mesh sized in real meters
// using the same projection viewer.js uses for the path. The mesh sits at
// y = 0 (which is min-altitude in the local frame), so the drone path floats
// above it the way the actual flight floated above the ground.
//
// On any tile-load error or canvas taint, returns null so the caller can
// keep the grid fallback.

import * as THREE from 'three';

const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_SIZE = 256;
const MAX_NATIVE_ZOOM = 19;
const MAX_TILES_PER_AXIS = 8;
const PAD_FRACTION = 0.30;          // 30% padding around the path bbox

// Web Mercator: lat/lon → tile XY at given zoom
function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor(
    (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)
  );
}
// Inverse: tile XY → top-left lat/lon
function tileXToLon(x, z) {
  return x / Math.pow(2, z) * 360 - 180;
}
function tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// Pick the largest zoom where the bbox fits within MAX_TILES_PER_AXIS in both
// directions. Falls back to a sane default if the bbox is degenerate.
function pickZoom(latMin, latMax, lonMin, lonMax) {
  for (let z = MAX_NATIVE_ZOOM; z >= 0; z--) {
    const txMin = lonToTileX(lonMin, z);
    const txMax = lonToTileX(lonMax, z);
    const tyMin = latToTileY(latMax, z);   // note: north is smaller y
    const tyMax = latToTileY(latMin, z);
    if ((txMax - txMin + 1) <= MAX_TILES_PER_AXIS &&
        (tyMax - tyMin + 1) <= MAX_TILES_PER_AXIS) {
      return z;
    }
  }
  return 0;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile: ${url}`));
    img.src = url;
  });
}

export async function createSatellitePlane({
  latMin, latMax, lonMin, lonMax, projectXYZ,
}) {
  // Pad bbox so the plane extends past the path.
  const dLat = Math.max(latMax - latMin, 1e-6);
  const dLon = Math.max(lonMax - lonMin, 1e-6);
  const padLat = dLat * PAD_FRACTION;
  const padLon = dLon * PAD_FRACTION;
  const bLatMin = latMin - padLat;
  const bLatMax = latMax + padLat;
  const bLonMin = lonMin - padLon;
  const bLonMax = lonMax + padLon;

  const z = pickZoom(bLatMin, bLatMax, bLonMin, bLonMax);
  const txMin = lonToTileX(bLonMin, z);
  const txMax = lonToTileX(bLonMax, z);
  const tyMin = latToTileY(bLatMax, z);
  const tyMax = latToTileY(bLatMin, z);
  const tilesX = txMax - txMin + 1;
  const tilesY = tyMax - tyMin + 1;

  // Fetch all tiles in parallel.
  const requests = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const url = TILE_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      requests.push(loadImage(url).then(img => ({ img, tx, ty })));
    }
  }

  let tiles;
  try {
    tiles = await Promise.all(requests);
  } catch (e) {
    console.warn('[satellite-plane] tile fetch failed, falling back to grid:', e.message);
    return null;
  }

  // Stitch onto an offscreen canvas.
  const canvas = document.createElement('canvas');
  canvas.width = tilesX * TILE_SIZE;
  canvas.height = tilesY * TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (const { img, tx, ty } of tiles) {
    ctx.drawImage(img, (tx - txMin) * TILE_SIZE, (ty - tyMin) * TILE_SIZE);
  }

  // True geographic extent of the stitched canvas (slightly overshoots bbox).
  const lonWest  = tileXToLon(txMin, z);
  const lonEast  = tileXToLon(txMax + 1, z);
  const latNorth = tileYToLat(tyMin, z);
  const latSouth = tileYToLat(tyMax + 1, z);

  // Convert the four corners to local meters via the existing projection.
  const [xWest, , zNorth] = projectXYZ(latNorth, lonWest, 0);
  const [xEast, , zSouth] = projectXYZ(latSouth, lonEast, 0);
  const width  = xEast - xWest;     // positive (east > west in our frame)
  const height = zSouth - zNorth;   // positive (south is +z, north is -z)
  const centerX = (xWest + xEast) / 2;
  const centerZ = (zNorth + zSouth) / 2;

  // Build the plane. Default PlaneGeometry sits in the XY plane with +y up;
  // we rotate it to lie on XZ. After rotating, the texture's top edge
  // (canvas y=0, which is north) maps to the scene's −z direction — exactly
  // what we want.
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const geo = new THREE.PlaneGeometry(width, height);
  const mat = new THREE.MeshBasicMaterial({ map: texture, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(centerX, 0, centerZ);
  mesh.renderOrder = -1;   // render before the path so the line draws on top
  return mesh;
}
