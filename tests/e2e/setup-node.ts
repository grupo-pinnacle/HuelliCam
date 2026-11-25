import os from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.DATABASE_URL =
  'postgresql://postgres:postgrespassword@127.0.0.1:5432/huellicam_e2e?schema=public';
process.env.DIRECT_URL =
  'postgresql://postgres:postgrespassword@127.0.0.1:5432/huellicam_e2e?schema=public';
process.env.JWT_SECRET = 'e2e-jwt-secret-key-minimum-32-characters-long-deterministic';
process.env.JWT_REFRESH_SECRET =
  'e2e-jwt-refresh-secret-key-minimum-32-characters-deterministic';
process.env.REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET;
process.env.LIVEKIT_URL = 'wss://huellicam-e2e.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'secret';
process.env.STORAGE_DRIVER = 'local';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'huellicam-e2e-uploads');
process.env.AWS_BUCKET_NAME = 'huellicam-media';
process.env.DISCONNECT_DEBOUNCE_MS = '300';
process.env.ENABLE_EMAIL_SCHEDULER = 'false';

if (process.env.E2E_REDIS_URL) {
  process.env.REDIS_URL = process.env.E2E_REDIS_URL;
} else {
  // Set empty string so dotenv (override: false) in backend/src/config/env.ts does not load .env REDIS_URL
  process.env.REDIS_URL = '';
}
