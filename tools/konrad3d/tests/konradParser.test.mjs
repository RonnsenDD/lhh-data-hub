import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDataStatus, isRelevantToLocation, parseKonrad3d } from '../scripts/konradParser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.readFileSync(path.join(root, 'data/KONRAD3D_historical_cells_fixture.xml'));
const target = { lat: 51.4693, lon: 13.76319 };

test('parses local DWD fixture, timestamp, polygons, uncertainty, forecast and sentinel-safe values', () => {
  const parsed = parseKonrad3d(fixture, { now: new Date('2026-10-17T22:19:06Z') });
  assert.equal(parsed.source, 'DWD KONRAD3D');
  assert.equal(parsed.fileModelVersion, '1.7');
  assert.equal(parsed.referenceTime, '2026-10-17T19:35:00.000Z');
  assert.equal(parsed.totalCells, 3);
  assert.equal(parsed.relevantCells.length, 0);
  assert.equal(parsed.outOfAreaCount, 3);
  assert.equal(parsed.status, 'stale');
  const cell = parsed.cells.find(c => c.id === '14');
  assert.ok(cell.polygonCount > 0);
  assert.equal(cell.forecasts.length, 12);
  assert.ok(cell.uncertainty.majorKm > 0);
  assert.equal(cell.estimatedGustKmh, 43.83);
  assert.ok(cell.speedKmh > 0);
  assert.equal(cell.centroid.lat, 53.3175);
});

test('rejects DTD and external entity declarations before parsing', () => {
  assert.throws(() => parseKonrad3d('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><konrad3d/>'), /DTD und XML-Entitäten/);
});

test('rejects malformed XML and missing KONRAD3D structure', () => {
  assert.throws(() => parseKonrad3d('<konrad3d><cells></konrad3d>'), /Ungültige XML-Struktur/);
  assert.throws(() => parseKonrad3d('<other/>'), /Wurzelelement/);
});

test('enforces a byte limit before parsing', () => {
  assert.throws(() => parseKonrad3d('<konrad3d/>', { maxBytes: 4 }), /Größenlimit/);
});

test('rejects missing or malformed timestamps rather than reporting a clean empty result', () => {
  const xml = '<konrad3d><cells reference_time="not-a-date-time"/></konrad3d>';
  assert.throws(() => parseKonrad3d(xml), /Referenzzeit fehlt/);
});

test('ignores known numeric sentinel and exposes absent gust as undefined', () => {
  const xml = fixture.toString('utf8').replace(/(<maximum_estimated_wind_gust\b[^>]*>)[^<]+(<\/maximum_estimated_wind_gust>)/, '$1-1000000000$2');
  const parsed = parseKonrad3d(xml, { now: new Date('2026-10-17T22:19:06Z') });
  assert.equal(parsed.cells.find(c => c.id === '14').estimatedGustKmh, undefined);
});

test('geographic envelope includes an incoming cell when a forecast uncertainty reaches the radius', () => {
  const cell = { centroid: { lat: 54, lon: 13.76319 }, polygons: [], forecasts: [{ position: { lat: 53.55, lon: 13.76319 }, uncertainty: { majorKm: 18 } }] };
  assert.equal(isRelevantToLocation(cell, target, 220), true);
  assert.equal(isRelevantToLocation(cell, target, 100), false);
});

test('a valid polygon vertex and forecast positions are included in conservative proximity filtering', () => {
  const cell = { centroid: { lat: 54, lon: 14 }, polygons: [[{ lat: 51.5, lon: 13.8 }, { lat: 51.6, lon: 13.8 }, { lat: 51.55, lon: 13.9 }]], forecasts: [] };
  assert.equal(isRelevantToLocation(cell, target, 10), true);
});

test('data status distinguishes unavailable, stale, and current independently of the cell count', () => {
  const now = new Date('2026-10-17T22:19:06Z');
  assert.equal(classifyDataStatus({ available: false, timestamp: null, now }), 'unavailable');
  assert.equal(classifyDataStatus({ available: true, timestamp: '2026-10-17T19:35:00Z', now }), 'stale');
  assert.equal(classifyDataStatus({ available: true, timestamp: '2026-10-17T22:10:00Z', now, relevantCount: 1 }), 'current');
  assert.equal(classifyDataStatus({ available: true, timestamp: '2026-10-17T22:10:00Z', now, relevantCount: 0 }), 'current');
});

test('accepts a valid current DWD product with an empty cells element as success, not an error', () => {
  const xml = `<?xml version="1.0"?>
    <konrad3d data_model_name="KONRAD3D" data_model_version="1.7">
      <head><metadata><reference_time format="ISO 8601">2026-10-27T19:55:00Z</reference_time></metadata>
        <product><creation-date>2026-10-27T19:59:46Z</creation-date></product>
      </head>
      <cells reference_time="2026-10-27T19:55:00Z" ensemble_member_id="0" />
    </konrad3d>`;
  const parsed = parseKonrad3d(xml, { now: new Date('2026-10-27T20:00:00Z') });
  assert.equal(parsed.status, 'current');
  assert.equal(parsed.totalCells, 0);
  assert.equal(parsed.cellResult, 'no-cells-detected');
  assert.deepEqual(parsed.cells, []);
  assert.deepEqual(parsed.relevantCells, []);
});

test('valid products with cells outside the Lauchhammer area remain distinct from valid empty products', () => {
  const parsed = parseKonrad3d(fixture, { now: new Date('2026-10-17T19:40:00Z') });
  assert.equal(parsed.status, 'current');
  assert.equal(parsed.totalCells, 3);
  assert.equal(parsed.relevantCells.length, 0);
  assert.equal(parsed.cellResult, 'no-cells-in-area');
});

