import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DWD_KONRAD_DIRECTORY, latestDwdXml, publishKonrad } from '../scripts/publish_pages.mjs';

const fixture = await readFile(new URL('../data/KONRAD3D_historical_cells_fixture.xml', import.meta.url));
const emptyXml = `<?xml version="1.0"?><konrad3d data_model_version="1.7"><head><metadata><reference_time>2026-10-27T19:55:00Z</reference_time></metadata><product><creation-date>2026-10-27T19:59:46Z</creation-date></product></head><cells reference_time="2026-10-27T19:55:00Z" ensemble_member_id="0"/></konrad3d>`;

async function site() { return mkdtemp(path.join(os.tmpdir(), 'konrad-pages-')); }

test('publishes historic cell geometry with an explicitly stale status and matching hashes', async () => {
  const root = await site();
  try {
    await mkdir(path.join(root, 'radar'), { recursive: true });
    await import('node:fs/promises').then(fs => fs.writeFile(path.join(root, 'radar/latest.json'), '{"product":"RADOLAN-RY"}'));
    const manifest = await publishKonrad({ siteDir: root, xml: fixture, retrievedAt: '2026-10-27T20:00:00.000Z', now: new Date('2026-10-27T20:00:00.000Z'), parserOptions: { target: { lat: 53.3175, lon: 6.60288 }, radiusKm: 80 } });
    const geojson = JSON.parse(await readFile(path.join(root, 'konrad3d/cells.geojson'), 'utf8'));
    const bytes = await readFile(path.join(root, 'konrad3d/cells.geojson'));
    assert.equal(manifest.status, 'stale');
    assert.equal(manifest.cellResult, 'cells-detected');
    assert.equal(manifest.totalCells, 3);
    assert.equal(manifest.relevantCellCount, 3);
    assert.ok(geojson.features.some(feature => feature.geometry.type === 'Polygon'));
    const point = geojson.features.find(feature => feature.geometry.type === 'Point');
    assert.deepEqual(point.geometry.coordinates, [6.60288, 53.3175]);
    assert.equal(manifest.cellsGeoJSONSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(JSON.parse(await readFile(path.join(root, 'radar/latest.json'), 'utf8')).product, 'RADOLAN-RY');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publishes an empty but fresh product as current with a successful empty-cell result', async () => {
  const root = await site();
  try {
    const manifest = await publishKonrad({ siteDir: root, xml: emptyXml, now: new Date('2026-10-27T20:00:00Z') });
    assert.equal(manifest.status, 'current');
    assert.equal(manifest.cellResult, 'no-cells-detected');
    assert.equal(manifest.totalCells, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'konrad3d/cells.geojson'), 'utf8')).features, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publishes an explicit unavailable result and empty GeoJSON for malformed XML', async () => {
  const root = await site();
  try {
    const manifest = await publishKonrad({ siteDir: root, xml: '<konrad3d><cells>', now: new Date('2026-10-27T20:00:00Z') });
    assert.equal(manifest.status, 'unavailable');
    assert.match(manifest.error, /Ungültige XML-Struktur/);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'konrad3d/cells.geojson'), 'utf8')).features, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selects the newest valid DWD XML link not later than the allowed clock skew', async () => {
  const seen = [];
  const fetchImpl = async input => {
    const url = String(input);
    seen.push(url);
    if (url === DWD_KONRAD_DIRECTORY) return { ok: true, text: async () => '<a href="KONRAD3D_20261027T195000.xml">a</a><a href="KONRAD3D_20261027T200000.xml">b</a><a href="KONRAD3D_20261027T210000.xml">future</a>' };
    return { ok: true, arrayBuffer: async () => new Uint8Array([60, 120, 62]).buffer };
  };
  const latest = await latestDwdXml({ fetchImpl, now: new Date('2026-10-27T20:00:00Z') });
  assert.equal(latest.url, `${DWD_KONRAD_DIRECTORY}KONRAD3D_20261027T200000.xml`);
  assert.equal(seen.length, 2);
  assert.ok(latest.xml instanceof Buffer);
});
