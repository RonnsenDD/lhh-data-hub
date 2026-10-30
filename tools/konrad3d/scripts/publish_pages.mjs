import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseKonrad3d } from './konradParser.mjs';

export const DWD_KONRAD_DIRECTORY = 'https://opendata.dwd.de/weather/radar/konrad3d/';
export const KONRAD_STALE_AFTER_MS = 15 * 60_000;
const MAX_XML_BYTES = 2 * 1024 * 1024;

export function geoJsonFor(parsed) {
  const features = [];
  for (const cell of parsed.relevantCells || []) {
    const properties = {
      cellId: String(cell.id), severity: cell.severity ?? null,
      estimatedGustKmh: cell.estimatedGustKmh ?? null,
      speedKmh: cell.speedKmh ?? null,
      referenceTime: parsed.referenceTime, source: 'DWD KONRAD3D'
    };
    for (const polygon of cell.polygons || []) {
      if (!Array.isArray(polygon) || polygon.length < 3) continue;
      const ring = polygon.map(point => [point.lon, point.lat]);
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]]);
      features.push({ type: 'Feature', properties: { ...properties, kind: 'cell' }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    if (cell.centroid) features.push({ type: 'Feature', properties: { ...properties, kind: 'center' }, geometry: { type: 'Point', coordinates: [cell.centroid.lon, cell.centroid.lat] } });
    const forecastPositions = (cell.forecasts || []).filter(item => item.position);
    if (cell.centroid && forecastPositions.length) {
      features.push({ type: 'Feature', properties: { ...properties, kind: 'forecast' }, geometry: { type: 'LineString', coordinates: [[cell.centroid.lon, cell.centroid.lat], ...forecastPositions.map(item => [item.position.lon, item.position.lat])] } });
    }
  }
  return { type: 'FeatureCollection', properties: { product: 'DWD KONRAD3D', referenceTime: parsed.referenceTime, source: 'DWD' }, features };
}

export function buildManifest(parsed, geojson, { retrievedAt, publishedAt = new Date(), geoJsonSha256 } = {}) {
  const retrieval = new Date(retrievedAt || publishedAt);
  const publication = new Date(publishedAt);
  const refMs = Date.parse(parsed.referenceTime || '');
  if (!Number.isFinite(refMs) || !Number.isFinite(retrieval.getTime()) || !Number.isFinite(publication.getTime())) throw new TypeError('KONRAD3D-Zeitangabe fehlt oder ist ungültig.');
  const ageMs = publication.getTime() - refMs;
  const status = ageMs < -5 * 60_000 ? 'unavailable' : ageMs > KONRAD_STALE_AFTER_MS ? 'stale' : 'current';
  return {
    schemaVersion: 1, product: 'DWD KONRAD3D', status, fetchStatus: 'success',
    lastAttemptAt: retrieval.toISOString(),
    error: status === 'unavailable' ? 'Referenzzeit liegt unzulässig in der Zukunft.' : null,
    referenceTime: parsed.referenceTime, creationTime: parsed.creationTime || null,
    retrievedAt: retrieval.toISOString(), publishedAt: publication.toISOString(),
    ageMinutes: Math.max(0, Math.round(ageMs / 60_000)), staleAfterMinutes: KONRAD_STALE_AFTER_MS / 60_000,
    totalCells: parsed.totalCells, relevantCellCount: parsed.relevantCells.length,
    outOfAreaCount: parsed.outOfAreaCount, cellResult: parsed.cellResult,
    cellsGeoJSON: 'cells.geojson', cellsGeoJSONSha256: geoJsonSha256,
    source: 'DWD', sourceUrl: DWD_KONRAD_DIRECTORY,
    attribution: 'Datenquelle: Deutscher Wetterdienst (DWD), KONRAD3D.',
    warnings: parsed.warnings
  };
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function atomicJson(file, value) {
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export async function replaceSnapshot(target, geoBytes, manifest, writeManifest = atomicJson) {
  const geoPath = path.join(target, 'cells.geojson');
  const staged = `${geoPath}.${randomUUID()}.tmp`;
  const backup = `${geoPath}.${randomUUID()}.rollback`;
  await writeFile(staged, geoBytes);
  let hadPrevious = false;
  try {
    try {
      await rename(geoPath, backup);
      hadPrevious = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(staged, geoPath);
    await writeManifest(path.join(target, 'latest.json'), manifest);
  } catch (error) {
    try {
      await unlink(geoPath).catch(() => {});
      if (hadPrevious) await rename(backup, geoPath);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'KONRAD3D-Snapshot konnte nach einem Schreibfehler nicht zurückgerollt werden.');
    }
    throw error;
  } finally {
    await unlink(staged).catch(() => {});
  }
  if (hadPrevious) await unlink(backup);
}

export async function latestDwdXml({ fetchImpl = fetch, now = new Date() } = {}) {
  const directory = await fetchImpl(DWD_KONRAD_DIRECTORY, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/html' } });
  if (!directory.ok) throw new Error(`DWD-Verzeichnis HTTP ${directory.status}`);
  const html = await directory.text();
  const files = [...html.matchAll(/href=["'](KONRAD3D_(\d{8}T\d{6})\.xml)["']/g)]
    .map(match => ({ name: match[1], time: Date.parse(`${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}T${match[2].slice(9, 11)}:${match[2].slice(11, 13)}:${match[2].slice(13, 15)}Z`) }))
    .filter(item => Number.isFinite(item.time) && item.time <= now.getTime() + 5 * 60_000)
    .sort((a, b) => b.time - a.time);
  if (!files.length) throw new Error('Im DWD-Verzeichnis wurde keine gültige KONRAD3D-Datei gefunden.');
  const url = new URL(files[0].name, DWD_KONRAD_DIRECTORY);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/xml,text/xml' } });
  if (!response.ok) throw new Error(`KONRAD3D-Datei HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_XML_BYTES) throw new Error('KONRAD3D-Datei fehlt oder überschreitet 2 MiB.');
  return { xml: bytes, url: String(url), retrievedAt: new Date().toISOString() };
}

async function validPrevious(target) {
  try {
    const manifest = JSON.parse(await readFile(path.join(target, 'latest.json'), 'utf8'));
    const bytes = await readFile(path.join(target, 'cells.geojson'));
    if (manifest.schemaVersion !== 1 || manifest.product !== 'DWD KONRAD3D' || !['current', 'stale'].includes(manifest.status)) return null;
    if (manifest.cellsGeoJSON !== 'cells.geojson' || !manifest.referenceTime || digest(bytes) !== manifest.cellsGeoJSONSha256) return null;
    const collection = JSON.parse(bytes.toString('utf8'));
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) return null;
    if (collection.properties?.referenceTime && collection.properties.referenceTime !== manifest.referenceTime) return null;
    const refMs = Date.parse(manifest.referenceTime);
    if (!Number.isFinite(refMs)) return null;
    return { manifest, bytes, collection, refMs };
  } catch {
    return null;
  }
}

async function publishFailure({ target, message, sourceUrl, now }) {
  const safeMessage = String(message).replace(/\s+/g, ' ').slice(0, 300);
  const previous = await validPrevious(target);
  if (previous) {
    const ageMs = now.getTime() - previous.refMs;
    const status = ageMs < -5 * 60_000 ? 'unavailable' : ageMs > KONRAD_STALE_AFTER_MS ? 'stale' : 'current';
    if (status !== 'unavailable') {
      const manifest = {
        ...previous.manifest,
        status,
        error: safeMessage,
        fetchStatus: 'error',
        fetchStatusReason: 'Letzter Abruf oder Validierung fehlgeschlagen; zuletzt checksum-validiertes GeoJSON bleibt erhalten. Referenzzeit bleibt unverändert.',
        lastAttemptAt: now.toISOString(),
        publishedAt: now.toISOString(),
        ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
        staleAfterMinutes: KONRAD_STALE_AFTER_MS / 60_000,
        sourceUrl
      };
      await atomicJson(path.join(target, 'latest.json'), manifest);
      return manifest;
    }
  }

  const geojson = { type: 'FeatureCollection', properties: { product: 'DWD KONRAD3D', source: 'DWD' }, features: [] };
  const geoBytes = Buffer.from(JSON.stringify(geojson) + '\n');
  await writeFile(path.join(target, 'cells.geojson.tmp'), geoBytes);
  await rename(path.join(target, 'cells.geojson.tmp'), path.join(target, 'cells.geojson'));
  const manifest = {
    schemaVersion: 1, product: 'DWD KONRAD3D', status: 'unavailable', error: safeMessage,
    fetchStatus: 'error', fetchStatusReason: 'Kein checksum-validierter letzter Datensatz verfügbar.',
    referenceTime: null, creationTime: null, retrievedAt: now.toISOString(), publishedAt: now.toISOString(), lastAttemptAt: now.toISOString(),
    ageMinutes: null, staleAfterMinutes: 15, totalCells: null, relevantCellCount: null,
    outOfAreaCount: null, cellResult: null, cellsGeoJSON: 'cells.geojson',
    cellsGeoJSONSha256: digest(geoBytes), source: 'DWD', sourceUrl,
    attribution: 'Datenquelle: Deutscher Wetterdienst (DWD), KONRAD3D.'
  };
  await atomicJson(path.join(target, 'latest.json'), manifest);
  return manifest;
}

export async function publishKonrad({ siteDir, xml, sourceUrl = DWD_KONRAD_DIRECTORY, retrievedAt = new Date().toISOString(), now = new Date(), sourceError, parserOptions = {} }) {
  const target = path.join(siteDir, 'konrad3d');
  await mkdir(target, { recursive: true });
  try {
    const parsed = parseKonrad3d(xml, { now, ...parserOptions });
    const geojson = geoJsonFor(parsed);
    const geoBytes = Buffer.from(JSON.stringify(geojson) + '\n');
    const manifest = buildManifest(parsed, geojson, { retrievedAt, publishedAt: now, geoJsonSha256: digest(geoBytes) });
    manifest.sourceUrl = sourceUrl;
    if (manifest.status === 'unavailable') {
      return await publishFailure({ target, message: manifest.error || 'KONRAD3D-Zeitvalidierung fehlgeschlagen.', sourceUrl, now });
    }
    const previous = await validPrevious(target);
    if (previous && Date.parse(manifest.referenceTime) < previous.refMs) {
      return await publishFailure({
        target,
        message: 'Ausgewähltes KONRAD3D-Produkt ist älter als der letzte veröffentlichte gültige Datensatz.',
        sourceUrl,
        now
      });
    }
    await replaceSnapshot(target, geoBytes, manifest);
    return manifest;
  } catch (error) {
    const message = sourceError
      ? 'FetchError: ' + String(sourceError).replace(/\s+/g, ' ').slice(0, 250)
      : (error instanceof Error ? error.name : 'Error') + ': ' + String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 270);
    return publishFailure({ target, message, sourceUrl, now });
  }
}

export async function publishLatest({ siteDir, fetchImpl = fetch, now = new Date() }) {
  const attempt = now.toISOString();
  try {
    const latest = await latestDwdXml({ fetchImpl, now });
    return await publishKonrad({ siteDir, ...latest, now });
  } catch (error) {
    return publishKonrad({ siteDir, xml: '', sourceUrl: DWD_KONRAD_DIRECTORY, retrievedAt: attempt, now, sourceError: error });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const siteDir = option('--site-dir');
  const xmlFile = option('--xml-file');
  if (!siteDir) throw new Error('--site-dir ist erforderlich');
  const now = new Date();
  const manifest = xmlFile
    ? await publishKonrad({ siteDir, xml: await readFile(xmlFile), sourceUrl: `fixture:${path.basename(xmlFile)}`, now })
    : await publishLatest({ siteDir, now });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  if (manifest.status === 'unavailable' || manifest.fetchStatus === 'error') process.exitCode = 1;
}
