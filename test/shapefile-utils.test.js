import test from 'node:test';
import assert from 'node:assert/strict';
import {
  featureCollectionToBoundaryLines,
  mapGeometryCoordinates,
  mergeFeatureCollections,
  validateShapefileEntries,
} from '../src/shapefile-utils.js';

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

test('mengubah jalan dan ring polygon menjadi LineString untuk overlay globe', () => {
  const output = featureCollectionToBoundaryLines({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { id: 'jalan' }, geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] } },
      { type: 'Feature', properties: { id: 'blok' }, geometry: { type: 'Polygon', coordinates: [[[10, 11], [12, 13], [10, 11]]] } },
    ],
  });
  assert.equal(output.features.length, 3);
  assert.ok(output.features.every((feature) => feature.geometry.type === 'LineString'));
  assert.equal(output.features[0].properties.id, 'jalan');
});
