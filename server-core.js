import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CONFIG ENV ---
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  publicSupabaseUrl: process.env.VITE_SUPABASE_URL || required('SUPABASE_URL'),
  publicSupabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || '',
  maxCadFileBytes: Number(process.env.MAX_CAD_FILE_MB ?? 100) * 1024 * 1024,
};

// --- SUPABASE ---
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- AUTH MIDDLEWARE ---
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });
    req.user = data.user;
    req.supabase = supabaseAdmin;
    next();
  } catch (e) { next(e); }
}

// --- UPLOAD MIDDLEWARE ---
const ALLOWED = new Set(['step', 'stp', 'iges', 'igs', 'stl', 'obj']);
export function detectFormat(buffer, originalname) {
  const ext = originalname.split('.').pop().toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error(`Extension .${ext} not allowed`);
  if (ext === 'stl') {
    const head = buffer.subarray(0, 64).toString('utf8');
    if (/^solid\s/.test(head)) return 'stl';
    if (buffer.length >= 84 && buffer.readUInt32LE(80) > 0) return 'stl';
    throw new Error('STL file does not match ASCII or binary STL signature');
  }
  if (ext === 'step' || ext === 'stp') {
    if (!/^ISO-10303-21/.test(buffer.subarray(0, 64).toString('utf8')))
      throw new Error('STEP file missing ISO-10303-21 header');
    return 'step';
  }
  if (ext === 'obj') {
    if (!/^(v|vn|vt|f|mtllib|o|g|s)\s/m.test(buffer.subarray(0, 512).toString('utf8')))
      throw new Error('OBJ file contains no recognised records');
    return 'obj';
  }
  if (ext === 'iges' || ext === 'igs') {
    const head = buffer.subarray(0, 1024).toString('utf8');
    if (!/S\s*\d+/.test(head)) throw new Error('IGES file failed basic content validation');
    return 'iges';
  }
  throw new Error(`Unsupported format: ${ext}`);
}
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxCadFileBytes },
  fileFilter(req, file, cb) {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (!ALLOWED.has(ext)) return cb(new Error(`Extension .${ext} not allowed`));
    cb(null, true);
  },
});

// --- ERROR MIDDLEWARE ---
export function errorHandler(err, _req, res, _next) {
  const status = err.status ?? 500;
  const message = status >= 500 ? 'Internal server error' : err.message;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
}

// --- SERVER BOOTSTRAP ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.nodeEnv === 'production' ? process.env.FRONTEND_ORIGIN : true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));

// Serve the frontend bundle with injected environment variables
app.get('/', (_req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Inject Supabase config directly into the HTML
  const configScript = `
    <script>
      window.__SUPABASE_URL__ = "${env.publicSupabaseUrl}";
      window.__SUPABASE_ANON__ = "${env.publicSupabaseAnonKey}";
    </script>
  `;
  
  // Insert the script right before the closing </head> tag
  html = html.replace('</head>', `${configScript}</head>`);
  res.send(html);
});

app.get('/engineering-libs.js', (_req, res) => res.sendFile(path.join(__dirname, 'engineering-libs.js')));

// DYNAMIC IMPORT: Breaks the circular dependency with server-api.js
import('./server-api.js').then(({ default: apiRouter }) => {
  app.use('/api', apiRouter);
  app.use(errorHandler);
  
  app.listen(env.port, () => {
    console.log(`FANUC Grinding CAM listening on http://localhost:${env.port}`);
  });
}).catch(err => {
  console.error('Failed to load API routes:', err);
  process.exit(1);
});
