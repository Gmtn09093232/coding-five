import { test } from 'node:test';
import assert from 'node:assert/strict';
import { 
  generateSurfaceGrindingToolpath, 
  SyntecQ5Postprocessor 
} from './engineering-libs.js';

test('Toolpath generates valid raster coordinates', () => {
  const path = generateSurfaceGrindingToolpath({
    startX: 0, endX: 10, startY: 0, endY: 10, stepOver: 5, zDepth: -1
  });
  
  // Expect 4 cuts (0, 5, 10) + approach + retract + Z transitions
  assert.ok(path.length > 5);
  
  // Check first cut start
  assert.equal(path[1].position[0], 0);
  assert.equal(path[1].position[1], 0);
  assert.equal(path[1].position[2], -1);
});

test('Syntec Postprocessor generates real G-code', () => {
  const toolpath = [
    { position: [0, 0, 50], motion: 'rapid', feed: 2000 },
    { position: [0, 0, -1], motion: 'rapid', feed: 2000 },
    { position: [10, 10, -1], motion: 'feed', feed: 500 }
  ];
  
  const result = SyntecQ5Postprocessor.generate({
    toolpath,
    machineProfile: {},
    programNumber: 1001,
    partName: 'TEST-PART'
  });

  assert.ok(result.gcode);
  assert.ok(result.gcode.includes('O1001 (TEST-PART)'));
  assert.ok(result.gcode.includes('G0 X0.000 Y0.000 Z-1.000'));
  assert.ok(result.gcode.includes('G1 F500'));
  assert.ok(result.gcode.includes('X10.000 Y10.000 Z-1.000'));
  assert.ok(result.gcode.includes('M30'));
});

test('Syntec Postprocessor enforces limits', () => {
  const toolpath = [{ position: [999, 0, 0], motion: 'rapid' }];
  const machineProfile = {
    kinematics_json: {
      chain: [{ axis: 'X', travel_min: -100, travel_max: 100 }]
    }
  };
  
  const result = SyntecQ5Postprocessor.generate({ toolpath, machineProfile });
  assert.ok(result.errors.length > 0);
  assert.equal(result.gcode, null);
});
