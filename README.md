# FANUC 5-Axis Grinding CAM (Phase 1)

Single-folder web app: Node/Express backend + Three.js frontend + Supabase.
Compressed into 7 core files for easy management.

## File Structure
1. `server-core.js` — Express app, environment variables, security middleware, and Supabase client.
2. `server-api.js` — All API routes, CAD upload pipeline, and G-code postprocessor skeleton.
3. `engineering-libs.js` — Shared math, kinematics, and geometry logic (used by both server and browser).
4. `index.html` — The complete frontend bundle (HTML, CSS, and ES6 JavaScript).
5. `database.sql` — Full PostgreSQL schema and seed data for Supabase.
6. `test-suite.js` — Automated unit tests for units and kinematics.
7. `package.json` — Node dependencies and scripts.

## Setup Instructions

1. Install dependencies:
   ```bash
   npm install
