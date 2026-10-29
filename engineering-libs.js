// --- UNITS ---
export const inchToMm = (v) => v * 25.4;
export const mmToInch = (v) => v / 25.4;
export const degToRad = (d) => d * (Math.PI / 180);
export const radToDeg = (r) => r * (180 / Math.PI);
export function toMm(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value: ${value}`);
  if (unit === 'mm') return n;
  if (unit === 'in') return inchToMm(n);
  throw new Error(`Unsupported length unit: ${unit}`);
}
export function assertPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

// --- MATRIX4 ---
export const identity = () => [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
export function translation(x, y, z) { const m = identity(); m[0][3]=x; m[1][3]=y; m[2][3]=z; return m; }
export function rotX(t) { const c=Math.cos(t),s=Math.sin(t); return [[1,0,0,0],[0,c,-s,0],[0,s,c,0],[0,0,0,1]]; }
export function rotY(t) { const c=Math.cos(t),s=Math.sin(t); return [[c,0,s,0],[0,1,0,0],[-s,0,c,0],[0,0,0,1]]; }
export function rotZ(t) { const c=Math.cos(t),s=Math.sin(t); return [[c,-s,0,0],[s,c,0,0],[0,0,1,0],[0,0,0,1]]; }
export function multiply(a, b) {
  const out = identity();
  for (let i=0;i<4;i++) for (let j=0;j<4;j++) { let s=0; for (let k=0;k<4;k++) s+=a[i][k]*b[k][j]; out[i][j]=s; }
  return out;
}
export const multiplyMany = (...mats) => mats.reduce((acc, m) => multiply(acc, m), identity());
export function applyToPoint(m, [x, y, z]) {
  const v = [x, y, z, 1], out = [0,0,0,0];
  for (let i=0;i<4;i++) for (let j=0;j<4;j++) out[i]+=m[i][j]*v[j];
  if (Math.abs(out[3])>1e-12 && out[3]!==1) return [out[0]/out[3],out[1]/out[3],out[2]/out[3]];
  return [out[0],out[1],out[2]];
}
export const rotationPart = (m) => m.slice(0,3).map(row=>row.slice(0,3));

// --- MACHINE MODEL ---
function axisMatrix(link, value) {
  const [px, py, pz] = link.pivot ?? [0,0,0], [dx, dy, dz] = link.direction ?? [0,0,1];
  if (link.type === 'linear') return translation(px+dx*value, py+dy*value, pz+dz*value);
  if (link.type === 'rotary') {
    let R = Math.abs(dx)>1-1e-9 ? rotX(value) : Math.abs(dy)>1-1e-9 ? rotY(value) : rotZ(value);
    return multiplyMany(translation(px,py,pz), R, translation(-px,-py,-pz));
  }
  throw new Error(`Unknown link type: ${link.type}`);
}
export function buildForwardChain(profile, jointValues) {
  const mats = [];
  for (const link of profile.chain) {
    const v = jointValues[link.axis];
    if (v === undefined) throw new Error(`Missing joint value for axis ${link.axis}`);
    mats.push(axisMatrix(link, v));
  }
  if (profile.workpiece?.transform) mats.push(profile.workpiece.transform);
  if (profile.tool?.transform) mats.push(profile.tool.transform);
  return multiplyMany(...mats);
}

// --- KINEMATICS FK ---
export function forward(profile, jointValues) {
  const T = buildForwardChain(profile, jointValues);
  const position = applyToPoint(T, [0, 0, 0]);
  const R = rotationPart(T);
  const normal = [R[0][2], R[1][2], R[2][2]];
  return { position, normal, matrix: T };
}

// --- KINEMATICS IK ---
export function inverse(profile, targetPose, seed, options = {}) {
  const { maxIterations = 200, tolerance = 1e-4, damping = 0.01 } = options;
  const axisOrder = profile.chain.map(l => l.axis);
  let q = { ...seed };
  for (let iter = 0; iter < maxIterations; iter++) {
    const current = forward(profile, q);
    const err = [
      targetPose.position[0]-current.position[0], targetPose.position[1]-current.position[1], targetPose.position[2]-current.position[2],
      targetPose.normal[0]-current.normal[0], targetPose.normal[1]-current.normal[1], targetPose.normal[2]-current.normal[2],
    ];
    const errMag = Math.hypot(...err);
    if (errMag < tolerance) return { jointValues: q, converged: true, iterations: iter, residual: errMag };
    const J = Array.from({ length: 6 }, () => []);
    const h = 1e-5;
    for (const axis of axisOrder) {
      const plus = forward(profile, { ...q, [axis]: q[axis] + h });
      const dPos = [(plus.position[0]-current.position[0])/h, (plus.position[1]-current.position[1])/h, (plus.position[2]-current.position[2])/h];
      const dNorm = [(plus.normal[0]-current.normal[0])/h, (plus.normal[1]-current.normal[1])/h, (plus.normal[2]-current.normal[2])/h];
      for (let r=0; r<3; r++) { J[r].push(dPos[r]); J[r+3].push(dNorm[r]); }
    }
    const JJt = Array.from({ length: 6 }, () => Array(6).fill(0));
    for (let i=0; i<6; i++) for (let j=0; j<6; j++) {
      let s=0; for (let k=0; k<axisOrder.length; k++) s+=J[i][k]*J[j][k];
      if (i===j) s+=damping*damping; JJt[i][j]=s;
    }
    const y = solveLinear(JJt, err);
    for (let k=0; k<axisOrder.length; k++) {
      let dq=0; for (let i=0; i<6; i++) dq+=J[i][k]*y[i];
      q[axisOrder[k]] += dq;
    }
  }
  const c = forward(profile, q);
  const residual = Math.hypot(targetPose.position[0]-c.position[0], targetPose.position[1]-c.position[1], targetPose.position[2]-c.position[2], targetPose.normal[0]-c.normal[0], targetPose.normal[1]-c.normal[1], targetPose.normal[2]-c.normal[2]);
  return { jointValues: q, converged: false, iterations: maxIterations, residual };
}
function solveLinear(A, b) {
  const n = A.length, M = A.map((row, i) => [...row, b[i]]);
  for (let col=0; col<n; col++) {
    let pivot=col;
    for (let r=col+1; r<n; r++) if (Math.abs(M[r][col])>Math.abs(M[pivot][col])) pivot=r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    if (Math.abs(div) < 1e-14) throw new Error('Singular Jacobian in IK solve');
    for (let c=col; c<=n; c++) M[col][c] /= div;
    for (let r=0; r<n; r++) { if (r===col) continue; const f=M[r][col]; for (let c=col; c<=n; c++) M[r][c] -= f*M[col][c]; }
  }
  return M.map(row => row[n]);
}

// --- WHEEL ---
export function wheelSurfaceSpeed({ diameterMm, rpm }) { return (Math.PI * diameterMm * rpm) / 60_000; }
export function maxRpmForSpeed({ diameterMm, maxSpeedMS }) { return (maxSpeedMS * 60_000) / (Math.PI * diameterMm); }
export function validateWheel(w) {
  const errors = [];
  if (!(w.diameter_mm > 0)) errors.push('diameter_mm must be > 0');
  if (!(w.width_mm > 0)) errors.push('width_mm must be > 0');
  if (w.max_surface_speed_m_s && w.max_rpm) {
    const derived = maxRpmForSpeed({ diameterMm: w.diameter_mm, maxSpeedMS: w.max_surface_speed_m_s });
    if (w.max_rpm > derived + 1) errors.push('max_rpm exceeds speed implied by max_surface_speed_m_s');
  }
  return { ok: errors.length === 0, errors };
}

// --- TOOLPATH ---
export function pathPoint({ position, normal, feed, motion, opId, clearance = false }) {
  return { position, normal, feed, motion, opId, clearance, rotarySolution: null };
}
export function generateSurfaceGrinding(_ctx) {
  throw new Error('Toolpath generation is a Phase 3 deliverable — this function is a documented stub.');
}
