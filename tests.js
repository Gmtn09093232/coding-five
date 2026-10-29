import { test } from 'node:test';
import assert from 'node:assert/strict';
import { 
  toMm, degToRad, radToDeg, 
  forward, inverse 
} from './engineering-libs.js';

// --- UNIT CONVERSION TESTS ---

test('inch to mm conversion', () => {
  assert.equal(toMm(1, 'in'), 25.4);
  assert.equal(toMm(2, 'in'), 50.8);
});

test('rejects unsupported units', () => {
  assert.throws(() => toMm(1, 'furlong'), /Unsupported length unit/);
});

test('angle conversion round-trip', () => {
  assert.ok(Math.abs(radToDeg(degToRad(90)) - 90) < 1e-12);
});

// --- KINEMATICS TESTS ---

const profile = {
  chain: [
    { type: 'linear', axis: 'X', pivot: [0,0,0], direction: [1,0,0] },
    { type: 'linear', axis: 'Y', pivot: [0,0,0], direction: [0,1,0] },
    { type: 'linear', axis: 'Z', pivot: [0,0,0], direction: [0,0,1] },
    { type: 'rotary', axis: 'C', pivot: [0,0,0], direction: [0,0,1] },
    { type: 'rotary', axis: 'A', pivot: [0,0,0], direction: [1,0,0] },
  ],
};

test('FK zero -> TCP at origin, tool +Z', () => {
  const { position, normal } = forward(profile, { X:0, Y:0, Z:0, C:0, A:0 });
  assert.deepEqual(position.map(v => Math.round(v * 1e9) / 1e9), [0, 0, 0]);
  assert.deepEqual(normal.map(v => Math.round(v * 1e9) / 1e9), [0, 0, 1]);
});

test('FK pure X translation', () => {
  const { position } = forward(profile, { X:10, Y:0, Z:0, C:0, A:0 });
  assert.equal(position[0], 10);
});

test('IK round-trip converges', () => {
  const target = forward(profile, { X:10, Y:5, Z:3, C:0.2, A:0.1 });
  const result = inverse(profile, target, { X:9, Y:4, Z:2, C:0.1, A:0.05 });
  assert.equal(result.converged, true);
  assert.ok(result.residual < 1e-3);
});

test('IK reports non-convergence for unreachable target', () => {
  const target = { position: [10000, 10000, 10000], normal: [0, 0, 1] };
  const result = inverse(profile, target, { X:0, Y:0, Z:0, C:0, A:0 }, { maxIterations: 5 });
  assert.equal(result.converged, false);
});
