import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { fromBlob } from 'geotiff';
import proj4 from 'proj4';
import shp from 'shpjs';
import { createOdmTask, getOdmTaskInfo, odmAssetUrl, odmStatus } from './odm-client.js';
import {
  buildSpatialReference,
  coordinateDistanceMetres,
  coordinatesToLocalMetres,
  geoJsonCrs,
  rasterGroundMetrics,
  sameSpatialReference,
} from './spatial-reference.js';
import { listZipEntries, mapGeometryCoordinates, mergeFeatureCollections, validateShapefileEntries } from './shapefile-utils.js';
import './style.css';

const canvas = document.querySelector('#viewer');
canvas.tabIndex = 0;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x071018);
scene.fog = new THREE.FogExp2(0x071018, 0.0025);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 45;
controls.maxDistance = 450;
controls.maxPolarAngle = Math.PI * 0.49;
const fpsControls = new PointerLockControls(camera, renderer.domElement);
fpsControls.enabled = false;
fpsControls.pointerSpeed = 0.72;
fpsControls.minPolarAngle = Math.PI * 0.08;
fpsControls.maxPolarAngle = Math.PI * 0.92;
let viewMode = '3d';

function resetCamera() {
  if (viewMode.startsWith('globe')) {
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, viewMode === 'globe-3d' ? 180 : 225);
  } else if (viewMode === '2d') {
    camera.up.set(0, 0, -1);
    camera.position.set(0, 285, 0.01);
  } else {
    camera.up.set(0, 1, 0);
    camera.position.set(135, 115, 145);
  }
  controls.target.set(0, 0, 0);
  controls.enableRotate = viewMode !== '2d';
  controls.enablePan = !viewMode.startsWith('globe');
  controls.minDistance = viewMode.startsWith('globe') ? 82 : 45;
  controls.update();
}
resetCamera();

scene.add(new THREE.HemisphereLight(0xc8efff, 0x1a251b, 1.8));
const sun = new THREE.DirectionalLight(0xfff4da, 3.4);
sun.position.set(-80, 150, 75);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -140;
sun.shadow.camera.right = sun.shadow.camera.top = 140;
scene.add(sun);

const loader = new THREE.TextureLoader();
let heightTexture = createDemoHeightmap();
let surfaceTexture = createDemoSurface();
let heightUrl;
let surfaceUrl;
let demValues = null;
let demWidth = 0;
let demHeight = 0;
let demMin = 0;
let demMax = 1;
let demNoData = null;
let demMeta = null;
let textureMeta = null;
let slopeValues = null;
let floodRiskValues = null;
let streamMask = null;
let activeLayer = 'texture';
let profileMode = false;
let profilePoints = [];
let measurementMode = false;
let measurementFinished = false;
let measurementPoints = [];
let measurementPreview = null;
let measurementSummary = null;
let hydrologyWorker = null;
let hydrologyResult = null;
let pixelAreaMetres = 1;
let demGroundMetrics = null;
let firstPersonMode = false;
let fpsTerrain = null;
let fpsWidthMetres = 1;
let fpsHeightMetres = 1;
let selectedPoi = null;
let savedMapCamera = null;
let fpsYaw = 0;
let fpsPitch = -0.05;
let lookDragging = false;
let lastLookPointer = null;
let fpsMiniBase = null;
let lastMiniMapDraw = 0;
let fpsEyeClearance = 2;
let fpsFootGround = 0;
let rasterLoading = false;
let odmTaskUuid = null;
let odmPollTimer = null;
let shapefileCollection = null;
let shapefileWgs84Collection = null;
let shapefileSourceName = '';
let shapefileFeatureStats = [];
let shapefileVisible = true;
let shapefileStandalone = false;
let shapefileBounds = null;
const wgs84Spatial = buildSpatialReference({
  geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
  bbox: [-180, -90, 180, 90],
  georeferenced: true,
});
const movementKeys = new Set();
const fpsVelocity = new THREE.Vector3();
const fpsForward = new THREE.Vector3();
const fpsRight = new THREE.Vector3();
const fpsWishDirection = new THREE.Vector3();
const layerTextures = {
  texture: surfaceTexture,
  elevation: null,
  hillshade: null,
  slope: null,
  suitability: null,
  contour: null,
  flow: null,
  depression: null,
  risk: null,
};

const geometry = new THREE.PlaneGeometry(210, 150, 256, 192);
geometry.rotateX(-Math.PI / 2);

const material = new THREE.MeshStandardMaterial({
  map: surfaceTexture,
  displacementMap: heightTexture,
  displacementScale: 30,
  displacementBias: -7,
  roughness: 0.82,
  metalness: 0,
  transparent: true,
  alphaTest: 0.05,
});

const terrain = new THREE.Mesh(geometry, material);
terrain.castShadow = true;
terrain.receiveShadow = true;
scene.add(terrain);

const globeRadius = 70;
const globeGroup = new THREE.Group();
globeGroup.name = 'wgs84-globe';
globeGroup.visible = false;
scene.add(globeGroup);

const globeEarth = new THREE.Mesh(
  new THREE.SphereGeometry(globeRadius, 96, 64),
  new THREE.MeshStandardMaterial({ color: 0x123b56, roughness: 0.86, metalness: 0.04 })
);
globeEarth.castShadow = true;
globeEarth.receiveShadow = true;
globeGroup.add(globeEarth);

const globeAtmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(globeRadius * 1.025, 64, 48),
  new THREE.MeshBasicMaterial({
    color: 0x60a5fa,
    transparent: true,
    opacity: 0.08,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  })
);
globeGroup.add(globeAtmosphere);

const globeGraticule = new THREE.Group();
globeGraticule.name = 'globe-graticule';
globeGroup.add(globeGraticule);

const globeFeatureGroup = new THREE.Group();
globeFeatureGroup.name = 'globe-shapefile-layer';
globeGroup.add(globeFeatureGroup);
buildGlobeGraticule();

const shapefileBackdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(212, 152),
  new THREE.MeshBasicMaterial({ color: 0x0b1720, side: THREE.DoubleSide })
);
shapefileBackdrop.rotation.x = -Math.PI / 2;
shapefileBackdrop.position.y = -0.15;
shapefileBackdrop.visible = false;
scene.add(shapefileBackdrop);

const shapefileGrid = new THREE.GridHelper(210, 14, 0x27495a, 0x152b36);
shapefileGrid.position.y = -0.05;
shapefileGrid.visible = false;
scene.add(shapefileGrid);

const shapefileGroup = new THREE.Group();
shapefileGroup.name = 'shapefile-layer';
scene.add(shapefileGroup);

const base = new THREE.Mesh(
  new THREE.BoxGeometry(212, 6, 152),
  new THREE.MeshStandardMaterial({ color: 0x10211d, roughness: 1 })
);
base.position.y = -10;
base.receiveShadow = true;
scene.add(base);

function createCanvasTexture(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  draw(ctx, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function createDemoHeightmap() {
  const texture = createCanvasTexture((ctx, w, h) => {
    ctx.fillStyle = '#171717';
    ctx.fillRect(0, 0, w, h);
    const hills = [
      [0.28, 0.34, 0.34, 235], [0.7, 0.28, 0.28, 210],
      [0.58, 0.7, 0.38, 190], [0.15, 0.78, 0.25, 145],
    ];
    for (const [x, y, radius, peak] of hills) {
      const g = ctx.createRadialGradient(w*x, h*y, 0, w*x, h*y, w*radius);
      g.addColorStop(0, `rgb(${peak},${peak},${peak})`);
      g.addColorStop(1, 'rgba(23,23,23,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  });
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

function createDemoSurface() {
  const texture = createCanvasTexture((ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#183d31');
    g.addColorStop(.48, '#618151');
    g.addColorStop(1, '#b3a36d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = .2;
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = i % 3 ? '#d9c986' : '#092d28';
      ctx.fillRect(Math.random()*w, Math.random()*h, 2 + Math.random()*18, 1);
    }
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function colorRamp(t, stops) {
  const value = THREE.MathUtils.clamp(t, 0, 1);
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * mix),
    Math.round(a[1] + (b[1] - a[1]) * mix),
    Math.round(a[2] + (b[2] - a[2]) * mix),
  ];
}

function renderClassStats(selector, rows) {
  const root = document.querySelector(selector);
  const total = rows.reduce((sum, row) => sum + row[1], 0) || 1;
  root.innerHTML = rows.map(([label, count, color]) => {
    const area = count * pixelAreaMetres / 10000;
    const percent = count / total * 100;
    return `<div><i style="background:${color}"></i><span>${label}</span><strong>${area.toFixed(2)} ha · ${percent.toFixed(1)}%</strong></div>`;
  }).join('');
}

function downloadText(filename, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function coordinateAtPixel(index) {
  const x = index % demWidth;
  const y = Math.floor(index / demWidth);
  const [west, south, east, north] = demMeta.bbox;
  return [
    west + (x + 0.5) / Math.max(1, demWidth) * (east - west),
    north - (y + 0.5) / Math.max(1, demHeight) * (north - south),
  ];
}

function formatDistance(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(metres < 100 ? 1 : 0)} m`;
}

function formatArea(squareMetres) {
  if (squareMetres >= 10000) return `${(squareMetres / 10000).toFixed(2)} ha`;
  return `${squareMetres.toFixed(0)} m²`;
}

function metricCoordinates(points) {
  if (!points.length) return [];
  return coordinatesToLocalMetres(
    points.map(({ data }) => ({ x: data.coordinateX, y: data.coordinateY })),
    demMeta.spatial,
  );
}

function polygonMetrics(points) {
  const local = metricCoordinates(points);
  let areaTwice = 0;
  let perimeter = 0;
  for (let i = 0; i < local.length; i++) {
    const next = local[(i + 1) % local.length];
    if (i < local.length - 1 || local.length >= 3) perimeter += Math.hypot(next.x - local[i].x, next.y - local[i].y);
    if (local.length >= 3) areaTwice += local[i].x * next.y - next.x * local[i].y;
  }
  return { area: Math.abs(areaTwice) / 2, perimeter };
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i].data;
    const b = polygon[j].data;
    const intersects = ((a.y > y) !== (b.y > y))
      && (x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]);
}

function demProjectionName() {
  const spatial = demMeta?.spatial;
  if (!spatial || spatial.assumedMetric) throw new Error('CRS DEM tidak ditemukan. Tetapkan CRS GeoTIFF sebelum mengimpor Shapefile.');
  if (spatial.kind === 'geographic' && (!spatial.epsg || spatial.epsg === 4326)) return 'EPSG:4326';
  const code = spatial.epsg ? `EPSG:${spatial.epsg}` : null;
  if (!code) throw new Error('Kode EPSG DEM tidak tersedia sehingga layer Shapefile belum dapat disejajarkan.');
  if (!proj4.defs(code) && spatial.epsg >= 32601 && spatial.epsg <= 32660) {
    proj4.defs(code, `+proj=utm +zone=${spatial.epsg - 32600} +datum=WGS84 +units=m +no_defs`);
  }
  if (!proj4.defs(code) && spatial.epsg >= 32701 && spatial.epsg <= 32760) {
    proj4.defs(code, `+proj=utm +zone=${spatial.epsg - 32700} +south +datum=WGS84 +units=m +no_defs`);
  }
  if (!proj4.defs(code)) throw new Error(`${code} belum memiliki definisi proyeksi di browser. Gunakan UTM WGS84 atau samakan CRS di QGIS terlebih dahulu.`);
  return code;
}

function transformShapefileToDem(collection) {
  const target = demProjectionName();
  const transform = target === 'EPSG:4326'
    ? (x, y) => [x, y]
    : (x, y) => proj4('EPSG:4326', target, [x, y]);
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: mapGeometryCoordinates(feature.geometry, transform),
    })),
  };
}

function firstGeometryCoordinate(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'GeometryCollection') {
    for (const item of geometry.geometries || []) {
      const coordinate = firstGeometryCoordinate(item);
      if (coordinate) return coordinate;
    }
    return null;
  }
  let value = geometry.coordinates;
  while (Array.isArray(value) && Array.isArray(value[0])) value = value[0];
  return Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1]) ? value : null;
}

function geometryBounds(geometry, result = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }) {
  if (!geometry) return result;
  if (geometry.type === 'GeometryCollection') {
    geometry.geometries.forEach((item) => geometryBounds(item, result));
    return result;
  }
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      result.minX = Math.min(result.minX, value[0]);
      result.minY = Math.min(result.minY, value[1]);
      result.maxX = Math.max(result.maxX, value[0]);
      result.maxY = Math.max(result.maxY, value[1]);
    } else value.forEach(visit);
  };
  visit(geometry.coordinates);
  return result;
}

function lonLatToGlobe(longitude, latitude, radius = globeRadius) {
  const lat = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(latitude, -90, 90));
  const lon = THREE.MathUtils.degToRad(longitude);
  const cosLat = Math.cos(lat);
  return new THREE.Vector3(
    radius * cosLat * Math.sin(lon),
    radius * Math.sin(lat),
    radius * cosLat * Math.cos(lon),
  );
}

function buildGlobeGraticule() {
  const material = new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.18 });
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const points = [];
    for (let longitude = -180; longitude <= 180; longitude += 3) points.push(lonLatToGlobe(longitude, latitude, globeRadius * 1.002));
    globeGraticule.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
  for (let longitude = -150; longitude <= 180; longitude += 30) {
    const points = [];
    for (let latitude = -90; latitude <= 90; latitude += 3) points.push(lonLatToGlobe(longitude, latitude, globeRadius * 1.002));
    globeGraticule.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
}

function cleanGlobeRing(ring) {
  if (!ring?.length) return [];
  const result = ring.filter((coordinate) => Number.isFinite(coordinate?.[0]) && Number.isFinite(coordinate?.[1]));
  if (result.length > 2) {
    const first = result[0];
    const last = result.at(-1);
    if (first[0] === last[0] && first[1] === last[1]) result.pop();
  }
  return result;
}

function addGlobeLine(coordinates, material, radius, close = false) {
  const clean = cleanGlobeRing(coordinates);
  if (clean.length < 2) return;
  const maximumPoints = 16000;
  const stride = Math.max(1, Math.ceil(clean.length / maximumPoints));
  const sampled = clean.filter((_, index) => index % stride === 0);
  if (sampled.at(-1) !== clean.at(-1)) sampled.push(clean.at(-1));
  if (close) sampled.push(sampled[0]);
  const points = sampled.map(([longitude, latitude]) => lonLatToGlobe(longitude, latitude, radius));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material.clone());
  line.renderOrder = 8;
  globeFeatureGroup.add(line);
}

function globePolygonMesh(polygon, materials, extruded) {
  const rings = polygon.map(cleanGlobeRing).filter((ring) => ring.length >= 3);
  if (!rings.length) return;
  const contour = rings[0].map(([x, y]) => new THREE.Vector2(x, y));
  const holes = rings.slice(1).map((ring) => ring.map(([x, y]) => new THREE.Vector2(x, y)));
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  const coordinates = [contour, ...holes].flat().map(({ x, y }) => [x, y]);
  const topRadius = globeRadius + (extruded ? 4.2 : 0.55);
  const positions = [];
  for (const face of faces) {
    for (const index of face) {
      const [longitude, latitude] = coordinates[index];
      const point = lonLatToGlobe(longitude, latitude, topRadius);
      positions.push(point.x, point.y, point.z);
    }
  }
  if (positions.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materials.fill.clone());
    mesh.renderOrder = 5;
    globeFeatureGroup.add(mesh);
  }
  if (extruded) {
    const wallPositions = [];
    for (const ring of rings) {
      for (let index = 0; index < ring.length; index++) {
        const next = (index + 1) % ring.length;
        const baseA = lonLatToGlobe(ring[index][0], ring[index][1], globeRadius + 0.45);
        const baseB = lonLatToGlobe(ring[next][0], ring[next][1], globeRadius + 0.45);
        const topA = lonLatToGlobe(ring[index][0], ring[index][1], topRadius);
        const topB = lonLatToGlobe(ring[next][0], ring[next][1], topRadius);
        for (const point of [baseA, baseB, topB, baseA, topB, topA]) wallPositions.push(point.x, point.y, point.z);
      }
    }
    if (wallPositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
      geometry.computeVertexNormals();
      const walls = new THREE.Mesh(geometry, materials.wall.clone());
      walls.renderOrder = 4;
      globeFeatureGroup.add(walls);
    }
  }
  for (const ring of rings) addGlobeLine(ring, materials.polygon, topRadius + 0.08, true);
}

function renderGlobeGeometry(geometry, materials, extruded) {
  if (!geometry) return;
  const lineRadius = globeRadius + (extruded ? 4.35 : 0.7);
  if (geometry.type === 'Point') {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(extruded ? 1.35 : 0.9, 10, 8), materials.point.clone());
    marker.position.copy(lonLatToGlobe(geometry.coordinates[0], geometry.coordinates[1], lineRadius + 0.6));
    marker.renderOrder = 9;
    globeFeatureGroup.add(marker);
  } else if (geometry.type === 'MultiPoint') {
    geometry.coordinates.forEach((coordinate) => renderGlobeGeometry({ type: 'Point', coordinates: coordinate }, materials, extruded));
  } else if (geometry.type === 'LineString') {
    addGlobeLine(geometry.coordinates, materials.line, lineRadius);
  } else if (geometry.type === 'MultiLineString') {
    geometry.coordinates.forEach((line) => addGlobeLine(line, materials.line, lineRadius));
  } else if (geometry.type === 'Polygon') {
    globePolygonMesh(geometry.coordinates, materials, extruded);
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon) => globePolygonMesh(polygon, materials, extruded));
  } else if (geometry.type === 'GeometryCollection') {
    geometry.geometries.forEach((item) => renderGlobeGeometry(item, materials, extruded));
  }
}

function renderGlobeShapefile(mode = viewMode) {
  for (const child of [...globeFeatureGroup.children]) {
    globeFeatureGroup.remove(child);
    disposeObject3d(child);
  }
  if (!shapefileWgs84Collection) return;
  const extruded = mode === 'globe-3d';
  const materials = {
    polygon: new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.98, depthTest: true }),
    line: new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.96, depthTest: true }),
    point: new THREE.MeshBasicMaterial({ color: 0xfbbf24 }),
    fill: new THREE.MeshStandardMaterial({ color: 0x22d3ee, transparent: true, opacity: extruded ? 0.58 : 0.28, side: THREE.DoubleSide, depthWrite: false }),
    wall: new THREE.MeshStandardMaterial({ color: 0x0891b2, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }),
  };
  for (const feature of shapefileWgs84Collection.features) renderGlobeGeometry(feature.geometry, materials, extruded);
  Object.values(materials).forEach((item) => item.dispose());
  globeFeatureGroup.visible = shapefileVisible;
}

function focusGlobeOnShapefile() {
  if (!shapefileWgs84Collection) return;
  const bounds = featureCollectionBounds(shapefileWgs84Collection);
  const longitude = (bounds.minX + bounds.maxX) / 2;
  const latitude = (bounds.minY + bounds.maxY) / 2;
  const location = lonLatToGlobe(longitude, latitude, 1).normalize();
  globeGroup.quaternion.setFromUnitVectors(location, new THREE.Vector3(0, 0, 1));
}

function geometryOverlapsDem(geometry) {
  if (!demMeta || shapefileStandalone) return true;
  const bounds = geometryBounds(geometry);
  if (!Number.isFinite(bounds.minX)) return false;
  const [west, south, east, north] = demMeta.bbox;
  return bounds.maxX >= Math.min(west, east)
    && bounds.minX <= Math.max(west, east)
    && bounds.maxY >= Math.min(south, north)
    && bounds.minY <= Math.max(south, north);
}

function featureCollectionBounds(collection) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const feature of collection?.features || []) geometryBounds(feature.geometry, bounds);
  if (!Number.isFinite(bounds.minX)) throw new Error('Shapefile tidak memiliki koordinat geometry yang valid.');
  if (bounds.minX === bounds.maxX) {
    bounds.minX -= 0.0001;
    bounds.maxX += 0.0001;
  }
  if (bounds.minY === bounds.maxY) {
    bounds.minY -= 0.0001;
    bounds.maxY += 0.0001;
  }
  return bounds;
}

function standaloneWorldFromCoordinate(x, y, extraHeight = 0.65) {
  const bounds = shapefileBounds;
  if (!bounds) return new THREE.Vector3();
  const metrics = rasterGroundMetrics({
    bbox: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
    spatial: wgs84Spatial,
  }, 1, 1);
  const availableWidth = 196;
  const availableHeight = 136;
  const aspect = metrics.groundWidth / Math.max(0.01, metrics.groundHeight);
  const displayWidth = aspect > availableWidth / availableHeight ? availableWidth : availableHeight * aspect;
  const displayHeight = aspect > availableWidth / availableHeight ? availableWidth / aspect : availableHeight;
  const u = (x - bounds.minX) / Math.max(Number.EPSILON, bounds.maxX - bounds.minX);
  const v = (y - bounds.minY) / Math.max(Number.EPSILON, bounds.maxY - bounds.minY);
  return new THREE.Vector3((u - 0.5) * displayWidth, extraHeight, (0.5 - v) * displayHeight);
}

function coordinateToRaster(x, y) {
  const [west, south, east, north] = demMeta.bbox;
  return {
    x: (x - west) / ((east - west) || Number.EPSILON) * demWidth - 0.5,
    y: (north - y) / ((north - south) || Number.EPSILON) * demHeight - 0.5,
  };
}

function rasterToMapWorld(pixelX, pixelY, extraHeight = 0.65) {
  const u = (pixelX + 0.5) / Math.max(1, demWidth);
  const v = 1 - (pixelY + 0.5) / Math.max(1, demHeight);
  const elevation = bilinearElevation(pixelX, pixelY);
  const scale = Number(document.querySelector('#heightScale').value);
  const normalized = (elevation - demMin) / Math.max(1, demMax - demMin);
  const displayHeight = (document.querySelector('#invertHeight').checked ? 1 - normalized : normalized) * scale - scale * 0.18;
  return new THREE.Vector3((u - 0.5) * 210, displayHeight + extraHeight, (0.5 - v) * 150);
}

function coordinateInsideDem(coordinate) {
  const [west, south, east, north] = demMeta.bbox;
  const minX = Math.min(west, east);
  const maxX = Math.max(west, east);
  const minY = Math.min(south, north);
  const maxY = Math.max(south, north);
  return coordinate[0] >= minX && coordinate[0] <= maxX && coordinate[1] >= minY && coordinate[1] <= maxY;
}

function drapedPoints(coordinates, close = false) {
  if (!coordinates?.length) return [];
  const source = close && coordinates.length > 2 && (coordinates[0][0] !== coordinates.at(-1)[0] || coordinates[0][1] !== coordinates.at(-1)[1])
    ? [...coordinates, coordinates[0]]
    : coordinates;
  const points = [];
  const maximumPoints = 12000;
  if (shapefileStandalone) return source.slice(0, maximumPoints).map(([x, y]) => standaloneWorldFromCoordinate(x, y));
  for (let i = 0; i < source.length - 1 && points.length < maximumPoints; i++) {
    const start = coordinateToRaster(source[i][0], source[i][1]);
    const end = coordinateToRaster(source[i + 1][0], source[i + 1][1]);
    const steps = Math.max(1, Math.min(200, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2)));
    for (let step = 0; step < steps && points.length < maximumPoints; step++) {
      const t = step / steps;
      points.push(rasterToMapWorld(
        THREE.MathUtils.lerp(start.x, end.x, t),
        THREE.MathUtils.lerp(start.y, end.y, t),
      ));
    }
  }
  const last = source.at(-1);
  const pixel = coordinateToRaster(last[0], last[1]);
  points.push(rasterToMapWorld(pixel.x, pixel.y));
  return points;
}

function addShapefileLine(coordinates, material, close = false) {
  const points = drapedPoints(coordinates, close);
  if (points.length < 2) return;
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material.clone());
  line.renderOrder = 6;
  shapefileGroup.add(line);
}

function renderFeatureGeometry(geometry, materials) {
  if (!geometry) return;
  if (geometry.type === 'Point') {
    if (!shapefileStandalone && !coordinateInsideDem(geometry.coordinates)) return;
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), materials.point.clone());
    if (shapefileStandalone) {
      marker.position.copy(standaloneWorldFromCoordinate(geometry.coordinates[0], geometry.coordinates[1], 1.3));
    } else {
      const pixel = coordinateToRaster(geometry.coordinates[0], geometry.coordinates[1]);
      marker.position.copy(rasterToMapWorld(pixel.x, pixel.y, 1.3));
    }
    marker.renderOrder = 7;
    shapefileGroup.add(marker);
  } else if (geometry.type === 'MultiPoint') {
    geometry.coordinates.forEach((coordinate) => renderFeatureGeometry({ type: 'Point', coordinates: coordinate }, materials));
  } else if (geometry.type === 'LineString') {
    addShapefileLine(geometry.coordinates, materials.line);
  } else if (geometry.type === 'MultiLineString') {
    geometry.coordinates.forEach((line) => addShapefileLine(line, materials.line));
  } else if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach((ring) => addShapefileLine(ring, materials.polygon, true));
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => addShapefileLine(ring, materials.polygon, true)));
  } else if (geometry.type === 'GeometryCollection') {
    geometry.geometries.forEach((item) => renderFeatureGeometry(item, materials));
  }
}

function disposeObject3d(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((item) => item.dispose?.());
    else child.material?.dispose?.();
  });
}

function renderShapefileLayer() {
  for (const child of [...shapefileGroup.children]) {
    shapefileGroup.remove(child);
    disposeObject3d(child);
  }
  if (!shapefileCollection) return;
  const materials = {
    polygon: new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.96, depthTest: false }),
    line: new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.95, depthTest: false }),
    point: new THREE.MeshBasicMaterial({ color: 0xfbbf24, depthTest: false }),
  };
  for (const feature of shapefileCollection.features) if (geometryOverlapsDem(feature.geometry)) renderFeatureGeometry(feature.geometry, materials);
  Object.values(materials).forEach((item) => item.dispose());
  shapefileGroup.visible = shapefileVisible && !firstPersonMode;
}

function pointInCoordinateRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (((a[1] > y) !== (b[1] > y)) && x < (b[0] - a[0]) * (y - a[1]) / ((b[1] - a[1]) || Number.EPSILON) + a[0]) inside = !inside;
  }
  return inside;
}

function polygonContainsCoordinate(x, y, polygon) {
  if (!polygon.length || !pointInCoordinateRing(x, y, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInCoordinateRing(x, y, hole));
}

function ringMetric(ring) {
  if (ring.length < 3) return { area: 0, perimeter: 0 };
  const local = coordinatesToLocalMetres(ring.map(([x, y]) => ({ x, y })), shapefileStandalone ? wgs84Spatial : demMeta.spatial);
  let areaTwice = 0;
  let perimeter = 0;
  for (let i = 0; i < local.length; i++) {
    const next = local[(i + 1) % local.length];
    areaTwice += local[i].x * next.y - next.x * local[i].y;
    perimeter += Math.hypot(next.x - local[i].x, next.y - local[i].y);
  }
  return { area: Math.abs(areaTwice) / 2, perimeter };
}

function polygonsFromGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(polygonsFromGeometry);
  return [];
}

function calculateShapefileFeatureStats(feature) {
  const polygons = polygonsFromGeometry(feature.geometry);
  if (!polygons.length) return null;
  let area = 0;
  let perimeter = 0;
  let count = 0;
  let elevationMin = Infinity;
  let elevationMax = -Infinity;
  let slopeSum = 0;
  let highFloodCount = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      const metric = ringMetric(ring);
      area += index === 0 ? metric.area : -metric.area;
      perimeter += metric.perimeter;
    });
  }
  if (shapefileStandalone || !demValues || !demMeta) {
    return {
      area: Math.max(0, area),
      perimeter,
      elevationMin: null,
      elevationMax: null,
      averageSlope: null,
      highFloodPercent: null,
    };
  }
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer?.length) continue;
    const pixels = outer.map(([x, y]) => coordinateToRaster(x, y));
    const minX = Math.max(0, Math.floor(Math.min(...pixels.map((point) => point.x))));
    const maxX = Math.min(demWidth - 1, Math.ceil(Math.max(...pixels.map((point) => point.x))));
    const minY = Math.max(0, Math.floor(Math.min(...pixels.map((point) => point.y))));
    const maxY = Math.min(demHeight - 1, Math.ceil(Math.max(...pixels.map((point) => point.y))));
    const candidates = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    const stride = Math.max(1, Math.ceil(Math.sqrt(candidates / 5000)));
    for (let py = minY; py <= maxY; py += stride) {
      for (let px = minX; px <= maxX; px += stride) {
        const [coordinateX, coordinateY] = coordinateAtPixel(py * demWidth + px);
        if (!polygonContainsCoordinate(coordinateX, coordinateY, polygon)) continue;
        const index = py * demWidth + px;
        if (!validElevation(demValues[index])) continue;
        const elevation = demValues[index];
        count++;
        elevationMin = Math.min(elevationMin, elevation);
        elevationMax = Math.max(elevationMax, elevation);
        slopeSum += slopeValues?.[index] || 0;
        if (floodRiskValues?.[index] >= 0.65) highFloodCount++;
      }
    }
  }
  return {
    area: Math.max(0, area),
    perimeter,
    elevationMin: count ? elevationMin : null,
    elevationMax: count ? elevationMax : null,
    averageSlope: count ? slopeSum / count : null,
    highFloodPercent: count && floodRiskValues ? highFloodCount / count * 100 : null,
  };
}

function shapefileFeatureLabel(feature, index) {
  const properties = feature.properties || {};
  for (const key of ['NAMA_BLOK', 'NAMA', 'NAME', 'BLOK', 'BLOCK', 'AFDELING', 'ID', 'id']) {
    if (properties[key] !== undefined && properties[key] !== '') return String(properties[key]);
  }
  return `${feature.geometry?.type || 'Feature'} ${index + 1}`;
}

function refreshShapefileStats() {
  if (!shapefileCollection) return;
  shapefileFeatureStats = shapefileCollection.features.map(calculateShapefileFeatureStats);
  const counts = { polygon: 0, line: 0, point: 0 };
  let polygonArea = 0;
  shapefileCollection.features.forEach((feature, index) => {
    const type = feature.geometry?.type || '';
    if (type.includes('Polygon')) counts.polygon++;
    else if (type.includes('Line')) counts.line++;
    else if (type.includes('Point')) counts.point++;
    polygonArea += shapefileFeatureStats[index]?.area || 0;
  });
  document.querySelector('#shapefileSummary').innerHTML = [
    ['Total feature', shapefileCollection.features.length],
    ['Polygon/blok', counts.polygon],
    ['Garis/jalan/kanal', counts.line],
    ['Titik aset', counts.point],
    ['Total area polygon', formatArea(polygonArea)],
    ['CRS tampilan', shapefileStandalone ? wgs84Spatial.label : demMeta.spatial.label],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  document.querySelector('#shapefileSummary').classList.remove('hidden');
  const rows = shapefileCollection.features.slice(0, 100).map((feature, index) => {
    const stats = shapefileFeatureStats[index];
    const detail = stats
      ? shapefileStandalone
        ? `${formatArea(stats.area)} · perimeter ${stats.perimeter.toLocaleString('id-ID', { maximumFractionDigits: 1 })} m · slope/flood butuh DEM`
        : `${formatArea(stats.area)} · slope ${stats.averageSlope === null ? '—' : `${stats.averageSlope.toFixed(1)}°`} · flood ${stats.highFloodPercent === null ? 'belum dihitung' : `${stats.highFloodPercent.toFixed(1)}%`}`
      : Object.entries(feature.properties || {}).slice(0, 3).map(([key, value]) => `${key}: ${value}`).join(' · ');
    return `<article><strong>${escapeHtml(shapefileFeatureLabel(feature, index))}</strong><span>${escapeHtml(feature.geometry?.type || '—')}</span><small>${escapeHtml(detail || 'Tanpa atribut')}</small></article>`;
  });
  if (shapefileCollection.features.length > 100) rows.push(`<article><small>Menampilkan 100 dari ${shapefileCollection.features.length} feature.</small></article>`);
  const list = document.querySelector('#shapefileFeatureList');
  list.innerHTML = rows.join('');
  list.classList.remove('hidden');
}

async function loadShapefileZip(file) {
  if (!/\.zip$/i.test(file.name)) throw new Error('Pilih satu file ZIP yang berisi .shp, .shx, .dbf, dan .prj.');
  if (file.size > 250 * 1024 * 1024) throw new Error('ZIP Shapefile terlalu besar untuk diproses aman di browser (maksimum 250 MB).');
  setStatus('Membaca Shapefile', `${file.name} · memvalidasi komponen ZIP dan CRS.`);
  const buffer = await file.arrayBuffer();
  const validation = validateShapefileEntries(listZipEntries(buffer));
  const parsed = await shp(buffer);
  const wgs84Collection = mergeFeatureCollections(parsed);
  if (!wgs84Collection.features.length) throw new Error('Shapefile tidak memiliki feature yang dapat dibaca.');
  const sampleCoordinate = wgs84Collection.features.map((feature) => firstGeometryCoordinate(feature.geometry)).find(Boolean);
  if (!sampleCoordinate || Math.abs(sampleCoordinate[0]) > 180 || Math.abs(sampleCoordinate[1]) > 90) {
    throw new Error('PRJ tidak dapat ditransformasikan ke WGS84. Tetapkan CRS yang benar atau ekspor ulang Shapefile dari QGIS.');
  }
  shapefileWgs84Collection = wgs84Collection;
  shapefileStandalone = !demValues || !demMeta;
  shapefileCollection = shapefileStandalone ? wgs84Collection : transformShapefileToDem(wgs84Collection);
  shapefileBounds = shapefileStandalone ? featureCollectionBounds(wgs84Collection) : null;
  const overlapCount = shapefileStandalone
    ? shapefileCollection.features.length
    : shapefileCollection.features.filter((feature) => geometryOverlapsDem(feature.geometry)).length;
  if (!shapefileStandalone && !overlapCount) {
    shapefileCollection = null;
    shapefileWgs84Collection = null;
    throw new Error('Tidak ada feature yang beririsan dengan extent DEM. Periksa CRS dan lokasi data Shapefile.');
  }
  shapefileSourceName = file.name;
  shapefileVisible = true;
  shapefileBackdrop.visible = shapefileStandalone;
  shapefileGrid.visible = shapefileStandalone;
  terrain.visible = !shapefileStandalone;
  base.visible = !shapefileStandalone;
  renderShapefileLayer();
  renderGlobeShapefile('globe-standard');
  focusGlobeOnShapefile();
  setViewMode('globe-standard');
  refreshShapefileStats();
  document.querySelector('#shapefileActions').classList.remove('hidden');
  document.querySelector('#shapefileBadge').textContent = 'Aktif';
  document.querySelector('#toggleShapefile').disabled = false;
  document.querySelector('#toggleShapefile').textContent = 'Sembunyikan layer';
  const warning = validation.incomplete.length ? ` · ${validation.incomplete.length} layer tidak lengkap dilewati` : '';
  const status = document.querySelector('#shapefileStatus');
  status.textContent = shapefileStandalone
    ? `${validation.complete.length} layer · ${shapefileCollection.features.length} feature · mode peta datar · ${wgs84Spatial.label}${warning}`
    : `${validation.complete.length} layer · ${shapefileCollection.features.length} feature · ${overlapCount} beririsan dengan DEM · ${demMeta.spatial.label}${warning}`;
  status.classList.remove('hidden');
  setStatus('Shapefile berhasil dimuat', shapefileStandalone
    ? `${shapefileCollection.features.length} feature dirender langsung tanpa orthomosaic atau DEM.`
    : `${shapefileCollection.features.length} feature diselaraskan ke ${demMeta.spatial.label}.`);
}

function clearShapefileLayer() {
  shapefileCollection = null;
  shapefileWgs84Collection = null;
  shapefileFeatureStats = [];
  shapefileSourceName = '';
  shapefileStandalone = false;
  shapefileBounds = null;
  for (const child of [...shapefileGroup.children]) {
    shapefileGroup.remove(child);
    disposeObject3d(child);
  }
  for (const child of [...globeFeatureGroup.children]) {
    globeFeatureGroup.remove(child);
    disposeObject3d(child);
  }
  document.querySelector('#shapefileInput').value = '';
  document.querySelector('#shapefileActions').classList.add('hidden');
  document.querySelector('#shapefileSummary').classList.add('hidden');
  document.querySelector('#shapefileFeatureList').classList.add('hidden');
  document.querySelector('#shapefileStatus').classList.add('hidden');
  document.querySelector('#shapefileBadge').textContent = 'Siap';
  document.querySelector('#toggleShapefile').disabled = false;
  document.querySelector('#toggleShapefile').textContent = 'Sembunyikan layer';
  shapefileBackdrop.visible = false;
  shapefileGrid.visible = false;
  terrain.visible = true;
  base.visible = true;
  globeFeatureGroup.visible = false;
  setViewMode(viewMode);
}

function exportImportedShapefile() {
  if (!shapefileCollection) return;
  const output = { ...shapefileCollection, name: shapefileSourceName.replace(/\.zip$/i, '') };
  const crs = geoJsonCrs(shapefileStandalone ? wgs84Spatial : demMeta.spatial);
  if (crs) output.crs = crs;
  downloadText(`${output.name || 'shapefile'}-aligned.geojson`, JSON.stringify(output), 'application/geo+json');
}

function calculateMeasurementStats() {
  if (measurementPoints.length < 3 || !demValues) return;
  const xs = measurementPoints.map((point) => point.data.x);
  const ys = measurementPoints.map((point) => point.data.y);
  const bounds = {
    minX: Math.max(0, Math.floor(Math.min(...xs))), maxX: Math.min(demWidth - 1, Math.ceil(Math.max(...xs))),
    minY: Math.max(0, Math.floor(Math.min(...ys))), maxY: Math.min(demHeight - 1, Math.ceil(Math.max(...ys))),
  };
  const candidateCount = Math.max(1, (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1));
  const stride = Math.max(1, Math.ceil(Math.sqrt(candidateCount / 75000)));
  let count = 0;
  let elevationMin = Infinity;
  let elevationMax = -Infinity;
  let slopeSum = 0;
  let suitableCount = 0;
  let floodCount = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += stride) {
    for (let x = bounds.minX; x <= bounds.maxX; x += stride) {
      if (!pointInPolygon(x, y, measurementPoints)) continue;
      const index = y * demWidth + x;
      if (!validElevation(demValues[index])) continue;
      const elevation = demValues[index];
      const slope = slopeValues[index];
      count++;
      elevationMin = Math.min(elevationMin, elevation);
      elevationMax = Math.max(elevationMax, elevation);
      slopeSum += slope;
      if (slope <= 15) suitableCount++;
      if (floodRiskValues && floodRiskValues[index] >= 0.65) floodCount++;
    }
  }
  const metrics = polygonMetrics(measurementPoints);
  measurementSummary = {
    ...metrics,
    elevationMin: count ? elevationMin : null,
    elevationMax: count ? elevationMax : null,
    averageSlope: count ? slopeSum / count : null,
    suitablePercent: count ? suitableCount / count * 100 : null,
    highFloodPercent: count && floodRiskValues ? floodCount / count * 100 : null,
  };
  document.querySelector('#measureAreaValue').textContent = formatArea(metrics.area);
  document.querySelector('#measurePerimeterValue').textContent = formatDistance(metrics.perimeter);
  document.querySelector('#measureElevationValue').textContent = count ? `${elevationMin.toFixed(0)}–${elevationMax.toFixed(0)} m` : '—';
  document.querySelector('#measureSlopeValue').textContent = count ? `${measurementSummary.averageSlope.toFixed(1)}°` : '—';
  document.querySelector('#measureSuitableValue').textContent = count ? `${measurementSummary.suitablePercent.toFixed(1)}%` : '—';
  document.querySelector('#measureFloodValue').textContent = floodRiskValues ? `${measurementSummary.highFloodPercent.toFixed(1)}%` : 'Run hydro';
  document.querySelector('#measurementStats').classList.remove('hidden');
  document.querySelector('#exportMeasurement').disabled = false;
}

function suitabilityForSlope(slope) {
  if (slope <= 8) return ['Sangat sesuai', 'S1'];
  if (slope <= 15) return ['Sesuai', 'S2'];
  if (slope <= 25) return ['Terbatas', 'S3'];
  return ['Tidak sesuai', 'N'];
}

function exportSuitabilityCsv() {
  if (!slopeValues) return;
  const classes = [
    ['S1', 'Sangat sesuai', '0–8', 0], ['S2', 'Sesuai', '>8–15', 0],
    ['S3', 'Terbatas', '>15–25', 0], ['N', 'Tidak sesuai', '>25', 0],
  ];
  for (let index = 0; index < slopeValues.length; index++) {
    if (!validElevation(demValues[index])) continue;
    const slope = slopeValues[index];
    classes[slope <= 8 ? 0 : slope <= 15 ? 1 : slope <= 25 ? 2 : 3][3]++;
  }
  const rows = ['class,label,slope_degrees,area_ha,percent'];
  const total = classes.reduce((sum, row) => sum + row[3], 0);
  for (const [code, label, range, count] of classes) rows.push(`${code},${label},${range},${(count * pixelAreaMetres / 10000).toFixed(4)},${(count / total * 100).toFixed(2)}`);
  downloadText('slope-suitability-summary.csv', rows.join('\n'), 'text/csv');
}

function exportWaterwaysGeoJson() {
  if (!hydrologyResult || !streamMask) return;
  const upstream = new Uint8Array(streamMask.length);
  for (let i = 0; i < streamMask.length; i++) {
    const target = hydrologyResult.flowTo[i];
    if (streamMask[i] && target >= 0 && streamMask[target] && upstream[target] < 255) upstream[target]++;
  }
  const starts = [];
  for (let i = 0; i < streamMask.length; i++) if (streamMask[i] && upstream[i] === 0) starts.push(i);
  const features = [];
  for (const start of starts) {
    const coordinates = [];
    let current = start;
    let guard = 0;
    while (current >= 0 && streamMask[current] && guard++ < streamMask.length) {
      coordinates.push(coordinateAtPixel(current));
      current = hydrologyResult.flowTo[current];
    }
    if (coordinates.length > 1) {
      let lengthMetres = 0;
      for (let i = 1; i < coordinates.length; i++) {
        lengthMetres += coordinateDistanceMetres(
          { x: coordinates[i - 1][0], y: coordinates[i - 1][1] },
          { x: coordinates[i][0], y: coordinates[i][1] },
          demMeta.spatial,
        );
      }
      features.push({
        type: 'Feature',
        properties: {
          upstream_ha: Number((hydrologyResult.accumulation[start] * pixelAreaMetres / 10000).toFixed(3)),
          length_m: Number(lengthMetres.toFixed(2)),
        },
        geometry: { type: 'LineString', coordinates },
      });
    }
  }
  const output = { type: 'FeatureCollection', name: 'terrain-derived-waterways', features };
  const crs = geoJsonCrs(demMeta.spatial);
  if (crs) output.crs = crs;
  downloadText('waterways.geojson', JSON.stringify(output), 'application/geo+json');
  setStatus('Waterways diekspor', `${features.length} jalur tersimpan sebagai GeoJSON.`);
}

function exportFloodCsv() {
  if (!floodRiskValues) return;
  const stride = Math.max(1, Math.ceil(Math.sqrt(floodRiskValues.length / 100000)));
  const spatial = demMeta.spatial;
  const coordinateHeaders = spatial.kind === 'projected' ? 'easting,northing' : spatial.kind === 'geographic' ? 'longitude,latitude' : 'x,y';
  const rows = [`${coordinateHeaders},elevation_m,slope_deg,upstream_ha,fill_depth_m,risk_score,risk_class,crs`];
  for (let y = 0; y < demHeight; y += stride) {
    for (let x = 0; x < demWidth; x += stride) {
      const index = y * demWidth + x;
      if (!validElevation(demValues[index])) continue;
      const [coordinateX, coordinateY] = coordinateAtPixel(index);
      const risk = floodRiskValues[index];
      const label = risk >= 0.8 ? 'Critical' : risk >= 0.65 ? 'High' : risk >= 0.4 ? 'Medium' : 'Low';
      rows.push(`${coordinateX.toFixed(spatial.coordinateDecimals)},${coordinateY.toFixed(spatial.coordinateDecimals)},${demValues[index].toFixed(2)},${slopeValues[index].toFixed(2)},${(hydrologyResult.accumulation[index] * pixelAreaMetres / 10000).toFixed(4)},${hydrologyResult.depth[index].toFixed(3)},${Math.round(risk * 100)},${label},${spatial.epsg ? `EPSG:${spatial.epsg}` : 'unknown'}`);
    }
  }
  downloadText('flood-susceptibility.csv', rows.join('\n'), 'text/csv');
}

function textureFromRgba(rgba, width, height) {
  const layerCanvas = document.createElement('canvas');
  layerCanvas.width = width;
  layerCanvas.height = height;
  layerCanvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const texture = new THREE.CanvasTexture(layerCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.flipY = true;
  return texture;
}

function normaliseNoData(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function inferBorderNoData(values, width, height, declared) {
  const metadataValue = normaliseNoData(declared);
  if (metadataValue !== null) return { value: metadataValue, source: 'metadata' };

  const counts = new Map();
  let borderSamples = 0;
  const add = (value) => {
    if (!Number.isFinite(value)) return;
    const key = Number(value).toPrecision(12);
    const entry = counts.get(key) || { value: Number(value), count: 0 };
    entry.count++;
    counts.set(key, entry);
    borderSamples++;
  };
  const stepX = Math.max(1, Math.floor(width / 2000));
  const stepY = Math.max(1, Math.floor(height / 2000));
  for (let x = 0; x < width; x += stepX) {
    add(values[x]);
    add(values[(height - 1) * width + x]);
  }
  for (let y = 1; y < height - 1; y += stepY) {
    add(values[y * width]);
    add(values[y * width + width - 1]);
  }
  const dominant = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!dominant || dominant.count / Math.max(1, borderSamples) < 0.3) return { value: null, source: 'none' };

  let min = Infinity;
  let max = -Infinity;
  const stride = Math.max(1, Math.floor(values.length / 250000));
  for (let index = 0; index < values.length; index += stride) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const range = Math.max(1e-9, max - min);
  const atExtreme = Math.abs(dominant.value - min) <= range * 1e-8
    || Math.abs(dominant.value - max) <= range * 1e-8;
  return atExtreme ? { value: dominant.value, source: 'border inference' } : { value: null, source: 'none' };
}

function validElevation(value) {
  if (!Number.isFinite(value)) return false;
  if (demNoData === null) return true;
  const tolerance = Math.max(1, Math.abs(demNoData)) * 1e-7;
  return Math.abs(value - demNoData) > tolerance;
}

function getElevationAt(x, y) {
  const px = Math.max(0, Math.min(demWidth - 1, Math.round(x)));
  const py = Math.max(0, Math.min(demHeight - 1, Math.round(y)));
  const value = demValues[py * demWidth + px];
  return validElevation(value) ? value : demMin;
}

function generateAnalysisLayers() {
  if (!demValues || !demMeta) return;
  const total = demWidth * demHeight;
  const elevationRgba = new Uint8ClampedArray(total * 4);
  const hillshadeRgba = new Uint8ClampedArray(total * 4);
  const slopeRgba = new Uint8ClampedArray(total * 4);
  const contourRgba = new Uint8ClampedArray(total * 4);
  const suitabilityRgba = new Uint8ClampedArray(total * 4);
  slopeValues = new Float32Array(total);

  const elevationStops = [
    [16, 42, 67], [29, 145, 192], [127, 205, 187],
    [238, 225, 128], [244, 109, 67], [127, 0, 0],
  ];
  const slopeStops = [
    [223, 246, 233], [116, 196, 118], [255, 235, 59],
    [255, 152, 0], [211, 47, 47],
  ];
  const suitabilityCounts = [0, 0, 0, 0];
  const suitabilityColors = [[46,125,50],[139,195,74],[255,193,7],[198,40,40]];
  const range = Math.max(1, demMax - demMin);
  demGroundMetrics = rasterGroundMetrics(demMeta, demWidth, demHeight);
  const pixelXMetres = demGroundMetrics.pixelWidth;
  const pixelYMetres = demGroundMetrics.pixelHeight;
  pixelAreaMetres = demGroundMetrics.pixelArea;
  const azimuth = 315 * Math.PI / 180;
  const altitude = 45 * Math.PI / 180;
  const contourInterval = range > 1500 ? 250 : range > 500 ? 100 : 25;

  for (let y = 0; y < demHeight; y++) {
    for (let x = 0; x < demWidth; x++) {
      const pixel = y * demWidth + x;
      const offset = pixel * 4;
      const valid = validElevation(demValues[pixel]);
      const z = getElevationAt(x, y);
      const left = getElevationAt(x - 1, y);
      const right = getElevationAt(x + 1, y);
      const top = getElevationAt(x, y - 1);
      const bottom = getElevationAt(x, y + 1);
      const dzdx = (right - left) / (2 * pixelXMetres);
      const dzdy = (bottom - top) / (2 * pixelYMetres);
      const slopeRad = Math.atan(Math.hypot(dzdx, dzdy));
      const slopeDeg = slopeRad * 180 / Math.PI;
      const aspect = Math.atan2(dzdy, -dzdx);
      const shade = Math.sin(altitude) * Math.cos(slopeRad)
        + Math.cos(altitude) * Math.sin(slopeRad) * Math.cos(azimuth - aspect);
      slopeValues[pixel] = slopeDeg;
      const suitabilityClass = slopeDeg <= 8 ? 0 : slopeDeg <= 15 ? 1 : slopeDeg <= 25 ? 2 : 3;
      if (valid) suitabilityCounts[suitabilityClass]++;

      const elevationColor = colorRamp((z - demMin) / range, elevationStops);
      const slopeColor = colorRamp(Math.min(slopeDeg, 35) / 35, slopeStops);
      const gray = Math.round(THREE.MathUtils.clamp((shade + 0.2) / 1.2, 0, 1) * 255);
      const contourDistance = Math.min(z % contourInterval, contourInterval - (z % contourInterval));
      const isContour = contourDistance < Math.max(1.5, Math.hypot(dzdx, dzdy) * 1.8);

      for (let channel = 0; channel < 3; channel++) {
        elevationRgba[offset + channel] = elevationColor[channel];
        slopeRgba[offset + channel] = slopeColor[channel];
        hillshadeRgba[offset + channel] = gray;
        contourRgba[offset + channel] = isContour ? 18 : elevationColor[channel];
        suitabilityRgba[offset + channel] = suitabilityColors[suitabilityClass][channel];
      }
      elevationRgba[offset + 3] = hillshadeRgba[offset + 3] = slopeRgba[offset + 3] = contourRgba[offset + 3] = suitabilityRgba[offset + 3] = valid ? 255 : 0;
    }
  }

  for (const key of ['elevation', 'hillshade', 'slope', 'suitability', 'contour']) layerTextures[key]?.dispose();
  layerTextures.elevation = textureFromRgba(elevationRgba, demWidth, demHeight);
  layerTextures.hillshade = textureFromRgba(hillshadeRgba, demWidth, demHeight);
  layerTextures.slope = textureFromRgba(slopeRgba, demWidth, demHeight);
  layerTextures.suitability = textureFromRgba(suitabilityRgba, demWidth, demHeight);
  layerTextures.contour = textureFromRgba(contourRgba, demWidth, demHeight);

  document.querySelector('#layerSection').classList.remove('disabled-section');
  document.querySelector('#layerBadge').textContent = 'Siap';
  document.querySelector('#profileMode').disabled = false;
  document.querySelector('#measurementSection').classList.remove('disabled-section');
  document.querySelector('#measurementBadge').textContent = 'Siap';
  document.querySelector('#measureArea').disabled = false;
  document.querySelector('#shapefileSection').classList.remove('disabled-section');
  document.querySelector('#shapefileBadge').textContent = shapefileCollection ? 'Aktif' : 'Siap';
  document.querySelector('#shapefileInput').disabled = false;
  document.querySelector('#hydrologySection').classList.remove('disabled-section');
  document.querySelector('#suitabilitySection').classList.remove('disabled-section');
  document.querySelector('#suitabilityBadge').textContent = 'Siap';
  document.querySelector('#exportSuitability').disabled = false;
  renderClassStats('#suitabilityStats', [
    ['Sangat sesuai · 0–8°', suitabilityCounts[0], '#2e7d32'],
    ['Sesuai · >8–15°', suitabilityCounts[1], '#8bc34a'],
    ['Terbatas · >15–25°', suitabilityCounts[2], '#ffc107'],
    ['Tidak sesuai · >25°', suitabilityCounts[3], '#c62828'],
  ]);
  selectLayer(activeLayer === 'texture' && !layerTextures.texture ? 'elevation' : activeLayer);
}

function selectLayer(name) {
  if (name !== 'texture' && !layerTextures[name]) return;
  activeLayer = name;
  material.map = layerTextures[name] || surfaceTexture;
  material.needsUpdate = true;
  if (fpsTerrain) {
    fpsTerrain.material.map = firstPersonMode ? surfaceTexture : (layerTextures[name] || surfaceTexture);
    fpsTerrain.material.needsUpdate = true;
  }
  document.querySelectorAll('.layer-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.layer === name);
  });

  const legend = document.querySelector('#legend');
  legend.classList.toggle('hidden', name === 'texture' || name === 'hillshade');
  if (name === 'elevation' || name === 'contour') {
    document.querySelector('#legendGradient').style.background = 'linear-gradient(90deg,#102a43,#1d91c0,#7fcdbb,#eee180,#f46d43,#7f0000)';
    document.querySelector('#legendMin').textContent = `${Math.round(demMin)} m`;
    document.querySelector('#legendMax').textContent = `${Math.round(demMax)} m`;
    document.querySelector('#legendTitle').textContent = name === 'contour' ? 'Contour + elevasi' : 'Elevasi';
  } else if (name === 'slope') {
    document.querySelector('#legendGradient').style.background = 'linear-gradient(90deg,#dff6e9,#74c476,#ffeb3b,#ff9800,#d32f2f)';
    document.querySelector('#legendMin').textContent = '0°';
    document.querySelector('#legendMax').textContent = '≥35°';
    document.querySelector('#legendTitle').textContent = 'Slope';
  } else if (name === 'suitability') {
    document.querySelector('#legendGradient').style.background = 'linear-gradient(90deg,#2e7d32 0 25%,#8bc34a 25% 50%,#ffc107 50% 75%,#c62828 75%)';
    document.querySelector('#legendMin').textContent = 'Sangat sesuai';
    document.querySelector('#legendMax').textContent = 'Tidak sesuai';
    document.querySelector('#legendTitle').textContent = 'Slope suitability';
  } else if (name === 'depression') {
    document.querySelector('#legendGradient').style.background = 'linear-gradient(90deg,#17252d,#4dd0e1,#1976d2,#0d47a1)';
    document.querySelector('#legendMin').textContent = '0 m';
    document.querySelector('#legendMax').textContent = `${hydrologyResult?.maxDepth.toFixed(1) || 0} m`;
    document.querySelector('#legendTitle').textContent = 'Fill depth';
  } else if (name === 'risk') {
    document.querySelector('#legendGradient').style.background = 'linear-gradient(90deg,#2e7d32,#fdd835,#fb8c00,#c62828)';
    document.querySelector('#legendMin').textContent = 'Low';
    document.querySelector('#legendMax').textContent = 'Critical';
    document.querySelector('#legendTitle').textContent = 'Flood risk';
  } else if (name === 'flow') {
    legend.classList.add('hidden');
  }
}

function currentRiskWeights() {
  const raw = {
    flow: Number(document.querySelector('#riskFlowWeight').value),
    depth: Number(document.querySelector('#riskDepthWeight').value),
    flat: Number(document.querySelector('#riskFlatWeight').value),
  };
  const total = Math.max(1, raw.flow + raw.depth + raw.flat);
  return { flow: raw.flow / total, depth: raw.depth / total, flat: raw.flat / total };
}

function floodRiskComponents(pixel, slope) {
  const criticalDepth = Number(document.querySelector('#criticalDepth').value);
  const weights = currentRiskWeights();
  const accNorm = Math.log1p(hydrologyResult.accumulation[pixel])
    / Math.max(1, Math.log1p(hydrologyResult.maxAccumulation));
  const depthNorm = Math.min(1, hydrologyResult.depth[pixel] / Math.max(0.05, criticalDepth));
  const flatness = 1 - Math.min(1, slope / 12);
  const drivers = {
    flow: accNorm * weights.flow,
    depth: depthNorm * weights.depth,
    flat: flatness * weights.flat,
  };
  return { risk: Math.min(1, drivers.flow + drivers.depth + drivers.flat), drivers };
}

function generateHydrologyLayers() {
  if (!hydrologyResult || !demValues) return;
  const { accumulation, depth, maxAccumulation } = hydrologyResult;
  const total = demWidth * demHeight;
  const flowRgba = new Uint8ClampedArray(total * 4);
  const depressionRgba = new Uint8ClampedArray(total * 4);
  const riskRgba = new Uint8ClampedArray(total * 4);
  const streamHectares = Number(document.querySelector('#streamThreshold').value);
  const streamCells = streamHectares * 10000 / pixelAreaMetres;
  const logMax = Math.max(1, Math.log1p(maxAccumulation));
  let highRiskPixels = 0;
  const riskCounts = [0, 0, 0, 0];
  let streamPixels = 0;
  floodRiskValues = new Float32Array(total);
  streamMask = new Uint8Array(total);

  for (let y = 0; y < demHeight; y++) {
    for (let x = 0; x < demWidth; x++) {
      const pixel = y * demWidth + x;
      const offset = pixel * 4;
      const valid = validElevation(demValues[pixel]);
      const accNorm = valid ? Math.log1p(accumulation[pixel]) / logMax : 0;
      const criticalDepth = Number(document.querySelector('#criticalDepth').value);
      const depthNorm = valid ? Math.min(1, depth[pixel] / Math.max(0.05, criticalDepth)) : 0;
      const risk = valid ? floodRiskComponents(pixel, slopeValues?.[pixel] || 0).risk : 0;
      floodRiskValues[pixel] = risk;
      if (valid) riskCounts[risk >= 0.8 ? 3 : risk >= 0.65 ? 2 : risk >= 0.4 ? 1 : 0]++;
      if (valid && risk >= 0.65) highRiskPixels++;

      const shade = valid ? Math.round(30 + ((getElevationAt(x, y) - demMin) / Math.max(1, demMax - demMin)) * 75) : 8;
      const isStream = valid && accumulation[pixel] >= streamCells;
      streamMask[pixel] = isStream ? 1 : 0;
      if (isStream) streamPixels++;
      const flowColor = isStream ? colorRamp(Math.min(1, accumulation[pixel] / Math.max(streamCells, 1) / 20), [[77,208,225],[30,136,229],[13,71,161]]) : [shade, shade + 8, shade + 10];
      const depressionColor = depth[pixel] > 0.02 ? colorRamp(depthNorm, [[77,208,225],[25,118,210],[13,71,161]]) : [23, 37, 45];
      const riskColor = colorRamp(risk, [[46,125,50],[253,216,53],[251,140,0],[198,40,40]]);

      for (let channel = 0; channel < 3; channel++) {
        flowRgba[offset + channel] = flowColor[channel];
        depressionRgba[offset + channel] = depressionColor[channel];
        riskRgba[offset + channel] = riskColor[channel];
      }
      flowRgba[offset + 3] = depressionRgba[offset + 3] = riskRgba[offset + 3] = valid ? 255 : 0;
    }
  }

  for (const key of ['flow', 'depression', 'risk']) layerTextures[key]?.dispose();
  layerTextures.flow = textureFromRgba(flowRgba, demWidth, demHeight);
  layerTextures.depression = textureFromRgba(depressionRgba, demWidth, demHeight);
  layerTextures.risk = textureFromRgba(riskRgba, demWidth, demHeight);
  document.querySelectorAll('.hydro-layer').forEach((button) => { button.disabled = false; });

  const depressionAreaHa = hydrologyResult.depressionPixels * pixelAreaMetres / 10000;
  const highRiskAreaHa = highRiskPixels * pixelAreaMetres / 10000;
  const maxAccumulationHa = maxAccumulation * pixelAreaMetres / 10000;
  document.querySelector('#depressionArea').textContent = `${depressionAreaHa.toFixed(2)} ha`;
  document.querySelector('#maxDepth').textContent = `${hydrologyResult.maxDepth.toFixed(2)} m`;
  document.querySelector('#highRiskArea').textContent = `${highRiskAreaHa.toFixed(2)} ha`;
  document.querySelector('#maxAccumulation').textContent = `${maxAccumulationHa.toFixed(1)} ha`;
  document.querySelector('#exportWaterways').disabled = streamPixels === 0;
  document.querySelector('#exportFlood').disabled = false;
  renderClassStats('#floodClassStats', [
    ['Low · 0–39', riskCounts[0], '#2e7d32'],
    ['Medium · 40–64', riskCounts[1], '#fdd835'],
    ['High · 65–79', riskCounts[2], '#fb8c00'],
    ['Critical · 80–100', riskCounts[3], '#c62828'],
  ]);
  document.querySelector('#floodClassStats').classList.remove('hidden');
  if (measurementPoints.length >= 3) calculateMeasurementStats();
  if (shapefileCollection) refreshShapefileStats();
  document.querySelector('#hydrologyStats').classList.remove('hidden');
  buildMiniMapBase();
  if (['flow', 'depression', 'risk'].includes(activeLayer)) selectLayer(activeLayer);
}

function runHydrologyAnalysis() {
  if (!demValues || !demMeta) return;
  hydrologyWorker?.terminate();
  hydrologyWorker = new Worker(new URL('./hydrology.worker.js', import.meta.url), { type: 'module' });
  const button = document.querySelector('#runHydrology');
  const progress = document.querySelector('#hydrologyProgress');
  button.disabled = true;
  button.textContent = 'Menghitung…';
  progress.classList.remove('hidden');
  document.querySelector('#hydrologyBadge').textContent = 'Processing';
  setStatus('Analisis hidrologi berjalan', 'Menyiapkan sink filling dan jaringan aliran D8.');

  hydrologyWorker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      document.querySelector('#hydrologyBadge').textContent = `${Math.round(data.value * 100)}%`;
      setStatus(data.stage, `${Math.round(data.value * 100)}% selesai.`);
      return;
    }
    if (data.type === 'result') {
      hydrologyResult = {
        ...data,
        filled: new Float32Array(data.filled),
        depth: new Float32Array(data.depth),
        flowTo: new Int32Array(data.flowTo),
        accumulation: new Float32Array(data.accumulation),
      };
      generateHydrologyLayers();
      button.disabled = false;
      button.textContent = 'Hitung ulang Flood Risk';
      progress.classList.add('hidden');
      document.querySelector('#hydrologyBadge').textContent = 'Selesai';
      setStatus('Analisis hidrologi selesai', 'Layer flow, depression, dan flood risk sudah tersedia.');
      hydrologyWorker.terminate();
      hydrologyWorker = null;
    }
  };

  hydrologyWorker.onerror = (error) => {
    console.error(error);
    button.disabled = false;
    button.textContent = 'Coba kembali';
    progress.classList.add('hidden');
    document.querySelector('#hydrologyBadge').textContent = 'Error';
    setStatus('Analisis hidrologi gagal', error.message || 'Worker tidak dapat menyelesaikan raster.', true);
  };

  const elevations = Float32Array.from(demValues, (value) => Number(value));
  const workerNoData = demNoData === null ? null : new Float32Array([demNoData])[0];
  hydrologyWorker.postMessage({
    elevations: elevations.buffer,
    width: demWidth,
    height: demHeight,
    noData: workerNoData,
    pixelArea: pixelAreaMetres,
    pixelWidth: demGroundMetrics.pixelWidth,
    pixelHeight: demGroundMetrics.pixelHeight,
  }, [elevations.buffer]);
}

function isTiff(file) {
  return /\.tiff?$/i.test(file.name) || file.type === 'image/tiff';
}

const LARGE_RASTER_BYTES = 512 * 1024 * 1024;
const DEM_PREVIEW_PIXELS = 2_000_000;
const TEXTURE_PREVIEW_PIXELS = 8_000_000;

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function safeBoundingBox(image) {
  try {
    const bbox = image.getBoundingBox();
    if (bbox.length === 4 && bbox.every(Number.isFinite)) return { bbox, georeferenced: true };
  } catch (_) {
    // Plain TIFFs can still be rendered; only coordinate-based tools are limited.
  }
  return {
    bbox: [0, 0, image.getWidth(), image.getHeight()],
    georeferenced: false,
  };
}

function sameExtent(a, b) {
  const size = Math.max(1, ...a.map(Math.abs), ...b.map(Math.abs));
  const tolerance = size * 1e-7;
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

function previewDimensions(sourceWidth, sourceHeight, type) {
  const gpuLimit = Math.max(1024, Math.min(renderer.capabilities.maxTextureSize || 4096, 4096));
  const maxDimension = type === 'height' ? Math.min(2048, gpuLimit) : gpuLimit;
  const pixelBudget = type === 'height' ? DEM_PREVIEW_PIXELS : TEXTURE_PREVIEW_PIXELS;
  const scale = Math.min(
    1,
    maxDimension / sourceWidth,
    maxDimension / sourceHeight,
    Math.sqrt(pixelBudget / (sourceWidth * sourceHeight)),
  );
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    scale,
  };
}

async function selectBestOverview(tiff, baseImage, baseBounds, target) {
  let selectedImage = baseImage;
  let selectedIndex = 0;
  let selectedArea = baseImage.getWidth() * baseImage.getHeight();
  const imageCount = await tiff.getImageCount();

  for (let index = 1; index < imageCount; index++) {
    const candidate = await tiff.getImage(index);
    const candidateBounds = safeBoundingBox(candidate);
    const width = candidate.getWidth();
    const height = candidate.getHeight();
    const area = width * height;
    const matchingAspect = Math.abs(width / height - baseImage.getWidth() / baseImage.getHeight()) < 0.01;
    const largeEnough = width >= target.width && height >= target.height;
    const matchingBounds = baseBounds.georeferenced
      ? candidateBounds.georeferenced && sameExtent(candidateBounds.bbox, baseBounds.bbox)
      : !candidateBounds.georeferenced;
    if (matchingBounds
      && matchingAspect && largeEnough && area < selectedArea) {
      selectedImage = candidate;
      selectedIndex = index;
      selectedArea = area;
    }
  }

  return { image: selectedImage, index: selectedIndex, imageCount };
}

async function readGeoTiff(file, type) {
  // fromBlob reads byte ranges with Blob.slice(). Unlike file.arrayBuffer(), it
  // does not duplicate the complete multi-GB TIFF in browser memory.
  const tiff = await fromBlob(file, { cacheSize: 100 });
  const baseImage = await tiff.getImage(0);
  const sourceWidth = baseImage.getWidth();
  const sourceHeight = baseImage.getHeight();
  const bounds = safeBoundingBox(baseImage);
  let geoKeys = {};
  try {
    geoKeys = baseImage.getGeoKeys() || {};
  } catch (_) {
    // TIFF tanpa GeoKeys tetap dapat divisualisasikan dengan asumsi satuan lokal.
  }
  const spatial = buildSpatialReference({ geoKeys, bbox: bounds.bbox, georeferenced: bounds.georeferenced });
  const target = previewDimensions(sourceWidth, sourceHeight, type);
  const overview = await selectBestOverview(tiff, baseImage, bounds, target);
  const directory = overview.image.fileDirectory || {};
  const tiled = Boolean(directory.TileWidth && directory.TileLength);
  const rowsPerStrip = Number(directory.RowsPerStrip || overview.image.getHeight());
  if (file.size >= LARGE_RASTER_BYTES && !tiled && rowsPerStrip >= overview.image.getHeight()) {
    throw new Error('TIFF besar ini tersimpan sebagai satu strip sehingga browser harus mendekompres seluruh raster sekaligus. Konversi sekali ke tiled GeoTIFF/COG dengan internal overview, lalu buka hasilnya.');
  }
  return {
    tiff,
    image: overview.image,
    width: target.width,
    height: target.height,
    sourceWidth,
    sourceHeight,
    overviewWidth: overview.image.getWidth(),
    overviewHeight: overview.image.getHeight(),
    overviewIndex: overview.index,
    imageCount: overview.imageCount,
    bbox: bounds.bbox,
    georeferenced: bounds.georeferenced,
    geoKeys,
    spatial,
    noData: baseImage.getGDALNoData(),
    samples: overview.image.getSamplesPerPixel(),
    fileSize: file.size,
    large: file.size >= LARGE_RASTER_BYTES || target.scale < 1,
    tiled,
    rowsPerStrip,
    photometric: Number(directory.PhotometricInterpretation ?? -1),
    bitsPerSample: directory.BitsPerSample || [],
  };
}

async function readRasterPreview(meta, samples, type, fileName) {
  const channels = samples.length;
  const totalValues = meta.width * meta.height * channels;
  const sourceWidth = meta.image.getWidth();
  const sourceHeight = meta.image.getHeight();
  const chunkRows = type === 'height' ? 96 : 128;
  let output = null;

  // Reading the complete extent in one readRasters() call can queue thousands
  // of compressed blocks simultaneously. Row bands keep peak memory bounded,
  // which is essential for multi-GB orthomosaics without internal overviews.
  for (let outputY = 0; outputY < meta.height; outputY += chunkRows) {
    const outputRows = Math.min(chunkRows, meta.height - outputY);
    const sourceY0 = Math.floor(outputY / meta.height * sourceHeight);
    const sourceY1 = Math.max(
      sourceY0 + 1,
      Math.min(sourceHeight, Math.ceil((outputY + outputRows) / meta.height * sourceHeight)),
    );
    const chunk = await meta.image.readRasters({
      interleave: true,
      samples,
      window: [0, sourceY0, sourceWidth, sourceY1],
      width: meta.width,
      height: outputRows,
      resampleMethod: type === 'height' ? 'nearest' : 'bilinear',
    });
    if (!output) output = new chunk.constructor(totalValues);
    output.set(chunk, outputY * meta.width * channels);

    const progress = Math.round((outputY + outputRows) / meta.height * 100);
    setStatus(
      type === 'height' ? 'Membaca DEM bertahap' : 'Membaca texture bertahap',
      `${fileName} · ${progress}% · penggunaan memori dijaga tetap stabil.`,
    );
    await nextPaint();
  }
  return output;
}

async function readTexturePreview(meta, fileName) {
  const totalPixels = meta.width * meta.height;
  const sourceWidth = meta.image.getWidth();
  const sourceHeight = meta.image.getHeight();
  const chunkRows = 128;
  let output = null;
  let channels = 3;

  for (let outputY = 0; outputY < meta.height; outputY += chunkRows) {
    const outputRows = Math.min(chunkRows, meta.height - outputY);
    const sourceY0 = Math.floor(outputY / meta.height * sourceHeight);
    const sourceY1 = Math.max(
      sourceY0 + 1,
      Math.min(sourceHeight, Math.ceil((outputY + outputRows) / meta.height * sourceHeight)),
    );
    const chunk = await meta.image.readRGB({
      window: [0, sourceY0, sourceWidth, sourceY1],
      width: meta.width,
      height: outputRows,
      resampleMethod: 'bilinear',
      enableAlpha: false,
    });
    const chunkPixels = meta.width * outputRows;
    const chunkChannels = Math.round(chunk.length / chunkPixels);
    if (!output) {
      channels = chunkChannels;
      output = new chunk.constructor(totalPixels * channels);
    }
    if (chunkChannels !== channels) throw new Error('Jumlah channel texture berubah saat membaca TIFF.');
    output.set(chunk, outputY * meta.width * channels);

    const progress = Math.round((outputY + outputRows) / meta.height * 100);
    setStatus('Mengekstrak texture dari TIFF', `${fileName} · ${progress}% · RGB dibaca langsung dari band raster.`);
    await nextPaint();
  }
  return { raster: output, channels };
}

async function detectGeoTiffRole(file) {
  setStatus('Memeriksa isi GeoTIFF', `${file.name} · membaca jumlah band dan photometric interpretation.`);
  await nextPaint();
  const tiff = await fromBlob(file, { cacheSize: 20 });
  const image = await tiff.getImage(0);
  const samples = image.getSamplesPerPixel();
  const directory = image.fileDirectory || {};
  const photometric = Number(directory.PhotometricInterpretation ?? -1);
  const textureName = /(mosaic|ortho|rgb|image|imagery|satellite|aerial|photo|citra)/i.test(file.name);
  const demName = /(^|[_\-.])(dem|dtm|dsm|elev|elevation|height|srtm|lidar)([_\-.]|$)/i.test(file.name);
  const colourPhotometric = [2, 3, 5, 6, 8].includes(photometric);
  const role = samples >= 3 || colourPhotometric || (textureName && !demName) ? 'surface' : 'height';
  return { role, samples, photometric };
}

function showAutoDetectResult(file, detection) {
  const element = document.querySelector('#autoDetectResult');
  if (detection.role === 'surface') {
    element.textContent = `${file.name}: terdeteksi sebagai orthomosaic/texture (${detection.samples} band). Warna diekstrak langsung dari TIFF.`;
  } else {
    element.textContent = `${file.name}: terdeteksi sebagai DEM (${detection.samples} band). TIFF tidak memiliki foto RGB; viewer memakai visual elevation/hillshade.`;
  }
  element.classList.remove('hidden');
}

function gridsMatch(a, b) {
  if (!a || !b || !a.georeferenced || !b.georeferenced) return false;
  return sameSpatialReference(a.spatial, b.spatial) && sameExtent(a.bbox, b.bbox);
}

function updateAlignmentStatus() {
  if (!demMeta || !textureMeta) return;
  if (gridsMatch(demMeta, textureMeta)) {
    setStatus('DEM dan texture sejajar', 'Extent GeoTIFF identik; perbedaan resolusi sumber ditangani oleh preview adaptif.');
  } else {
    setStatus('Extent belum cocok', 'Periksa CRS dan batas DEM/texture sebelum analisis lokasi.', true);
  }
}

function renderRasterLoadInfo(type, meta, file) {
  const element = document.querySelector(type === 'height' ? '#demRasterInfo' : '#textureRasterInfo');
  const label = type === 'height' ? 'DEM' : 'Texture';
  const overview = meta.overviewIndex > 0
    ? `overview ${meta.overviewIndex} (${meta.overviewWidth.toLocaleString('id-ID')} × ${meta.overviewHeight.toLocaleString('id-ID')})`
    : 'raster utama';
  const metrics = rasterGroundMetrics(meta, meta.width, meta.height);
  const resolution = `${metrics.pixelWidth.toFixed(metrics.pixelWidth < 1 ? 2 : 1)} × ${metrics.pixelHeight.toFixed(metrics.pixelHeight < 1 ? 2 : 1)} m/pixel`;
  element.innerHTML = `<span>${label} · ${formatFileSize(file.size)}</span><strong>${meta.sourceWidth.toLocaleString('id-ID')} × ${meta.sourceHeight.toLocaleString('id-ID')} → ${meta.width.toLocaleString('id-ID')} × ${meta.height.toLocaleString('id-ID')}</strong><small>${meta.spatial.label} · ${resolution} · ${overview} · ${meta.tiled ? 'tiled' : 'striped'}</small>`;
  element.classList.remove('hidden');
  document.querySelector('#rasterLoadInfo').classList.remove('hidden');
}

function textureRasterToRgba(raster, pixels, channels, noData) {
  const minima = new Array(channels).fill(Infinity);
  const maxima = new Array(channels).fill(-Infinity);
  const stride = Math.max(1, Math.floor(pixels / 300000));
  const numericNoData = noData === null || noData === undefined ? null : Number(noData);

  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const source = pixel * channels;
    for (let channel = 0; channel < channels; channel++) {
      const value = Number(raster[source + channel]);
      if (!Number.isFinite(value) || (numericNoData !== null && value === numericNoData)) continue;
      minima[channel] = Math.min(minima[channel], value);
      maxima[channel] = Math.max(maxima[channel], value);
    }
  }

  const toByte = (value, channel) => {
    if (!Number.isFinite(value)) return 0;
    const min = minima[channel];
    const max = maxima[channel];
    if (min >= 0 && max <= 1.01) return Math.round(value * 255);
    if (min >= 0 && max <= 255) return Math.round(value);
    return Math.round(THREE.MathUtils.clamp((value - min) / Math.max(1e-9, max - min), 0, 1) * 255);
  };

  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const source = pixel * channels;
    const target = pixel * 4;
    const noDataPixel = numericNoData !== null
      && Array.from({ length: channels }, (_, channel) => Number(raster[source + channel]) === numericNoData).every(Boolean);
    if (channels >= 3) {
      rgba[target] = toByte(Number(raster[source]), 0);
      rgba[target + 1] = toByte(Number(raster[source + 1]), 1);
      rgba[target + 2] = toByte(Number(raster[source + 2]), 2);
    } else {
      const gray = toByte(Number(raster[source]), 0);
      rgba[target] = rgba[target + 1] = rgba[target + 2] = gray;
    }
    rgba[target + 3] = noDataPixel ? 0 : 255;
  }
  return rgba;
}

function applyDemToGeometry() {
  if (!demValues) return;
  const position = geometry.attributes.position;
  const scale = Number(document.querySelector('#heightScale').value);
  const invert = document.querySelector('#invertHeight').checked;
  const range = Math.max(1, demMax - demMin);
  const columns = geometry.parameters.widthSegments + 1;
  const rows = geometry.parameters.heightSegments + 1;

  for (let row = 0; row < rows; row++) {
    const sourceY = Math.min(demHeight - 1, Math.round((row / (rows - 1)) * (demHeight - 1)));
    for (let col = 0; col < columns; col++) {
      const sourceX = Math.min(demWidth - 1, Math.round((col / (columns - 1)) * (demWidth - 1)));
      const sourceValue = demValues[sourceY * demWidth + sourceX];
      const valid = validElevation(sourceValue);
      const normalized = valid ? (sourceValue - demMin) / range : 0;
      const elevation = (invert ? 1 - normalized : normalized) * scale;
      position.setY(row * columns + col, elevation - scale * 0.18);
    }
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

function bilinearElevation(x, y) {
  const x0 = Math.floor(THREE.MathUtils.clamp(x, 0, demWidth - 1));
  const y0 = Math.floor(THREE.MathUtils.clamp(y, 0, demHeight - 1));
  const x1 = Math.min(demWidth - 1, x0 + 1);
  const y1 = Math.min(demHeight - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = getElevationAt(x0, y0) * (1 - tx) + getElevationAt(x1, y0) * tx;
  const b = getElevationAt(x0, y1) * (1 - tx) + getElevationAt(x1, y1) * tx;
  return a * (1 - ty) + b * ty;
}

function buildFirstPersonTerrain() {
  if (!demValues || !demMeta) return;
  if (fpsTerrain) {
    scene.remove(fpsTerrain);
    fpsTerrain.geometry.dispose();
    fpsTerrain.material.dispose();
  }
  demGroundMetrics ||= rasterGroundMetrics(demMeta, demWidth, demHeight);
  fpsWidthMetres = demGroundMetrics.groundWidth;
  fpsHeightMetres = demGroundMetrics.groundHeight;
  const segmentsX = Math.min(384, Math.max(32, demWidth - 1));
  const segmentsY = Math.min(320, Math.max(32, Math.round(segmentsX * demHeight / demWidth)));
  const fpsGeometry = new THREE.PlaneGeometry(fpsWidthMetres, fpsHeightMetres, segmentsX, segmentsY);
  fpsGeometry.rotateX(-Math.PI / 2);
  const positions = fpsGeometry.attributes.position;
  const columns = segmentsX + 1;
  const rows = segmentsY + 1;
  for (let row = 0; row < rows; row++) {
    const sourceY = row / (rows - 1) * (demHeight - 1);
    for (let col = 0; col < columns; col++) {
      const sourceX = col / (columns - 1) * (demWidth - 1);
      positions.setY(row * columns + col, bilinearElevation(sourceX, sourceY) - demMin);
    }
  }
  positions.needsUpdate = true;
  fpsGeometry.computeVertexNormals();
  fpsGeometry.computeBoundingSphere();
  const fpsMaterial = new THREE.MeshStandardMaterial({
    // FPV is an inspection view: never inherit a false-colour analysis layer.
    map: surfaceTexture,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    transparent: true,
    alphaTest: 0.05,
  });
  fpsTerrain = new THREE.Mesh(fpsGeometry, fpsMaterial);
  fpsTerrain.visible = false;
  fpsTerrain.receiveShadow = true;
  scene.add(fpsTerrain);
  buildMiniMapBase();
}

function fpsUvFromPosition(x, z) {
  return new THREE.Vector2(
    THREE.MathUtils.clamp(x / fpsWidthMetres + 0.5, 0, 1),
    THREE.MathUtils.clamp(0.5 - z / fpsHeightMetres, 0, 1),
  );
}

function fpsGroundAt(x, z) {
  const uv = fpsUvFromPosition(x, z);
  return bilinearElevation(uv.x * (demWidth - 1), (1 - uv.y) * (demHeight - 1)) - demMin;
}

function fpsGroundEnvelopeAt(x, z) {
  // A small player footprint prevents the camera from clipping into the uphill
  // side of a triangle while crossing coarse DEM cells.
  const pixelX = fpsWidthMetres / Math.max(1, demWidth - 1);
  const pixelZ = fpsHeightMetres / Math.max(1, demHeight - 1);
  const radius = THREE.MathUtils.clamp(Math.max(pixelX, pixelZ) * 0.045, 0.35, 1.25);
  return Math.max(
    fpsGroundAt(x, z),
    fpsGroundAt(x + radius, z),
    fpsGroundAt(x - radius, z),
    fpsGroundAt(x, z + radius),
    fpsGroundAt(x, z - radius),
  );
}

function calculateFpsEyeClearance() {
  const pixelX = fpsWidthMetres / Math.max(1, demWidth - 1);
  const pixelZ = fpsHeightMetres / Math.max(1, demHeight - 1);
  // 1.75 m is the physical eye height. Coarser rasters get a safety offset so
  // an interpolated SRTM triangle cannot visually cut through the near plane.
  const rasterSafety = THREE.MathUtils.clamp(Math.max(pixelX, pixelZ) * 0.035, 0.25, 1.25);
  return 1.75 + rasterSafety;
}

function fpsWorldFromUv(uv) {
  return new THREE.Vector3(
    (uv.x - 0.5) * fpsWidthMetres,
    bilinearElevation(uv.x * (demWidth - 1), (1 - uv.y) * (demHeight - 1)) - demMin,
    (0.5 - uv.y) * fpsHeightMetres,
  );
}

async function loadDemGeoTiff(file) {
  setStatus('Membaca header DEM', `${file.name} · ${formatFileSize(file.size)} · file tetap berada di perangkat.`);
  await nextPaint();
  const meta = await readGeoTiff(file, 'height');
  setStatus('Menyiapkan DEM', `${meta.sourceWidth.toLocaleString('id-ID')} × ${meta.sourceHeight.toLocaleString('id-ID')} → grid kerja ${meta.width.toLocaleString('id-ID')} × ${meta.height.toLocaleString('id-ID')}`);
  await nextPaint();
  const rasters = await readRasterPreview(meta, [0], 'height', file.name);
  hydrologyWorker?.terminate();
  hydrologyWorker = null;
  hydrologyResult = null;
  floodRiskValues = null;
  streamMask = null;
  for (const key of ['flow', 'depression', 'risk']) {
    layerTextures[key]?.dispose();
    layerTextures[key] = null;
  }
  if (['flow', 'depression', 'risk'].includes(activeLayer)) activeLayer = 'elevation';
  document.querySelectorAll('.hydro-layer').forEach((button) => { button.disabled = true; });
  document.querySelector('#hydrologyStats').classList.add('hidden');
  document.querySelector('#floodClassStats').classList.add('hidden');
  document.querySelector('#exportWaterways').disabled = true;
  document.querySelector('#exportFlood').disabled = true;
  clearMeasurement();
  document.querySelector('#hydrologyBadge').textContent = 'Belum dihitung';
  demValues = rasters;
  demWidth = meta.width;
  demHeight = meta.height;
  const noDataInfo = inferBorderNoData(rasters, demWidth, demHeight, meta.noData);
  demNoData = noDataInfo.value;
  meta.noData = demNoData;
  meta.noDataSource = noDataInfo.source;
  demMeta = meta;
  demGroundMetrics = rasterGroundMetrics(demMeta, demWidth, demHeight);

  let min = Infinity;
  let max = -Infinity;
  for (const value of rasters) {
    if (!validElevation(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  demMin = min;
  demMax = max;
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('DEM tidak memiliki nilai elevasi yang valid.');

  material.displacementMap = null;
  material.displacementScale = 0;
  terrain.visible = true;
  base.visible = true;
  shapefileBackdrop.visible = false;
  shapefileGrid.visible = false;
  applyDemToGeometry();
  generateAnalysisLayers();
  buildFirstPersonTerrain();
  if (shapefileWgs84Collection) {
    const status = document.querySelector('#shapefileStatus');
    try {
      const alignedCollection = transformShapefileToDem(shapefileWgs84Collection);
      shapefileStandalone = false;
      const overlapCount = alignedCollection.features.filter((feature) => geometryOverlapsDem(feature.geometry)).length;
      if (!overlapCount) throw new Error('Layer Shapefile tidak beririsan dengan extent DEM baru. Periksa CRS atau lokasi datanya.');
      shapefileBounds = null;
      shapefileCollection = alignedCollection;
      shapefileVisible = true;
      renderShapefileLayer();
      refreshShapefileStats();
      document.querySelector('#toggleShapefile').disabled = false;
      document.querySelector('#toggleShapefile').textContent = 'Sembunyikan layer';
      status.textContent = `${shapefileCollection.features.length} feature otomatis diselaraskan ke ${demMeta.spatial.label} · ${overlapCount} beririsan dengan DEM`;
    } catch (error) {
      shapefileStandalone = true;
      shapefileCollection = shapefileWgs84Collection;
      shapefileBounds = featureCollectionBounds(shapefileWgs84Collection);
      shapefileVisible = false;
      renderShapefileLayer();
      shapefileGroup.visible = false;
      const toggle = document.querySelector('#toggleShapefile');
      toggle.disabled = true;
      toggle.textContent = 'Layer disembunyikan';
      status.textContent = `${error.message} Data Shapefile tetap tersimpan dan dapat diekspor sebagai WGS84.`;
    }
    status.classList.remove('hidden');
  }
  if (viewMode.startsWith('globe')) setViewMode(viewMode);
  renderRasterLoadInfo('height', meta, file);
  const crsStatus = document.querySelector('#crsStatus');
  crsStatus.textContent = meta.spatial.assumedMetric
    ? 'CRS tidak ditemukan. Pengukuran sementara mengasumsikan 1 unit koordinat = 1 meter; tetapkan CRS GeoTIFF sebelum dipakai untuk keputusan lapangan.'
    : `${meta.spatial.label} terdeteksi · koordinat ${meta.spatial.axisX}/${meta.spatial.axisY} · skala analisis memakai meter.`;
  crsStatus.classList.remove('hidden');
  const noDataStatus = document.querySelector('#noDataStatus');
  noDataStatus.textContent = demNoData === null
    ? 'NoData tidak terdeteksi. Periksa tepian raster sebelum memakai hasil Flood Risk.'
    : `NoData ${demNoData} dimask otomatis (${noDataInfo.source}); area di luar cakupan tidak ikut analisis.`;
  noDataStatus.classList.remove('hidden');
  setStatus(meta.large ? 'DEM besar berhasil dimuat' : 'GeoTIFF DEM berhasil dimuat', `${file.name} · ${meta.spatial.label} · grid kerja ${meta.width} × ${meta.height}px · elevasi ${Math.round(min)}–${Math.round(max)} m`);
  updateAlignmentStatus();
}

async function loadTextureGeoTiff(file) {
  setStatus('Membaca header texture', `${file.name} · ${formatFileSize(file.size)} · tidak menyalin seluruh TIFF ke RAM.`);
  await nextPaint();
  const meta = await readGeoTiff(file, 'surface');
  setStatus('Membangun texture preview', `${meta.sourceWidth.toLocaleString('id-ID')} × ${meta.sourceHeight.toLocaleString('id-ID')} → ${meta.width.toLocaleString('id-ID')} × ${meta.height.toLocaleString('id-ID')}`);
  await nextPaint();
  let textureData;
  try {
    textureData = await readTexturePreview(meta, file.name);
  } catch (error) {
    console.warn('Konversi photometric otomatis gagal; menggunakan band raster langsung.', error);
    const sampleSelection = meta.samples >= 3 ? [0, 1, 2] : [0];
    const raster = await readRasterPreview(meta, sampleSelection, 'surface', file.name);
    textureData = { raster, channels: sampleSelection.length };
  }
  const rgba = textureRasterToRgba(textureData.raster, meta.width * meta.height, textureData.channels, meta.noData);

  const imageData = new ImageData(rgba, meta.width, meta.height);
  const imageCanvas = document.createElement('canvas');
  imageCanvas.width = meta.width;
  imageCanvas.height = meta.height;
  imageCanvas.getContext('2d').putImageData(imageData, 0, 0);
  const texture = new THREE.CanvasTexture(imageCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.flipY = !document.querySelector('#flipTexture').checked;

  layerTextures.texture?.dispose();
  surfaceTexture = texture;
  layerTextures.texture = texture;
  if (activeLayer === 'texture') material.map = texture;
  if (fpsTerrain) {
    fpsTerrain.material.map = texture;
    fpsTerrain.material.needsUpdate = true;
  }
  if (!demValues) {
    // A colour orthomosaic contains appearance, not elevation. Keep it flat
    // until an aligned DEM/DTM is loaded instead of showing the demo relief.
    material.displacementMap = null;
    material.displacementScale = 0;
  }
  material.needsUpdate = true;
  textureMeta = meta;
  renderRasterLoadInfo('surface', meta, file);
  setStatus(meta.large ? 'Texture besar berhasil dimuat' : 'GeoTIFF texture berhasil dimuat', `${file.name} · preview ${meta.width} × ${meta.height}px dari sumber ${meta.sourceWidth} × ${meta.sourceHeight}px`);
  updateAlignmentStatus();
}

async function loadUploadedFile(file, type) {
  if (rasterLoading) {
    setStatus('Masih memuat raster', 'Tunggu proses yang sedang berjalan selesai sebelum memilih file lain.', true);
    return;
  }
  rasterLoading = true;
  const inputs = [document.querySelector('#autoTiffInput'), document.querySelector('#heightInput'), document.querySelector('#textureInput')];
  inputs.forEach((input) => { input.disabled = true; });
  try {
    if (isTiff(file)) {
      if (type === 'auto') {
        const detection = await detectGeoTiffRole(file);
        showAutoDetectResult(file, detection);
        if (detection.role === 'height') {
          await loadDemGeoTiff(file);
          selectLayer('hillshade');
        } else {
          await loadTextureGeoTiff(file);
        }
      } else if (type === 'height') await loadDemGeoTiff(file);
      else await loadTextureGeoTiff(file);
    } else {
      loadFileAsTexture(file, type);
    }
  } catch (error) {
    console.error(error);
    setStatus('GeoTIFF tidak dapat dibaca', `${error.message || 'Periksa format dan struktur band.'} Jika TIFF memakai kompresi khusus, ekspor ulang sebagai tiled GeoTIFF/COG.`, true);
    const failedInput = type === 'auto' ? '#autoTiffInput' : type === 'height' ? '#heightInput' : '#textureInput';
    document.querySelector(failedInput).value = '';
  } finally {
    rasterLoading = false;
    inputs.forEach((input) => { input.disabled = false; });
  }
}

function loadFileAsTexture(file, type) {
  const objectUrl = URL.createObjectURL(file);
  loader.load(objectUrl, (texture) => {
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    if (type === 'height') {
      if (heightUrl) URL.revokeObjectURL(heightUrl);
      heightUrl = objectUrl;
      texture.colorSpace = THREE.NoColorSpace;
      material.displacementMap?.dispose();
      heightTexture = texture;
      material.displacementMap = texture;
      setStatus('DEM berhasil dimuat', `${file.name} · ${texture.image.width} × ${texture.image.height}px`);
    } else {
      if (surfaceUrl) URL.revokeObjectURL(surfaceUrl);
      surfaceUrl = objectUrl;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = !document.querySelector('#flipTexture').checked;
      layerTextures.texture?.dispose();
      surfaceTexture = texture;
      layerTextures.texture = texture;
      if (activeLayer === 'texture') material.map = texture;
      if (fpsTerrain) {
        fpsTerrain.material.map = texture;
        fpsTerrain.material.needsUpdate = true;
      }
      setStatus('Texture berhasil dimuat', `${file.name} · ${texture.image.width} × ${texture.image.height}px`);
    }
    material.needsUpdate = true;
  }, undefined, () => {
    URL.revokeObjectURL(objectUrl);
    setStatus('File tidak dapat dibaca', 'Gunakan PNG, JPG, atau WebP.', true);
  });
}

function odmConfig() {
  return {
    endpoint: document.querySelector('#odmEndpoint').value.trim() || '/nodeodm',
    token: document.querySelector('#odmToken').value.trim(),
  };
}

function setOdmProgress(value, visible = true) {
  const track = document.querySelector('#odmProgress');
  track.classList.toggle('hidden', !visible);
  track.querySelector('span').style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function updateOdmDownloads(uuid) {
  const config = odmConfig();
  const assets = {
    '#downloadOrthophoto': 'orthophoto.tif',
    '#downloadDtm': 'dtm.tif',
    '#downloadDsm': 'dsm.tif',
    '#downloadAll': 'all.zip',
  };
  for (const [selector, asset] of Object.entries(assets)) {
    document.querySelector(selector).href = odmAssetUrl({ ...config, uuid, asset });
  }
  document.querySelector('#odmDownloads').classList.remove('hidden');
}

async function pollOdmTask() {
  if (!odmTaskUuid) return;
  try {
    const info = await getOdmTaskInfo({ ...odmConfig(), uuid: odmTaskUuid });
    const status = odmStatus(info);
    document.querySelector('#odmTaskStatus').textContent = `${status.name} · ${Math.round(status.progress)}%`;
    document.querySelector('#odmTaskMessage').textContent = status.failed
      ? (info.lastError || info.error || 'Proses gagal. Periksa log NodeODM.')
      : status.completed
        ? 'Orthophoto, DTM, dan DSM siap diunduh.'
        : (info.currentStage || info.stage || 'OpenDroneMap sedang memproses foto.');
    document.querySelector('#odmBadge').textContent = status.name;
    setOdmProgress(status.progress);

    if (status.completed) {
      updateOdmDownloads(odmTaskUuid);
      document.querySelector('#startOdmTask').disabled = false;
      document.querySelector('#startOdmTask').textContent = 'Buat orthomosaic baru';
      setStatus('Orthomosaic selesai', 'Unduh orthophoto dan DTM, lalu muat keduanya ke viewer untuk Flood Risk.');
      odmPollTimer = null;
      return;
    }
    if (status.failed) {
      document.querySelector('#startOdmTask').disabled = false;
      document.querySelector('#startOdmTask').textContent = 'Coba buat orthomosaic lagi';
      setStatus('Proses orthomosaic gagal', document.querySelector('#odmTaskMessage').textContent, true);
      odmPollTimer = null;
      return;
    }
    odmPollTimer = setTimeout(pollOdmTask, 5000);
  } catch (error) {
    document.querySelector('#odmTaskMessage').textContent = error.message;
    document.querySelector('#odmBadge').textContent = 'Connection error';
    document.querySelector('#startOdmTask').disabled = false;
    document.querySelector('#startOdmTask').textContent = 'Coba hubungkan lagi';
    setStatus('NodeODM tidak terhubung', 'Jalankan docker compose NodeODM lalu coba kembali.', true);
    odmPollTimer = null;
  }
}

async function startOdmProcessing() {
  const input = document.querySelector('#odmImages');
  const files = [...input.files];
  if (files.length < 2) {
    setStatus('Foto belum cukup', 'Pilih minimal dua foto overlap; survey nyata biasanya membutuhkan puluhan foto.', true);
    return;
  }

  const button = document.querySelector('#startOdmTask');
  button.disabled = true;
  button.textContent = 'Mengunggah foto…';
  document.querySelector('#odmDownloads').classList.add('hidden');
  document.querySelector('#odmTaskCard').classList.remove('hidden');
  document.querySelector('#odmTaskStatus').textContent = 'Uploading';
  document.querySelector('#odmTaskId').textContent = '—';
  document.querySelector('#odmTaskMessage').textContent = `${files.length} foto sedang dikirim ke NodeODM lokal.`;
  document.querySelector('#odmBadge').textContent = 'Uploading';
  setOdmProgress(4);
  setStatus('Mengirim foto ke NodeODM', `${files.length} foto · jangan tutup tab sampai task dibuat.`);

  try {
    const result = await createOdmTask({
      ...odmConfig(),
      files,
      name: document.querySelector('#odmProjectName').value.trim(),
      resolution: document.querySelector('#odmResolution').value,
    });
    odmTaskUuid = result.uuid || result.task?.uuid;
    if (!odmTaskUuid) throw new Error('NodeODM tidak mengembalikan task UUID.');
    document.querySelector('#odmTaskId').textContent = odmTaskUuid;
    document.querySelector('#odmTaskStatus').textContent = 'Queued';
    document.querySelector('#odmTaskMessage').textContent = 'Task dibuat. Menunggu worker OpenDroneMap.';
    button.textContent = 'Task sedang berjalan';
    clearTimeout(odmPollTimer);
    await pollOdmTask();
  } catch (error) {
    console.error(error);
    button.disabled = false;
    button.textContent = 'Coba buat orthomosaic lagi';
    document.querySelector('#odmBadge').textContent = 'Error';
    document.querySelector('#odmTaskStatus').textContent = 'Failed';
    document.querySelector('#odmTaskMessage').textContent = error.message;
    setStatus('NodeODM tidak dapat memulai task', error.message, true);
  }
}

function setStatus(title, text, error = false) {
  document.querySelector('#statusTitle').textContent = title;
  document.querySelector('#statusText').textContent = text;
  const dot = document.querySelector('#statusDot');
  dot.style.background = error ? '#fb7185' : '#6ee7b7';
  dot.style.boxShadow = `0 0 14px ${error ? '#fb7185' : '#6ee7b7'}`;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = null;
let profileLine = null;
let pointMarker = null;

function terrainHit(event) {
  if (viewMode.startsWith('globe')) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(terrain, false)[0] || null;
}

function screenPoint(worldPoint) {
  const projected = worldPoint.clone().project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * innerWidth,
    y: (-projected.y * 0.5 + 0.5) * innerHeight,
    visible: projected.z >= -1 && projected.z <= 1,
  };
}

function svgPath(points, close = false) {
  if (!points.length) return '';
  return `${points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}${close ? ' Z' : ''}`;
}

function measurementDisplayPoints() {
  const points = measurementPoints.slice();
  if (measurementMode && measurementPreview) points.push(measurementPreview);
  return points;
}

function updateMeasurementOverlay() {
  const overlay = document.querySelector('#measurementOverlay');
  overlay.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
  const points = measurementDisplayPoints();
  if (!points.length || firstPersonMode) {
    overlay.replaceChildren();
    return;
  }
  const screen = points.map((point) => screenPoint(point.mapPoint));
  const closed = points.length >= 3;
  const path = svgPath(screen, closed);
  const local = metricCoordinates(points);
  const labels = [];
  const edgeCount = closed ? points.length : Math.max(0, points.length - 1);
  for (let i = 0; i < edgeCount; i++) {
    const nextIndex = (i + 1) % points.length;
    const length = Math.hypot(local[nextIndex].x - local[i].x, local[nextIndex].y - local[i].y);
    labels.push(`<text class="measure-label" x="${((screen[i].x + screen[nextIndex].x) / 2).toFixed(1)}" y="${((screen[i].y + screen[nextIndex].y) / 2 - 9).toFixed(1)}">${formatDistance(length)}</text>`);
  }
  let areaLabel = '';
  if (closed) {
    const metrics = polygonMetrics(points);
    const center = screen.reduce((sum, point) => ({ x: sum.x + point.x / screen.length, y: sum.y + point.y / screen.length }), { x: 0, y: 0 });
    areaLabel = `<text class="measure-area-label" x="${center.x.toFixed(1)}" y="${center.y.toFixed(1)}">${formatArea(metrics.area)}</text>`;
    if (measurementMode) {
      document.querySelector('#measureAreaValue').textContent = formatArea(metrics.area);
      document.querySelector('#measurePerimeterValue').textContent = formatDistance(metrics.perimeter);
      document.querySelector('#measurementStats').classList.remove('hidden');
    }
  }
  overlay.innerHTML = `${closed ? `<path class="measure-fill" d="${path}"></path>` : ''}<path class="measure-line-shadow" d="${path}"></path><path class="measure-line${measurementMode && measurementPreview ? ' measure-preview' : ''}" d="${path}"></path>${screen.map((point) => `<circle class="measure-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"></circle>`).join('')}${labels.join('')}${areaLabel}`;
}

function addMeasurementPoint(hit) {
  const data = dataFromUv(hit.uv);
  if (!data) return;
  measurementFinished = false;
  measurementPoints.push({ uv: hit.uv.clone(), mapPoint: hit.point.clone().add(new THREE.Vector3(0, 2.5, 0)), data });
  document.querySelector('#measurementActions').classList.remove('hidden');
  document.querySelector('#measurementBadge').textContent = `${measurementPoints.length} titik`;
  if (measurementPoints.length >= 3) calculateMeasurementStats();
  updateMeasurementOverlay();
}

function finishMeasurement() {
  if (measurementPoints.length < 3) {
    setStatus('Area belum terbentuk', 'Tambahkan minimal tiga titik batas blok.', true);
    return;
  }
  measurementMode = false;
  measurementFinished = true;
  measurementPreview = null;
  calculateMeasurementStats();
  const button = document.querySelector('#measureArea');
  button.classList.remove('active');
  button.textContent = 'Ukur area baru';
  document.querySelector('#measurementBadge').textContent = 'Selesai';
  updateMeasurementOverlay();
  setStatus('Pengukuran blok selesai', `${formatArea(measurementSummary.area)} · perimeter ${formatDistance(measurementSummary.perimeter)}.`);
}

function clearMeasurement() {
  measurementMode = false;
  measurementFinished = false;
  measurementPoints = [];
  measurementPreview = null;
  measurementSummary = null;
  const overlay = document.querySelector('#measurementOverlay');
  overlay?.replaceChildren();
  document.querySelector('#measurementStats')?.classList.add('hidden');
  document.querySelector('#measurementActions')?.classList.add('hidden');
  const button = document.querySelector('#measureArea');
  if (button) {
    button.classList.remove('active');
    button.textContent = 'Ukur area';
  }
  const badge = document.querySelector('#measurementBadge');
  if (badge && demValues) badge.textContent = 'Siap';
}

function toggleMeasurement() {
  if (measurementMode) {
    finishMeasurement();
    return;
  }
  if (profileMode) {
    profileMode = false;
    profilePoints = [];
    controls.enabled = true;
    const profileButton = document.querySelector('#profileMode');
    profileButton.classList.remove('active');
    profileButton.textContent = 'Gambar elevation profile';
  }
  if (measurementFinished || measurementPoints.length) clearMeasurement();
  measurementMode = true;
  document.querySelector('#measureArea').classList.add('active');
  document.querySelector('#measureArea').textContent = 'Selesai ukur';
  document.querySelector('#measurementBadge').textContent = 'Tap titik batas';
  setStatus('Mode ukur area aktif', 'Tap minimal tiga titik. Garis dan luas diperbarui secara langsung.');
}

function exportMeasurementGeoJson() {
  if (!measurementSummary || measurementPoints.length < 3) return;
  const coordinates = measurementPoints.map(({ data }) => [data.coordinateX, data.coordinateY]);
  coordinates.push(coordinates[0]);
  const feature = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        area_ha: Number((measurementSummary.area / 10000).toFixed(4)),
        perimeter_m: Number(measurementSummary.perimeter.toFixed(2)),
        elevation_min_m: measurementSummary.elevationMin,
        elevation_max_m: measurementSummary.elevationMax,
        average_slope_deg: measurementSummary.averageSlope,
        slope_s1_s2_percent: measurementSummary.suitablePercent,
        high_flood_percent: measurementSummary.highFloodPercent,
      },
      geometry: { type: 'Polygon', coordinates: [coordinates] },
    }],
  };
  const crs = geoJsonCrs(demMeta.spatial);
  if (crs) feature.crs = crs;
  downloadText('plantation-block.geojson', JSON.stringify(feature), 'application/geo+json');
}

function updateCompass() {
  const dial = document.querySelector('#compassDial');
  if (!dial || firstPersonMode) return;
  if (viewMode === '2d' || viewMode.startsWith('globe')) {
    dial.style.transform = 'rotate(0deg)';
    return;
  }
  const center = controls.target.clone();
  const north = center.clone().add(new THREE.Vector3(0, 0, -20));
  const a = screenPoint(center);
  const b = screenPoint(north);
  const angle = Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI;
  dial.style.transform = `rotate(${angle.toFixed(2)}deg)`;
}

function dataFromUv(uv) {
  if (!demValues || !demMeta) return null;
  const x = Math.max(0, Math.min(demWidth - 1, Math.round(uv.x * (demWidth - 1))));
  const y = Math.max(0, Math.min(demHeight - 1, Math.round((1 - uv.y) * (demHeight - 1))));
  const elevation = getElevationAt(x, y);
  const slope = slopeValues ? slopeValues[y * demWidth + x] : 0;
  const [west, south, east, north] = demMeta.bbox;
  const coordinateX = west + ((x + 0.5) / Math.max(1, demWidth)) * (east - west);
  const coordinateY = north - ((y + 0.5) / Math.max(1, demHeight)) * (north - south);
  return {
    x, y, elevation, slope,
    coordinateX,
    coordinateY,
    lon: coordinateX,
    lat: coordinateY,
  };
}

function inspectHit(hit) {
  const data = dataFromUv(hit.uv);
  if (!data) return;
  const spatial = demMeta.spatial;
  document.querySelector('#inspectXLabel').textContent = spatial.axisX;
  document.querySelector('#inspectYLabel').textContent = spatial.axisY;
  document.querySelector('#inspectLon').textContent = data.coordinateX.toFixed(spatial.coordinateDecimals);
  document.querySelector('#inspectLat').textContent = data.coordinateY.toFixed(spatial.coordinateDecimals);
  document.querySelector('#inspectElevation').textContent = `${data.elevation.toFixed(1)} m`;
  document.querySelector('#inspectSlope').textContent = `${data.slope.toFixed(1)}°`;
  const [suitabilityLabel, suitabilityCode] = suitabilityForSlope(data.slope);
  document.querySelector('#inspectSuitability').textContent = `${suitabilityCode} · ${suitabilityLabel}`;
  if (hydrologyResult) {
    const pixel = data.y * demWidth + data.x;
    const upstreamHa = hydrologyResult.accumulation[pixel] * pixelAreaMetres / 10000;
    const depth = hydrologyResult.depth[pixel];
    const { risk, drivers: contributions } = floodRiskComponents(pixel, data.slope);
    const riskLabel = risk >= 0.8 ? 'Critical' : risk >= 0.65 ? 'High' : risk >= 0.4 ? 'Medium' : 'Low';
    document.querySelector('#inspectAccumulation').textContent = `${upstreamHa.toFixed(2)} ha`;
    document.querySelector('#inspectDepth').textContent = `${depth.toFixed(2)} m`;
    document.querySelector('#inspectRisk').textContent = `${riskLabel} (${Math.round(risk * 100)})`;
    const drivers = [
      ['upstream flow', contributions.flow],
      ['depression', contributions.depth],
      ['flat terrain', contributions.flat],
    ].sort((a, b) => b[1] - a[1]);
    document.querySelector('#inspectRiskDrivers').textContent = drivers.map(([name, score]) => `${name} ${Math.round(score * 100)}`).join(' · ');
  } else {
    document.querySelector('#inspectAccumulation').textContent = 'Run hydrology';
    document.querySelector('#inspectDepth').textContent = 'Run hydrology';
    document.querySelector('#inspectRisk').textContent = 'Run hydrology';
    document.querySelector('#inspectRiskDrivers').textContent = 'Run hydrology';
  }

  if (!pointMarker) {
    pointMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0x6ee7b7, depthTest: false })
    );
    pointMarker.renderOrder = 4;
    scene.add(pointMarker);
  }
  pointMarker.position.copy(hit.point).add(new THREE.Vector3(0, 2.3, 0));
}

function addProfilePoint(hit) {
  profilePoints.push({ uv: hit.uv.clone(), point: hit.point.clone() });
  if (profilePoints.length === 1) {
    setStatus('Titik awal profile dipilih', 'Klik titik kedua pada terrain.');
    return;
  }
  if (profilePoints.length > 2) profilePoints = profilePoints.slice(-2);
  drawProfileLine();
  calculateProfile();
  profilePoints = [];
}

function drawProfileLine() {
  if (profileLine) {
    scene.remove(profileLine);
    profileLine.geometry.dispose();
    profileLine.material.dispose();
  }
  const points = profilePoints.map((entry) => entry.point.clone().add(new THREE.Vector3(0, 2, 0)));
  profileLine = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.LineCurve3(points[0], points[1]), 1, 0.3, 7, false),
    new THREE.MeshBasicMaterial({ color: 0xfff176, depthTest: false, depthWrite: false })
  );
  profileLine.renderOrder = 5;
  scene.add(profileLine);
}

function calculateProfile() {
  if (profilePoints.length !== 2) return;
  const samples = 180;
  const start = dataFromUv(profilePoints[0].uv);
  const end = dataFromUv(profilePoints[1].uv);
  const values = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    values.push(getElevationAt(x, y));
  }
  const distance = coordinateDistanceMetres(
    { x: start.coordinateX, y: start.coordinateY },
    { x: end.coordinateX, y: end.coordinateY },
    demMeta.spatial,
  );
  drawProfileChart(values, distance);
  document.querySelector('#profilePanel').classList.remove('hidden');
  document.querySelector('#profileDistance').textContent = distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
  document.querySelector('#profileRange').textContent = `${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))} m`;
  setStatus('Elevation profile selesai', `${samples} sampel sepanjang ${distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`}.`);
}

function drawProfileChart(values, distance) {
  const chart = document.querySelector('#profileChart');
  const ratio = Math.min(devicePixelRatio, 2);
  const rect = chart.getBoundingClientRect();
  chart.width = Math.max(1, Math.round(rect.width * ratio));
  chart.height = Math.max(1, Math.round(rect.height * ratio));
  const ctx = chart.getContext('2d');
  ctx.scale(ratio, ratio);
  const width = rect.width;
  const height = rect.height;
  const padding = { left: 43, right: 12, top: 12, bottom: 24 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.fillStyle = '#718790';
  ctx.font = '9px DM Sans, sans-serif';
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (height - padding.top - padding.bottom) * i / 4;
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
    ctx.fillText(`${Math.round(max - range * i / 4)} m`, 2, y + 3);
  }

  const points = values.map((value, i) => ({
    x: padding.left + (width - padding.left - padding.right) * i / (values.length - 1),
    y: padding.top + (height - padding.top - padding.bottom) * (1 - (value - min) / range),
  }));
  const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, 'rgba(110,231,183,.45)');
  gradient.addColorStop(1, 'rgba(110,231,183,.02)');
  ctx.beginPath(); ctx.moveTo(points[0].x, height - padding.bottom);
  points.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points.at(-1).x, height - padding.bottom); ctx.closePath();
  ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.strokeStyle = '#6ee7b7'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#718790';
  ctx.fillText('0', padding.left - 2, height - 6);
  const distanceLabel = distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
  ctx.fillText(distanceLabel, width - padding.right - 42, height - 6);
}

function buildMiniMapBase() {
  if (!demValues) return;
  const canvas = document.querySelector('#miniMap');
  fpsMiniBase = document.createElement('canvas');
  fpsMiniBase.width = canvas.width;
  fpsMiniBase.height = canvas.height;
  const ctx = fpsMiniBase.getContext('2d');
  const image = ctx.createImageData(canvas.width, canvas.height);
  const range = Math.max(1, demMax - demMin);
  const streamCells = Number(document.querySelector('#streamThreshold').value) * 10000 / pixelAreaMetres;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const sourceX = Math.round(x / (canvas.width - 1) * (demWidth - 1));
      const sourceY = Math.round(y / (canvas.height - 1) * (demHeight - 1));
      const sourceIndex = sourceY * demWidth + sourceX;
      const target = (y * canvas.width + x) * 4;
      const normalized = (getElevationAt(sourceX, sourceY) - demMin) / range;
      const shade = Math.round(22 + normalized * 38);
      const stream = hydrologyResult && hydrologyResult.accumulation[sourceIndex] >= streamCells;
      image.data[target] = stream ? 30 : shade * 0.62;
      image.data[target + 1] = stream ? 116 : shade * 0.85;
      image.data[target + 2] = stream ? 174 : shade;
      image.data[target + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function drawMiniMap(now = 0) {
  if (!firstPersonMode || !fpsMiniBase || now - lastMiniMapDraw < 80) return;
  lastMiniMapDraw = now;
  const canvas = document.querySelector('#miniMap');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(fpsMiniBase, 0, 0);
  const uv = fpsUvFromPosition(camera.position.x, camera.position.z);
  const x = uv.x * canvas.width;
  const y = (1 - uv.y) * canvas.height;
  fpsControls.getDirection(fpsForward);
  const headingRadians = Math.atan2(fpsForward.x, -fpsForward.z);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(headingRadians);
  ctx.beginPath();
  ctx.moveTo(0, -20);
  ctx.lineTo(10, 8);
  ctx.lineTo(-10, 8);
  ctx.closePath();
  ctx.fillStyle = 'rgba(54,123,180,.28)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#073b6f';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#b7dcff';
  ctx.stroke();
  ctx.restore();
}

function showPoiPopup(event, hit) {
  const data = dataFromUv(hit.uv);
  if (!data) return;
  selectedPoi = { uv: hit.uv.clone(), mapPoint: hit.point.clone(), data };
  const popup = document.querySelector('#poiPopup');
  document.querySelector('#poiElevation').textContent = `${data.elevation.toFixed(1)} m elevation`;
  const decimals = demMeta.spatial.coordinateDecimals;
  document.querySelector('#poiDetails').textContent = `${data.slope.toFixed(1)}° slope · ${data.coordinateY.toFixed(decimals)}, ${data.coordinateX.toFixed(decimals)} · ${demMeta.spatial.label}`;
  popup.classList.remove('hidden');
  const width = 205;
  const left = Math.min(innerWidth - width - 12, Math.max(12, event.clientX + 14));
  const top = Math.min(innerHeight - 150, Math.max(80, event.clientY - 30));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tweenMapCameraToPoi(duration = 750) {
  return new Promise((resolve) => {
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    const target = selectedPoi.mapPoint.clone();
    const destination = target.clone().add(new THREE.Vector3(18, 24, 24));
    const started = performance.now();
    const tick = (now) => {
      const raw = Math.min(1, (now - started) / duration);
      const t = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
      camera.position.lerpVectors(startPosition, destination, t);
      controls.target.lerpVectors(startTarget, target, t);
      controls.update();
      if (raw < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function updateFpsDirection() {
  camera.rotation.order = 'YXZ';
  camera.rotation.y = fpsYaw;
  camera.rotation.x = fpsPitch;
  camera.rotation.z = 0;
}

async function enterFirstPerson() {
  if (!selectedPoi || !fpsTerrain || firstPersonMode) return;
  savedMapCamera = {
    position: camera.position.clone(),
    target: controls.target.clone(),
    up: camera.up.clone(),
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    viewMode,
  };
  document.querySelector('#poiPopup').classList.add('hidden');
  controls.enabled = false;
  await tweenMapCameraToPoi();
  const fade = document.querySelector('#sceneFade');
  fade.classList.add('active');
  await wait(340);

  firstPersonMode = true;
  document.body.classList.add('fps-active');
  document.querySelector('#firstPersonUi').classList.remove('hidden');
  terrain.visible = false;
  base.visible = false;
  if (pointMarker) pointMarker.visible = false;
  if (profileLine) profileLine.visible = false;
  fpsTerrain.visible = true;
  shapefileGroup.visible = false;
  fpsTerrain.material.map = surfaceTexture;
  fpsTerrain.material.needsUpdate = true;
  scene.fog = new THREE.FogExp2(0x9eb7be, 0.00008);
  const position = fpsWorldFromUv(selectedPoi.uv);
  camera.fov = 65;
  camera.near = 0.08;
  camera.far = Math.max(fpsWidthMetres, fpsHeightMetres) * 1.7;
  camera.up.set(0, 1, 0);
  fpsEyeClearance = calculateFpsEyeClearance();
  fpsFootGround = fpsGroundEnvelopeAt(position.x, position.z);
  camera.position.set(position.x, fpsFootGround + fpsEyeClearance, position.z);
  fpsYaw = 0;
  fpsPitch = -0.04;
  updateFpsDirection();
  fpsControls.enabled = true;
  camera.updateProjectionMatrix();
  movementKeys.clear();
  fpsVelocity.set(0, 0, 0);
  renderer.domElement.focus({ preventScroll: true });
  document.querySelector('#fpsStartPrompt').classList.remove('hidden');
  fade.classList.remove('active');
}

async function exitFirstPerson() {
  if (!firstPersonMode || !savedMapCamera) return;
  const fade = document.querySelector('#sceneFade');
  fade.classList.add('active');
  await wait(340);
  if (fpsControls.isLocked) fpsControls.unlock();
  fpsControls.enabled = false;
  firstPersonMode = false;
  movementKeys.clear();
  fpsVelocity.set(0, 0, 0);
  document.body.classList.remove('fps-active');
  document.querySelector('#firstPersonUi').classList.add('hidden');
  fpsTerrain.visible = false;
  shapefileGroup.visible = shapefileVisible && Boolean(shapefileCollection);
  fpsTerrain.material.map = layerTextures[activeLayer] || surfaceTexture;
  fpsTerrain.material.needsUpdate = true;
  terrain.visible = true;
  base.visible = true;
  if (pointMarker) pointMarker.visible = true;
  if (profileLine) profileLine.visible = true;
  viewMode = savedMapCamera.viewMode;
  camera.fov = savedMapCamera.fov;
  camera.near = savedMapCamera.near;
  camera.far = savedMapCamera.far;
  camera.up.copy(savedMapCamera.up);
  camera.position.copy(savedMapCamera.position);
  controls.target.copy(savedMapCamera.target);
  controls.enableRotate = viewMode !== '2d';
  controls.enabled = true;
  controls.update();
  camera.updateProjectionMatrix();
  scene.fog = viewMode === '2d' ? null : new THREE.FogExp2(0x071018, 0.0025);
  document.querySelector('#view2d').classList.toggle('active', viewMode === '2d');
  document.querySelector('#view3d').classList.toggle('active', viewMode === '3d');
  document.querySelector('#globeStandard').classList.toggle('active', viewMode === 'globe-standard');
  document.querySelector('#globe3d').classList.toggle('active', viewMode === 'globe-3d');
  fade.classList.remove('active');
}

function updateFirstPerson(delta, now) {
  if (!firstPersonMode) return;
  const speed = movementKeys.has('SHIFT') ? 9 : 4.5;
  let forwardAmount = 0;
  let rightAmount = 0;
  if (movementKeys.has('W')) forwardAmount += 1;
  if (movementKeys.has('S')) forwardAmount -= 1;
  if (movementKeys.has('D')) rightAmount += 1;
  if (movementKeys.has('A')) rightAmount -= 1;
  fpsControls.getDirection(fpsForward);
  fpsForward.y = 0;
  if (fpsForward.lengthSq() < 0.0001) fpsForward.set(0, 0, -1);
  else fpsForward.normalize();
  fpsRight.crossVectors(fpsForward, camera.up).normalize();

  fpsWishDirection.set(0, 0, 0)
    .addScaledVector(fpsForward, forwardAmount)
    .addScaledVector(fpsRight, rightAmount);
  if (fpsWishDirection.lengthSq() > 1) fpsWishDirection.normalize();
  fpsWishDirection.multiplyScalar(speed);

  // Acceleration and braking make key transitions predictable at any frame rate.
  const response = fpsWishDirection.lengthSq() ? 16 : 22;
  const blend = 1 - Math.exp(-response * delta);
  fpsVelocity.lerp(fpsWishDirection, blend);
  if (fpsVelocity.lengthSq() < 0.0004) fpsVelocity.set(0, 0, 0);

  if (fpsVelocity.lengthSq()) {
    const previousX = camera.position.x;
    const previousZ = camera.position.z;
    const nextX = previousX + fpsVelocity.x * delta;
    const nextZ = previousZ + fpsVelocity.z * delta;
    const margin = Math.min(2, Math.max(0.5, Math.min(fpsWidthMetres, fpsHeightMetres) * 0.002));
    const clampedX = THREE.MathUtils.clamp(nextX, -fpsWidthMetres / 2 + margin, fpsWidthMetres / 2 - margin);
    const clampedZ = THREE.MathUtils.clamp(nextZ, -fpsHeightMetres / 2 + margin, fpsHeightMetres / 2 - margin);
    const nextGround = fpsGroundEnvelopeAt(clampedX, clampedZ);
    const travelled = Math.max(0.001, Math.hypot(clampedX - previousX, clampedZ - previousZ));
    const maximumRise = 0.55 + travelled * Math.tan(THREE.MathUtils.degToRad(58));

    if (nextGround - fpsFootGround <= maximumRise) {
      camera.position.x = clampedX;
      camera.position.z = clampedZ;
      fpsFootGround = nextGround;
    } else {
      // Treat an abrupt DEM wall as collision instead of allowing the camera
      // to tunnel through it.
      fpsVelocity.multiplyScalar(0.15);
    }
  } else {
    fpsFootGround = fpsGroundEnvelopeAt(camera.position.x, camera.position.z);
  }

  const targetEyeHeight = fpsFootGround + fpsEyeClearance;
  const verticalResponse = targetEyeHeight > camera.position.y ? 28 : 12;
  camera.position.y = THREE.MathUtils.lerp(
    camera.position.y,
    targetEyeHeight,
    1 - Math.exp(-verticalResponse * delta),
  );

  const uv = fpsUvFromPosition(camera.position.x, camera.position.z);
  const data = dataFromUv(uv);
  fpsControls.getDirection(fpsForward);
  const heading = (THREE.MathUtils.radToDeg(Math.atan2(fpsForward.x, -fpsForward.z)) + 360) % 360;
  document.querySelector('#fpsElevation').textContent = `${data.elevation.toFixed(1)} m`;
  document.querySelector('#fpsSlope').textContent = `${data.slope.toFixed(1)}° slope`;
  document.querySelector('#fpsHeading').textContent = `${Math.round(heading).toString().padStart(3, '0')}°`;
  drawMiniMap(now);
}

document.querySelector('#heightInput').addEventListener('change', (e) => {
  if (e.target.files[0]) loadUploadedFile(e.target.files[0], 'height');
});
document.querySelector('#textureInput').addEventListener('change', (e) => {
  if (e.target.files[0]) loadUploadedFile(e.target.files[0], 'surface');
});
document.querySelector('#autoTiffInput').addEventListener('change', (e) => {
  if (e.target.files[0]) loadUploadedFile(e.target.files[0], 'auto');
});
document.querySelector('#odmImages').addEventListener('change', (event) => {
  const files = [...event.target.files];
  const size = files.reduce((sum, file) => sum + file.size, 0);
  document.querySelector('#odmFileSummary').textContent = files.length
    ? `${files.length} foto · ${formatFileSize(size)} total`
    : 'Belum ada foto dipilih.';
  document.querySelector('#startOdmTask').disabled = files.length < 2;
  document.querySelector('#startOdmTask').textContent = 'Buat orthomosaic';
});
document.querySelector('#startOdmTask').addEventListener('click', startOdmProcessing);

document.querySelector('#heightScale').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  if (demValues) {
    applyDemToGeometry();
    if (shapefileCollection) renderShapefileLayer();
    document.querySelector('#heightValue').value = value;
    return;
  }
  material.displacementScale = document.querySelector('#invertHeight').checked ? -value : value;
  material.displacementBias = document.querySelector('#invertHeight').checked ? value * .25 : -value * .25;
  document.querySelector('#heightValue').value = value;
});

document.querySelector('#brightness').addEventListener('input', (e) => {
  renderer.toneMappingExposure = Number(e.target.value);
  document.querySelector('#brightnessValue').value = Number(e.target.value).toFixed(2);
});

document.querySelector('#streamThreshold').addEventListener('input', (event) => {
  document.querySelector('#streamValue').value = `${Number(event.target.value).toFixed(1)} ha`;
  if (hydrologyResult) generateHydrologyLayers();
});

document.querySelector('#criticalDepth').addEventListener('input', (event) => {
  document.querySelector('#depthValue').value = `${Number(event.target.value).toFixed(2)} m`;
  if (hydrologyResult) generateHydrologyLayers();
});

for (const [inputId, outputId] of [
  ['riskFlowWeight', 'riskFlowValue'],
  ['riskDepthWeight', 'riskDepthValue'],
  ['riskFlatWeight', 'riskFlatValue'],
]) {
  document.querySelector(`#${inputId}`).addEventListener('input', (event) => {
    document.querySelector(`#${outputId}`).value = event.target.value;
    if (hydrologyResult) generateHydrologyLayers();
  });
}

document.querySelector('#runHydrology').addEventListener('click', runHydrologyAnalysis);
document.querySelector('#exportSuitability').addEventListener('click', exportSuitabilityCsv);
document.querySelector('#exportWaterways').addEventListener('click', exportWaterwaysGeoJson);
document.querySelector('#exportFlood').addEventListener('click', exportFloodCsv);

document.querySelector('#invertHeight').addEventListener('change', (e) => {
  if (demValues) {
    applyDemToGeometry();
    if (shapefileCollection) renderShapefileLayer();
    return;
  }
  const value = Number(document.querySelector('#heightScale').value);
  material.displacementScale = e.target.checked ? -value : value;
  material.displacementBias = e.target.checked ? value * .25 : -value * .25;
});

document.querySelector('#flipTexture').addEventListener('change', (e) => {
  surfaceTexture.flipY = !e.target.checked;
  surfaceTexture.needsUpdate = true;
});

document.querySelector('#wireframe').addEventListener('change', (e) => {
  material.wireframe = e.target.checked;
});

document.querySelector('#shapefileInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.disabled = true;
  document.querySelector('#shapefileBadge').textContent = 'Membaca…';
  try {
    await loadShapefileZip(file);
  } catch (error) {
    console.error(error);
    document.querySelector('#shapefileBadge').textContent = 'Error';
    const status = document.querySelector('#shapefileStatus');
    status.textContent = error.message || 'Shapefile tidak dapat dibaca.';
    status.classList.remove('hidden');
    setStatus('Import Shapefile gagal', status.textContent, true);
    event.target.value = '';
  } finally {
    event.target.disabled = false;
  }
});
document.querySelector('#toggleShapefile').addEventListener('click', (event) => {
  shapefileVisible = !shapefileVisible;
  shapefileGroup.visible = shapefileVisible && !firstPersonMode && !viewMode.startsWith('globe');
  globeFeatureGroup.visible = shapefileVisible && viewMode.startsWith('globe');
  event.currentTarget.textContent = shapefileVisible ? 'Sembunyikan layer' : 'Tampilkan layer';
});
document.querySelector('#clearShapefile').addEventListener('click', clearShapefileLayer);
document.querySelector('#exportShapefile').addEventListener('click', exportImportedShapefile);

document.querySelectorAll('.layer-button').forEach((button) => {
  button.addEventListener('click', () => selectLayer(button.dataset.layer));
});

function setViewMode(mode) {
  viewMode = mode;
  const globeMode = mode.startsWith('globe');
  document.querySelector('#view2d').classList.toggle('active', mode === '2d');
  document.querySelector('#view3d').classList.toggle('active', mode === '3d');
  document.querySelector('#globeStandard').classList.toggle('active', mode === 'globe-standard');
  document.querySelector('#globe3d').classList.toggle('active', mode === 'globe-3d');
  globeGroup.visible = globeMode;
  globeFeatureGroup.visible = globeMode && shapefileVisible;
  if (globeMode) renderGlobeShapefile(mode);
  terrain.visible = !globeMode && !shapefileStandalone;
  base.visible = !globeMode && !shapefileStandalone;
  shapefileBackdrop.visible = !globeMode && shapefileStandalone;
  shapefileGrid.visible = !globeMode && shapefileStandalone;
  shapefileGroup.visible = !globeMode && shapefileVisible && Boolean(shapefileCollection);
  scene.fog = mode === '3d' ? new THREE.FogExp2(0x071018, 0.0025) : null;
  resetCamera();
}

document.querySelector('#view2d').addEventListener('click', () => setViewMode('2d'));
document.querySelector('#view3d').addEventListener('click', () => setViewMode('3d'));
document.querySelector('#globeStandard').addEventListener('click', () => setViewMode('globe-standard'));
document.querySelector('#globe3d').addEventListener('click', () => setViewMode('globe-3d'));

document.querySelector('#profileMode').addEventListener('click', (event) => {
  if (measurementMode) clearMeasurement();
  profileMode = !profileMode;
  profilePoints = [];
  event.currentTarget.classList.toggle('active', profileMode);
  event.currentTarget.textContent = profileMode ? 'Klik dua titik di terrain' : 'Gambar elevation profile';
  controls.enabled = !profileMode;
  setStatus(profileMode ? 'Mode elevation profile aktif' : 'Mode profile selesai', profileMode ? 'Klik titik awal lalu titik akhir pada terrain.' : 'Navigasi kamera aktif kembali.');
});

document.querySelector('#closeProfile').addEventListener('click', () => {
  document.querySelector('#profilePanel').classList.add('hidden');
});

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (firstPersonMode) {
    if (event.pointerType === 'mouse' && !fpsControls.isLocked) {
      fpsControls.lock();
      return;
    }
    lookDragging = true;
    lastLookPointer = { x: event.clientX, y: event.clientY };
    renderer.domElement.setPointerCapture?.(event.pointerId);
    return;
  }
  pointerDown = { x: event.clientX, y: event.clientY };
});

renderer.domElement.addEventListener('pointerup', (event) => {
  if (firstPersonMode) {
    lookDragging = false;
    lastLookPointer = null;
    return;
  }
  if (!pointerDown || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
  const hit = terrainHit(event);
  if (!hit || !demValues) return;
  if (measurementMode) addMeasurementPoint(hit);
  else if (profileMode) addProfilePoint(hit);
  else {
    inspectHit(hit);
    showPoiPopup(event, hit);
  }
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (measurementMode && !firstPersonMode && demValues) {
    const hit = terrainHit(event);
    measurementPreview = hit ? { uv: hit.uv.clone(), mapPoint: hit.point.clone().add(new THREE.Vector3(0, 2.5, 0)), data: dataFromUv(hit.uv) } : null;
    updateMeasurementOverlay();
  }
  if (!firstPersonMode || fpsControls.isLocked || !lookDragging || !lastLookPointer) return;
  const dx = event.clientX - lastLookPointer.x;
  const dy = event.clientY - lastLookPointer.y;
  fpsYaw -= dx * 0.0032;
  fpsPitch = THREE.MathUtils.clamp(fpsPitch - dy * 0.0027, -Math.PI * 0.47, Math.PI * 0.47);
  updateFpsDirection();
  lastLookPointer = { x: event.clientX, y: event.clientY };
});

document.querySelector('#closePoi').addEventListener('click', () => {
  document.querySelector('#poiPopup').classList.add('hidden');
});
document.querySelector('#enterFirstPerson').addEventListener('click', enterFirstPerson);
document.querySelector('#exitFirstPerson').addEventListener('click', exitFirstPerson);
document.querySelector('#lockFirstPerson').addEventListener('click', () => {
  if (firstPersonMode && !fpsControls.isLocked) fpsControls.lock();
});
document.querySelector('#measureArea').addEventListener('click', toggleMeasurement);
document.querySelector('#clearMeasurement').addEventListener('click', clearMeasurement);
document.querySelector('#exportMeasurement').addEventListener('click', exportMeasurementGeoJson);

function movementKey(event) {
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.key === 'Shift') return 'SHIFT';
  const key = String(event.key || '').toUpperCase();
  if (['W', 'A', 'S', 'D'].includes(key)) return key;
  const codeKey = String(event.code || '').replace('Key', '').toUpperCase();
  return ['W', 'A', 'S', 'D'].includes(codeKey) ? codeKey : null;
}

fpsControls.addEventListener('lock', () => {
  document.querySelector('#fpsStartPrompt').classList.add('hidden');
  renderer.domElement.focus({ preventScroll: true });
});
fpsControls.addEventListener('unlock', () => {
  movementKeys.clear();
  fpsVelocity.set(0, 0, 0);
  if (firstPersonMode) document.querySelector('#fpsStartPrompt').classList.remove('hidden');
});

document.addEventListener('keydown', (event) => {
  if (!firstPersonMode) return;
  const key = movementKey(event);
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  movementKeys.add(key);
}, true);
document.addEventListener('keyup', (event) => {
  const key = movementKey(event);
  if (key) movementKeys.delete(key);
}, true);
window.addEventListener('blur', () => movementKeys.clear());

document.querySelector('#resetCamera').addEventListener('click', resetCamera);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop((now) => {
  const delta = Math.min(clock.getDelta(), 0.05);
  if (firstPersonMode) updateFirstPerson(delta, now);
  else controls.update();
  updateCompass();
  if (measurementPoints.length || measurementPreview) updateMeasurementOverlay();
  renderer.render(scene, camera);
});
