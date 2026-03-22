import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export const config = {
  port: parseInt(process.env.PORT || '3800', 10),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3800'}`,

  cloudEnabled: process.env.CLOUD_ENABLED !== 'false',
  maxProjectsPerUser: parseInt(process.env.MAX_PROJECTS_PER_USER || '20', 10),
  maxSessions: parseInt(process.env.MAX_SESSIONS || '5', 10),

  claudeCredentialsPath: process.env.CLAUDE_CREDENTIALS_PATH || path.join(process.env.HOME || '~', '.claude', '.credentials.json'),

  maxUploadSize: process.env.MAX_UPLOAD_SIZE || '100mb',
  sessionTimeoutHours: parseInt(process.env.SESSION_TIMEOUT_HOURS || '24', 10),

  dataDir: path.resolve(__dirname, '..', 'data'),
  usersDir: path.resolve(__dirname, '..', 'data', 'users'),

  maxDesktopsPerUser: 5,
  maxMobilesPerUser: 5,
};
