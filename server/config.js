import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  isProd: env.NODE_ENV === 'production',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  databaseUrl: env.DATABASE_URL || '',
  geminiApiKey: env.GEMINI_API_KEY || '',
  geminiModel: env.GEMINI_MODEL || 'gemini-flash-latest',
  geminiImageModel: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
  jwtSecret: env.JWT_SECRET || '',
  allowSignups: env.ALLOW_SIGNUPS !== 'false',
  vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
  vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  browserPath: env.CHROMIUM_PATH || '',
  maxAgentSteps: Number(env.MAX_AGENT_STEPS) || 16,
  // Lets the agent reach private/internal addresses. Leave off for public deployments.
  allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK === 'true',
};
