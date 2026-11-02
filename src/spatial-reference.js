const LINEAR_UNIT_METRES = new Map([
  [9001, 1],
  [9002, 0.3048],
  [9003, 1200 / 3937],
  [9005, 0.3047972654],
  [9036, 1000],
]);

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function utmName(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return `UTM Zone ${epsg - 32600}N`;
  if (epsg >= 32701 && epsg <= 32760) return `UTM Zone ${epsg - 32700}S`;
  return null;
}

export function buildSpatialReference({ geoKeys = {}, bbox, georeferenced }) {
  const modelType = numeric(geoKeys.GTModelTypeGeoKey);
  const projectedValue = numeric(geoKeys.ProjectedCSTypeGeoKey);
  const geographicValue = numeric(geoKeys.GeographicTypeGeoKey);
  const projectedCode = projectedValue === 32767 ? null : projectedValue;
  const geographicCode = geographicValue === 32767 ? null : geographicValue;
  const looksGeographic = georeferenced
    && bbox?.length === 4
    && bbox[0] >= -180 && bbox[2] <= 180
    && bbox[1] >= -90 && bbox[3] <= 90;
  const kind = modelType === 1 || projectedValue
    ? 'projected'
    : modelType === 2 || geographicValue || looksGeographic
      ? 'geographic'
      : 'unknown';
  const epsg = kind === 'projected' ? projectedCode : kind === 'geographic' ? geographicCode : null;
  const linearUnitCode = numeric(geoKeys.ProjLinearUnitsGeoKey);
  const metersPerUnit = kind === 'projected'
    ? (LINEAR_UNIT_METRES.get(linearUnitCode) ?? 1)
    : 1;
  const unitName = kind === 'geographic'
    ? 'degree'
    : linearUnitCode === 9002 ? 'foot'
      : linearUnitCode === 9003 ? 'US survey foot'
        : linearUnitCode === 9036 ? 'kilometre'
          : 'metre';
  const utm = epsg ? utmName(epsg) : null;
  const codeLabel = epsg ? `EPSG:${epsg}` : kind === 'projected' ? 'Projected CRS' : kind === 'geographic' ? 'Geographic CRS' : 'CRS tidak ditemukan';

  return {
    kind,
    epsg,
    modelType,
    linearUnitCode,
    metersPerUnit,
    unitName,
    label: utm ? `${codeLabel} · ${utm}` : codeLabel,
    axisX: kind === 'projected' ? 'Easting' : kind === 'geographic' ? 'Longitude' : 'X',
    axisY: kind === 'projected' ? 'Northing' : kind === 'geographic' ? 'Latitude' : 'Y',
    coordinateDecimals: kind === 'geographic' ? 6 : 2,
    assumedMetric: kind === 'unknown',
  };
}

export function rasterGroundMetrics(meta, width, height) {
  const [west, south, east, north] = meta.bbox;
  const spatial = meta.spatial;
  let groundWidth;
  let groundHeight;
  if (spatial.kind === 'geographic') {
    const midLatitude = (south + north) / 2 * Math.PI / 180;
    groundWidth = Math.abs(east - west) * 111320 * Math.max(0.01, Math.cos(midLatitude));
    groundHeight = Math.abs(north - south) * 110540;
  } else {
    groundWidth = Math.abs(east - west) * spatial.metersPerUnit;
    groundHeight = Math.abs(north - south) * spatial.metersPerUnit;
  }
  // GeoTIFF bounding boxes describe the outer raster extent, so cell size is
  // extent / cell count (not extent / interval count).
  const pixelWidth = Math.max(0.01, groundWidth / Math.max(1, width));
  const pixelHeight = Math.max(0.01, groundHeight / Math.max(1, height));
  return {
    groundWidth: Math.max(pixelWidth, groundWidth),
    groundHeight: Math.max(pixelHeight, groundHeight),
    pixelWidth,
    pixelHeight,
    pixelArea: pixelWidth * pixelHeight,
  };
}

export function coordinatesToLocalMetres(points, spatial) {
  if (!points.length) return [];
  const origin = points[0];
  if (spatial.kind === 'geographic') {
    const latitudeScale = 110540;
    const longitudeScale = 111320 * Math.max(0.01, Math.cos(origin.y * Math.PI / 180));
    return points.map((point) => ({
      x: (point.x - origin.x) * longitudeScale,
      y: (point.y - origin.y) * latitudeScale,
    }));
  }
  return points.map((point) => ({
    x: (point.x - origin.x) * spatial.metersPerUnit,
    y: (point.y - origin.y) * spatial.metersPerUnit,
  }));
}

export function coordinateDistanceMetres(a, b, spatial) {
  const local = coordinatesToLocalMetres([a, b], spatial);
  return Math.hypot(local[1].x, local[1].y);
}

export function sameSpatialReference(a, b) {
  if (!a || !b) return false;
  if (a.epsg && b.epsg) return a.epsg === b.epsg;
  return a.kind === b.kind && Math.abs(a.metersPerUnit - b.metersPerUnit) < 1e-10;
}

export function geoJsonCrs(spatial) {
  if (!spatial?.epsg || spatial.kind === 'geographic' && spatial.epsg === 4326) return null;
  return { type: 'name', properties: { name: `EPSG:${spatial.epsg}` } };
}
