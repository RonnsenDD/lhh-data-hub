import { Buffer } from 'node:buffer';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
export const MAX_XML_BYTES = 2 * 1024 * 1024;
export const DEFAULT_RADIUS_KM = 220;
export const STALE_AFTER_MS = 15 * 60 * 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: true,
  allowBooleanAttributes: false
});

function text(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return text(value['#text']);
  return String(value).trim();
}

function number(value) {
  const raw = text(value);
  if (!raw || /^(?:not-a-date-time|null|nan|undefined)$/i.test(raw)) return undefined;
  const parsed = Number(raw);
  // KONRAD3D uses -1000000000 as a missing-value sentinel in this source file.
  if (!Number.isFinite(parsed) || parsed <= -1e8) return undefined;
  return parsed;
}

function timestamp(value) {
  const raw = text(value);
  if (!raw || /^(?:not-a-date-time|null)$/i.test(raw)) return undefined;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function coordinate(node) {
  const lat = number(node?.latitude);
  const lon = number(node?.longitude);
  if (lat === undefined || lon === undefined || lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  return { lat, lon };
}

function array(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function ellipse(node) {
  if (!node) return undefined;
  const majorKm = number(node.major_axis);
  const minorKm = number(node.minor_axis);
  const angleDeg = number(node.angle);
  if ([majorKm, minorKm, angleDeg].some(v => v === undefined) || majorKm <= 0 || minorKm <= 0 || majorKm > 1000 || minorKm > 1000) return undefined;
  return { majorKm, minorKm, angleDeg };
}

function polygons(node, warnings, id) {
  const raw = array(node?.geodetic_coordinates?.polygon);
  const output = [];
  for (const polygon of raw) {
    const lats = text(polygon?.latitudes)?.split(/\s+/).map(Number) ?? [];
    const lons = text(polygon?.longitudes)?.split(/\s+/).map(Number) ?? [];
    if (lats.length < 3 || lats.length !== lons.length || lats.length > 5000) {
      warnings.push(`Zelle ${id}: Polygon mit fehlenden oder ungleichen Koordinaten ausgelassen.`);
      continue;
    }
    const points = lats.map((lat, i) => ({ lat, lon: lons[i] }));
    if (points.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180)) {
      warnings.push(`Zelle ${id}: Polygon mit ungültigen Koordinaten ausgelassen.`);
      continue;
    }
    output.push(points);
  }
  return output;
}

export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function cellDistanceEnvelopeKm(cell, target) {
  const polygonPoints = cell.polygons.flat();
  const allPoints = [cell.centroid, ...polygonPoints, ...cell.forecasts.map(p => p.position)];
  const nearest = Math.min(...allPoints.map(p => haversineKm(p, target)));
  const forecastUncertainty = Math.max(0, ...cell.forecasts.map(p => p.uncertainty?.majorKm ?? 0));
  const polygonExtent = Math.max(0, ...polygonPoints.map(p => haversineKm(p, cell.centroid)));
  // Use the full reported axis as a conservative reach envelope; do not interpret it as a confidence probability.
  return Math.max(0, nearest - forecastUncertainty - polygonExtent);
}

function bearingDegrees(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function isRelevantToLocation(cell, target, radiusKm = DEFAULT_RADIUS_KM) {
  return cellDistanceEnvelopeKm(cell, target) <= radiusKm;
}

export function classifyDataStatus({ available, timestamp: dataTime, now = new Date(), relevantCount = 1, staleAfterMs = STALE_AFTER_MS }) {
  if (!available || !dataTime) return 'unavailable';
  const t = Date.parse(dataTime);
  if (!Number.isFinite(t)) return 'unavailable';
  const age = now.getTime() - t;
  if (age < -5 * 60 * 1000 || age > staleAfterMs) return 'stale';
  // A valid empty cell collection is still a successful current product. The
  // cell count describes the result; it must not be overloaded as source status.
  void relevantCount;
  return 'current';
}

export function parseKonrad3d(xmlInput, { target = { lat: 51.4693, lon: 13.76319 }, radiusKm = DEFAULT_RADIUS_KM, now = new Date(), maxBytes = MAX_XML_BYTES } = {}) {
  const xml = Buffer.isBuffer(xmlInput) ? xmlInput.toString('utf8') : String(xmlInput ?? '');
  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength === 0) throw new Error('KONRAD3D-XML ist leer.');
  if (byteLength > maxBytes) throw new Error(`KONRAD3D-XML überschreitet das Größenlimit von ${maxBytes} Bytes.`);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('DTD und XML-Entitäten sind aus Sicherheitsgründen nicht zulässig.');
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) throw new Error(`Ungültige XML-Struktur: ${validation.err?.msg ?? 'Parserfehler'}`);
  const root = parser.parse(xml)?.konrad3d;
  if (!root || typeof root !== 'object') throw new Error('KONRAD3D-Wurzelelement fehlt.');
  const cellsNode = root.cells;
  if (!cellsNode || typeof cellsNode !== 'object') throw new Error('KONRAD3D-Element <cells> fehlt.');
  const referenceTime = timestamp(cellsNode['@_reference_time'] ?? root.head?.metadata?.reference_time);
  if (!referenceTime) throw new Error('Gültige KONRAD3D-Referenzzeit fehlt.');
  const features = array(cellsNode.feature);
  const warnings = [];
  const cells = [];
  for (const feature of features) {
    const id = text(feature?.['@_identifier'] ?? feature?.metadata?.identifier);
    const centroid = coordinate(feature?.geometry?.centroid_3d?.geodetic_coordinate);
    if (!id || !centroid) {
      warnings.push('Eine Zelle ohne gültige Kennung oder Mittelpunkt wurde ausgelassen.');
      continue;
    }
    const forecasts = array(feature.forecast?.centroid_forecasts?.centroid_forecast).flatMap(item => {
      const position = coordinate(item?.geodetic_coordinate);
      const validAt = timestamp(item?.['@_forecast_time']);
      if (!position || !validAt) return [];
      return [{ validAt, position, uncertainty: ellipse(item?.uncertainty_ellipse) }];
    });
    const cell = {
      id,
      centroid,
      polygonCount: 0,
      polygons: polygons(feature.geometry?.polygons_projected, warnings, id),
      severity: number(feature.intensity?.severity_decimal),
      estimatedGustKmh: number(feature.intensity?.maximum_estimated_wind_gust),
      speedKmh: number(feature.tracking?.cell_speed),
      uncertainty: ellipse(feature.geometry?.centroid_3d?.uncertainty_ellipse),
      forecasts
    };
    cell.polygonCount = cell.polygons.length;
    const proximityPoints = [cell.centroid, ...cell.polygons.flat(), ...cell.forecasts.map(p => p.position)];
    cell.closestPointKm = Math.min(...proximityPoints.map(p => haversineKm(p, target)));
    cell.conservativeReachKm = cellDistanceEnvelopeKm(cell, target);
    const firstForecast = cell.forecasts[0]?.position;
    const lastForecast = cell.forecasts.at(-1)?.position;
    cell.derivedTrackBearingDeg = firstForecast && lastForecast ? bearingDegrees(firstForecast, lastForecast) : undefined;
    if (!forecasts.length) warnings.push(`Zelle ${id}: keine gültigen prognostizierten Positionen verfügbar.`);
    cells.push(cell);
  }
  const relevantCells = cells.filter(cell => isRelevantToLocation(cell, target, radiusKm));
  const creationTime = timestamp(root.head?.product?.['creation-date']);
  const cellResult = cells.length === 0 ? 'no-cells-detected' : relevantCells.length === 0 ? 'no-cells-in-area' : 'cells-detected';
  return {
    source: 'DWD KONRAD3D',
    fileModelVersion: text(root['@_data_model_version']),
    referenceTime,
    creationTime,
    processedAt: now.toISOString(),
    retrievalTime: null,
    totalCells: cells.length,
    cellResult,
    relevantCells,
    outOfAreaCount: cells.length - relevantCells.length,
    radiusKm,
    status: classifyDataStatus({ available: true, timestamp: referenceTime, now, relevantCount: relevantCells.length }),
    warnings,
    cells
  };
}
