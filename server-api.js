import { Router } from 'express';
import { supabaseAdmin, requireAuth, upload, detectFormat } from './server-core.js';
import { generateSurfaceGrindingToolpath, SyntecQ5Postprocessor } from './engineering-libs.js';

const r = Router();

// ==========================================
// --- CAD SERVICE ---
// ==========================================
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

function sanitiseName(name) { 
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); 
}

function approximateMeshBBox(buffer) {
  const text = buffer.subarray(0, Math.min(buffer.length, 2_000_000)).toString('utf8');
  const nums = (text.match(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
  if (nums.length < 6) return null;
  const xs = [], ys = [], zs = [];
  for (let i = 0; i + 2 < nums.length; i += 3) { 
    xs.push(nums[i]); ys.push(nums[i+1]); zs.push(nums[i+2]); 
  }
  return { 
    min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], 
    max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] 
  };
}

// ==========================================
// --- AUTH ROUTES ---
// ==========================================
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

// ==========================================
// --- PROJECT ROUTES ---
// ==========================================
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

// ==========================================
// --- MODEL ROUTES ---
// ==========================================
r.post('/models', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const projectId = req.query.projectId ?? req.body.projectId;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const model = await processCadUpload({ buffer: req.file.buffer, originalname: req.file.originalname, projectId, userId: req.user.id });
    res.status(201).json(model);
  } catch (e) { next(e); }
});

// ==========================================
// --- SPECIFICATION ROUTES ---
// ==========================================
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

// ==========================================
// --- MACHINE PROFILE ROUTES ---
// ==========================================
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

// ==========================================
// --- GRINDING WHEEL ROUTES ---
// ==========================================
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
    if (!body.wheel_id || !body.diameter_mm || !body.width_mm) {
      return res.status(400).json({ error: 'wheel_id, diameter_mm, width_mm required' });
    }
    const { data, error } = await req.supabase.from('grinding_wheels').insert({ ...body, owner_id: req.user.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// ==========================================
// --- G-CODE GENERATION ROUTE ---
// ==========================================
r.post('/gcode/generate', requireAuth, async (req, res, next) => {
  try {
    const { 
      project_id, machine_id, programNumber, partName, 
      startX, endX, startY, endY, stepOver, zDepth, feedRate 
    } = req.body;

    if (!project_id || !machine_id) {
      return res.status(400).json({ error: 'project_id and machine_id are required' });
    }

    // 1. Fetch Machine Profile to get limits and kinematics
    const { data: machine, error: mErr } = await supabaseAdmin
      .from('machine_profiles').select('*').eq('id', machine_id).single();
    if (mErr) return res.status(404).json({ error: 'Machine profile not found' });

    // 2. Generate raw toolpath (array of coordinates and motions)
    const toolpath = generateSurfaceGrindingToolpath({
      startX: Number(startX), endX: Number(endX), 
      startY: Number(startY), endY: Number(endY), 
      stepOver: Number(stepOver), zDepth: Number(zDepth), 
      feedRate: Number(feedRate || 500)
    });

    // 3. Run Postprocessor (translates coordinates to Syntec G-code)
    const { gcode, errors, warnings } = SyntecQ5Postprocessor.generate({
      toolpath,
      machineProfile: machine,
      programNumber: programNumber || 1001,
      partName: partName || 'Q5-TOOL'
    });

    // 4. Check for Validation errors (e.g., out of bounds)
    if (errors.length > 0) {
      return res.status(422).json({ error: 'Validation failed', details: errors });
    }

    // 5. Save generated program to Database
    const { data: savedProgram, error: dbErr } = await supabaseAdmin
      .from('cnc_programs')
      .insert({
        project_id,
        program_number: String(programNumber),
        gcode_text: gcode,
        postprocessor_version: '1.0.0-syntec-q5',
        validation_status: 'Postprocessor Checked'
      })
      .select().single();

    if (dbErr) throw new Error(dbErr.message);

    // 6. Return the G-code and the toolpath (for 3D simulation)
    res.json({ 
      program_id: savedProgram.id,
      gcode, 
      warnings,
      toolpath 
    });
  } catch (e) { next(e); }
});

export default r;
