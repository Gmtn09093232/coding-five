# FANUC 5-Axis Grinding CAM System (Phase 1)

A web-based engineering CAM application designed to transform 3D models and engineering specifications into simulated, machine-specific FANUC 31i-B5 Plus grinding programs.

This repository contains the **compressed Phase 1 architecture**, organized into a minimal set of functional files.

## Project Structure

The application is intentionally compressed into a single-folder structure:

*   **`server-core.js`**: Express server bootstrap, environment validation, Supabase client, and security middleware.
*   **`server-api.js`**: REST API routes, CAD upload processing, and postprocessor skeleton.
*   **`engineering-libs.js`**: Shared pure-JS math, kinematics (FK/IK), units, and geometry logic used by both the frontend and backend.
*   **`index.html`**: The complete frontend bundle (HTML, CSS, and Three.js logic embedded).
*   **`database.sql`**: Supabase PostgreSQL schema, Row Level Security (RLS) policies, and seed templates.
*   **`tests.js`**: Automated Node.js unit tests for geometry and kinematics.

## Installation & Setup

### 1. Prerequisites
*   Node.js (v18 or higher)
*   A Supabase Project (for Auth, Database, and Storage)

### 2. Environment Variables
Copy `.env.example` to `.env` and fill in your Supabase credentials.
```bash
cp .env.example .env
