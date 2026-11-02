import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpatialReference,
  coordinateDistanceMetres,
  rasterGroundMetrics,
  sameSpatialReference,
} from '../src/spatial-reference.js';

test('mendeteksi UTM 48S EPSG:32748 sebagai projected metre CRS', () => {
  const spatial = buildSpatialReference({
    geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32748, ProjLinearUnitsGeoKey: 9001 },
    bbox: [700000, 9300000, 701000, 9300800],
    georeferenced: true,
  });
  assert.equal(spatial.kind, 'projected');
  assert.equal(spatial.epsg, 32748);
  assert.equal(spatial.metersPerUnit, 1);
  assert.match(spatial.label, /UTM Zone 48S/);
  assert.equal(coordinateDistanceMetres({ x: 700000, y: 9300000 }, { x: 700300, y: 9300400 }, spatial), 500);
});

test('mengonversi extent geographic EPSG:4326 ke ukuran meter', () => {
  const spatial = buildSpatialReference({
    geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
    bbox: [106, -7, 107, -6],
    georeferenced: true,
  });
  const metrics = rasterGroundMetrics({ bbox: [106, -7, 107, -6], spatial }, 1001, 1001);
  assert.equal(spatial.kind, 'geographic');
  assert.ok(metrics.groundWidth > 110000 && metrics.groundWidth < 111500);
  assert.ok(metrics.groundHeight > 110000 && metrics.groundHeight < 111000);
});

test('memakai faktor US survey foot untuk projected CRS', () => {
  const spatial = buildSpatialReference({
    geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 2227, ProjLinearUnitsGeoKey: 9003 },
    bbox: [0, 0, 1000, 1000],
    georeferenced: true,
  });
  const metrics = rasterGroundMetrics({ bbox: [0, 0, 1000, 1000], spatial }, 101, 101);
  assert.ok(Math.abs(metrics.groundWidth - 304.8006096) < 0.001);
});

test('alignment menolak CRS berbeda', () => {
  const a = buildSpatialReference({ geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32748 }, bbox: [0, 0, 1, 1], georeferenced: true });
  const b = buildSpatialReference({ geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32749 }, bbox: [0, 0, 1, 1], georeferenced: true });
  assert.equal(sameSpatialReference(a, b), false);
});
