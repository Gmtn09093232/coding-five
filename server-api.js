import { Router } from 'express';
import { supabaseAdmin, requireAuth, upload, detectFormat } from './server-core.js';

// --- POSTPROCESSOR ---
export const POSTPROCESSOR_VERSION = '0.1.0-phase1';
export function generateHeader({ programNumber, partName, machineName, validated }) {
  return [
    '%',
    `O${String(programNumber).padStart(4, '0')} (${sanitise(partName ?? 'GRINDING')})`,
    `(FANUC 31i-B5 PLUS — POSTPROCESSOR v${POSTPROCESSOR_VERSION})`,
    `(MACHINE: ${sanitise(machineName ?? 'UNCONFIGURED')})`,
    `(VALIDATION: ${validated ? 'MACHINE VALIDATED' : 'NOT MACHINE VALIDATED'})`,
    '(ILLUSTRATIVE TEMPLATE — NOT MACHINE READY)',
    'G21 G90',
    '(VERIFY MACHINE CONFIGURATION)',
    '(VERIFY WORK OFFSET)',
    '(VERIFY GRINDING WHEEL DATA)',
  ].join('\n');
}
export function generateFooter() {
  return ['(VALIDATED MACHINE-SPECIFIC OPERATIONS GO HERE)', 'M30', '%'].join('\n');
}
export function generateProgram(ctx) {
  if (ctx.validated !== true) {
    return [
      generateHeader(ctx), '',
      '(BLOCKED: machine kinematics and postprocessor settings are not validated.)',
      '(No motion blocks will be emitted until validation passes.)', '',
      generateFooter(),
    ].join('\n');
  }
  throw new Error('Validated postprocessor output is a Phase 5 deliverable.');
}
function sanitise(s) { return String(s).replace(/[()\r\n]/g, ' ').slice(0, 48); }

// --- CAD SERVICE ---
export async function processCadUpload({ buffer, originalname, projectId, userId }) {
  const format = detectFormat(buffer, originalname);
  const isMeshOnly = format === 'stl' || format === 'obj';
  const storagePath = `${userId}/${projectId}/${Date.now()}-${sanitiseName(originalname)}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from('cad-models').upload(storagePath, buffer, { contentType: 'application/octet-stream', upsert: false });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  const metadata = {};
  let boundingBox = null;
  if (isMeshOnly) {
    boundingBox = approximateMeshBBox(buffer);
    metadata.note = 'Mesh format — analytic surfaces and tolerances are not preserved.';
  } else {
    metadata.note = 'CAD parsing is Phase 2 (OCCT WASM). File stored; analytic geometry extraction pending.';
  }

  const { data, error } = await supabaseAdmin.from('part_models').insert({
    project_id: projectId, file_name: originalname, storage_path: storagePath,
    file_format: format, file_size: buffer.length, is_mesh_only: isMeshOnly,
    bounding_box: boundingBox, units: 'mm', metadata,
  }).select().single();
  if (error) throw new Error(`DB insert failed: ${error.message}`);
  return data;
}
function sanitiseName(name) { return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }
function approximateMeshBBox(buffer) {
  const text = buffer.subarray(0, Math.min(buffer.length, 2_000_000)).toString('utf8');
  const nums = (text.match(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
  if (nums.length < 6) return null;
  const xs = [], ys = [], zs = [];
  for (let i = 0; i + 2 < nums.length; i += 3) { xs.push(nums[i]); ys.push(nums[i+1]); zs.push(nums[i+2]); }
  return { min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] };
}

// --- ROUTES ---
const r = Router();

// Auth
r.post('/auth/signup', async (req, res, next) => {
  try {
    const { email, password, fullName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(400).json({ error: error.message });
    await supabaseAdmin.from('profiles').insert({ id: data.user.id, email, full_name: fullName ?? '' });
    res.status(201).json({ id: data.user.id });
  } catch (e) { next(e); }
});
r.get('/auth/me', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('profiles').select('*').eq('id', req.user.id).single();
    if (error) return res.status(404).json({ error: 'Profile not found' });
    res.json(data);
  } catch (e) { next(e); }
});

// Projects
r.get('/projects', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('projects').select('*').order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { next(e); }
});
r.post('/projects', requireAuth, async (req, res, next) => {
  try {
    const { name, part_number, revision, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { data, error } = await req.supabase.from('projects')
      .insert({ owner_id: req.user.id, name, part_number, revision, description }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) { next(e); }
});
r.get('/projects/:id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('projects').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { next(e); }
});

// Models
r.post('/models', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const projectId = req.query.projectId ?? req.body.projectId;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const model = await processCadUpload({ buffer: req.file.buffer, originalname: req.file.originalname, projectId, userId: req.user.id });
    res.status(201).json(model);
  } catch (e) { next(e); }
});

// Specs
r.post('/specs', requireAuth, async (req, res, next) => {
  try {
    const { project_id } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const { data, error } = await req.supabase.from('engineering_specifications').insert(req.body).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) { next(e); }
});
r.get('/specs/:projectId', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('engineering_specifications').select('*').eq('project_id', req.params.projectId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { next(e); }
});

// Machines
r.get('/machines', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('machine_profiles').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { next(e); }
});
r.post('/machines', requireAuth, async (req, res, next) => {
  try {
    const { name, controller, builder, kinematics_json } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { data, error } = await req.supabase.from('machine_profiles').insert({
      owner_id: req.user.id, name, controller, builder, kinematics_json, is_validated: false,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Wheels
r.get('/wheels', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.from('grinding_wheels').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { next(e); }
});
r.post('/wheels', requireAuth, async (req, res, next) => {
  try {
    const body = req.body;
    if (!body.wheel_id || !body.diameter_mm || !body.width_mm) return res.status(400).json({ error: 'wheel_id, diameter_mm, width_mm required' });
    const { data, error } = await req.supabase.from('grinding_wheels').insert({ ...body, owner_id: req.user.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) { next(e); }
});

export default r;
