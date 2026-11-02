import test from 'node:test';
import assert from 'node:assert/strict';
import { mapGeometryCoordinates, mergeFeatureCollections, validateShapefileEntries } from '../src/shapefile-utils.js';

test('menerima Shapefile ZIP dengan empat komponen wajib', () => {
  const result = validateShapefileEntries(['data/blok.SHP', 'data/blok.shx', 'data/blok.dbf', 'data/blok.prj']);
  assert.deepEqual(result.complete, ['blok']);
});

test('menolak Shapefile tanpa PRJ', () => {
  assert.throws(
    () => validateShapefileEntries(['blok.shp', 'blok.shx', 'blok.dbf']),
    /\.prj/,
  );
});

test('memetakan seluruh koordinat MultiPolygon', () => {
  const geometry = { type: 'MultiPolygon', coordinates: [[[[1, 2], [3, 4], [1, 2]]]] };
  const output = mapGeometryCoordinates(geometry, (x, y) => [x + 10, y - 5]);
  assert.deepEqual(output.coordinates[0][0][1], [13, -1]);
});

test('menggabungkan layer dan mempertahankan atribut DBF', () => {
  const output = mergeFeatureCollections([{ fileName: 'blocks', type: 'FeatureCollection', features: [{ type: 'Feature', properties: { BLOK: 'A01' }, geometry: null }] }]);
  assert.equal(output.features[0].properties.BLOK, 'A01');
  assert.equal(output.features[0].properties.source_layer, 'blocks');
});
