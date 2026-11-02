const REQUIRED_EXTENSIONS = ['.shp', '.shx', '.dbf', '.prj'];

export function validateShapefileEntries(entries) {
  const groups = new Map();
  for (const rawName of entries) {
    const name = String(rawName).replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    const fileName = name.split('/').at(-1);
    const dot = fileName.lastIndexOf('.');
    if (dot < 1) continue;
    const base = fileName.slice(0, dot).toLowerCase();
    const extension = fileName.slice(dot).toLowerCase();
    if (!REQUIRED_EXTENSIONS.includes(extension)) continue;
    if (!groups.has(base)) groups.set(base, new Set());
    groups.get(base).add(extension);
  }

  const complete = [];
  const incomplete = [];
  for (const [base, extensions] of groups) {
    const missing = REQUIRED_EXTENSIONS.filter((extension) => !extensions.has(extension));
    if (missing.length) incomplete.push({ base, missing });
    else complete.push(base);
  }
  if (!complete.length) {
    const details = incomplete.length
      ? incomplete.map(({ base, missing }) => `${base}: kurang ${missing.join(', ')}`).join('; ')
      : 'tidak ada komponen Shapefile yang dikenali';
    throw new Error(`ZIP Shapefile belum lengkap (${details}). Wajib memuat .shp, .shx, .dbf, dan .prj dengan nama dasar yang sama.`);
  }
  return { complete, incomplete };
}

export function listZipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const names = [];
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const start = offset + 46;
    const end = start + nameLength;
    if (end > bytes.length) break;
    names.push(new TextDecoder().decode(bytes.subarray(start, end)));
    offset = end + extraLength + commentLength - 1;
  }
  if (!names.length) throw new Error('ZIP tidak valid atau memakai struktur ZIP yang belum didukung. Buat ulang sebagai ZIP standar.');
  return names;
}

export function mergeFeatureCollections(value) {
  const collections = Array.isArray(value) ? value : [value];
  const features = [];
  for (const collection of collections) {
    if (!collection || collection.type !== 'FeatureCollection') continue;
    const sourceLayer = collection.fileName || collection.name || null;
    for (const feature of collection.features || []) {
      features.push({
        ...feature,
        properties: {
          ...(feature.properties || {}),
          ...(sourceLayer ? { source_layer: sourceLayer } : {}),
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export function mapGeometryCoordinates(geometry, transform) {
  if (!geometry) return null;
  const mapPoint = (coordinate) => {
    const [x, y] = transform(coordinate[0], coordinate[1]);
    return coordinate.length > 2 ? [x, y, ...coordinate.slice(2)] : [x, y];
  };
  const mapLine = (line) => line.map(mapPoint);
  const type = geometry.type;
  if (type === 'Point') return { ...geometry, coordinates: mapPoint(geometry.coordinates) };
  if (type === 'MultiPoint' || type === 'LineString') return { ...geometry, coordinates: mapLine(geometry.coordinates) };
  if (type === 'MultiLineString' || type === 'Polygon') return { ...geometry, coordinates: geometry.coordinates.map(mapLine) };
  if (type === 'MultiPolygon') return { ...geometry, coordinates: geometry.coordinates.map((polygon) => polygon.map(mapLine)) };
  if (type === 'GeometryCollection') return { ...geometry, geometries: geometry.geometries.map((item) => mapGeometryCoordinates(item, transform)) };
  throw new Error(`Geometry ${type} belum didukung.`);
}
