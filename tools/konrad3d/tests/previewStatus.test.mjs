import test from 'node:test';
import assert from 'node:assert/strict';
import { statusFor } from '../scripts/previewStatus.mjs';

const now = new Date('2026-10-18T00:20:00Z');

test('status is current only inside the freshness window', () => {
  assert.equal(statusFor('2026-10-18T00:10:00Z', true, 1, now), 'current');
});

test('stale data remains explicitly stale even when no local cells were found', () => {
  assert.equal(statusFor('2026-10-17T19:35:00Z', true, 0, now), 'stale');
});

test('valid empty or out-of-area cell results keep source status current', () => {
  assert.equal(statusFor('2026-10-18T00:10:00Z', true, 0, now), 'current');
});

test('missing, malformed, and implausibly future timestamps are not presented as current', () => {
  assert.equal(statusFor(null, true, 1, now), 'unavailable');
  assert.equal(statusFor('not-a-date', true, 1, now), 'unavailable');
  assert.equal(statusFor('2026-10-18T01:00:00Z', true, 1, now), 'stale');
});
