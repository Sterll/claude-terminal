import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function parseBytes(size: string): number {
  const m = size.match(/^(\d+)\s*(gb|mb|kb|b)?$/i);
  if (!m) return 100 * 1024 * 1024;
  const n = parseInt(m[1]);
  const u = (m[2] || 'b').toLowerCase();
  if (u === 'gb') return n * 1024 * 1024 * 1024;
  if (u === 'mb') return n * 1024 * 1024;
  if (u === 'kb') return n * 1024;
  return n;
}

export const config = {
  port: parseInt(process.env.PORT || '3800', 10),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3800'}`,

  cloudEnabled: process.env.CLOUD_ENABLED !== 'false',
  maxProjectsPerUser: parseInt(process.env.MAX_PROJECTS_PER_USER || '20', 10),
  maxSessions: parseInt(process.env.MAX_SESSIONS || '5', 10),

  claudeCredentialsPath: process.env.CLAUDE_CREDENTIALS_PATH || path.join(process.env.HOME || '~', '.claude', '.credentials.json'),

  maxUploadSize: process.env.MAX_UPLOAD_SIZE || '100mb',
  maxUploadBytes: parseBytes(process.env.MAX_UPLOAD_SIZE || '100mb'),
  sessionTimeoutHours: parseInt(process.env.SESSION_TIMEOUT_HOURS || '24', 10),

  adminToken: process.env.ADMIN_TOKEN || '',
  corsOrigins: process.env.CORS_ORIGINS || '*',
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '120', 10),

  dataDir: path.resolve(__dirname, '..', 'data'),
  usersDir: path.resolve(__dirname, '..', 'data', 'users'),

  maxDesktopsPerUser: 5,
  maxMobilesPerUser: 5,
};
