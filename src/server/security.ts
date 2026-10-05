import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let resolvedKey: Buffer | null = null;

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), '.data');

if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.error(`Error creating security dataDir at ${dataDir}:`, err);
  }
}

function getMasterKey(): Buffer {
  if (resolvedKey) {
    return resolvedKey;
  }

  const envKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (envKey && envKey.trim().length > 0) {
    // Derive a fixed 32-byte key using sha256
    resolvedKey = crypto.createHash('sha256').update(envKey.trim()).digest();
    return resolvedKey;
  }

  const keyFilePath = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyFilePath)) {
    try {
      const raw = fs.readFileSync(keyFilePath, 'utf8').trim();
      resolvedKey = Buffer.from(raw, 'hex');
      if (resolvedKey.length === KEY_LENGTH) {
        return resolvedKey;
      }
    } catch {
      // regenerate if corrupt
    }
  }

  // If in production and database already has credentials, fail with clear error
  const dbPath = path.join(dataDir, 'database.json');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(dbPath)) {
    try {
      const dbRaw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(dbRaw);
      if (parsed.credentials && Object.keys(parsed.credentials).length > 0) {
        throw new Error('FATAL: CREDENTIAL_ENCRYPTION_KEY must be provided in production to access existing encrypted Binance credentials.');
      }
    } catch (e: any) {
      if (e.message.startsWith('FATAL:')) {
        throw e;
      }
    }
  }

  // Generate new random 32-byte key and persist
  resolvedKey = crypto.randomBytes(KEY_LENGTH);
  try {
    fs.writeFileSync(keyFilePath, resolvedKey.toString('hex'), { mode: 0o600 });
  } catch (err) {
    // If filesystem write fails, key remains in memory
  }

  return resolvedKey;
}

// -------------------------------------------------------------
// Admin Token Authentication & Session Token Handling
// -------------------------------------------------------------
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

export function createAdminSessionToken(): string {
  const payload = {
    role: 'admin',
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

export function verifyAdminSessionToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [data, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    // Expire session after 7 days
    if (Date.now() - payload.issuedAt > 7 * 24 * 60 * 60 * 1000) {
      return false;
    }
    return payload.role === 'admin';
  } catch {
    return false;
  }
}

export function getConfiguredAdminTokens(): string[] {
  const tokens: string[] = [];
  if (process.env.ADMIN_ACCESS_TOKEN && process.env.ADMIN_ACCESS_TOKEN.trim().length > 0) {
    tokens.push(process.env.ADMIN_ACCESS_TOKEN.trim());
  }
  if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.trim().length > 0) {
    tokens.push(process.env.ADMIN_TOKEN.trim());
  }
  return tokens;
}

export function isAuthRequired(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  if (process.env.AUTH_REQUIRED === 'false') {
    return false;
  }
  const tokens = getConfiguredAdminTokens();
  return tokens.length > 0;
}

export function verifyAdminToken(providedToken: string): boolean {
  if (!providedToken || typeof providedToken !== 'string') {
    return false;
  }

  const cleanProvided = providedToken.trim();
  const allowedTokens = new Set(getConfiguredAdminTokens());

  for (const allowed of allowedTokens) {
    if (cleanProvided.length === allowed.length) {
      if (crypto.timingSafeEqual(Buffer.from(cleanProvided), Buffer.from(allowed))) {
        return true;
      }
    }
  }

  return false;
}

export interface EncryptedPayload {
  iv: string; // hex
  tag: string; // hex
  data: string; // hex
}

export function encryptSecret(plainText: string): EncryptedPayload {
  if (!plainText) {
    throw new Error('Cannot encrypt empty secret');
  }

  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted,
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  if (!payload || !payload.iv || !payload.tag || !payload.data) {
    throw new Error('Invalid encrypted payload structure');
  }

  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(tag);
  let decrypted = decipher.update(payload.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length <= 8) {
    return '••••••••';
  }
  const start = apiKey.slice(0, 4);
  const end = apiKey.slice(-4);
  return `${start}••••••••${end}`;
}

export function maskSecret(): string {
  return '••••••••••••••••';
}

export function sanitizeLogMessage(text: string): string {
  if (!text) return '';
  // Redact potential API secrets or query parameter secrets
  return text
    .replace(/signature=[a-f0-9]{64}/gi, 'signature=[REDACTED]')
    .replace(/apiSecret=[^&\s]+/gi, 'apiSecret=[REDACTED]')
    .replace(/secret=[^&\s]+/gi, 'secret=[REDACTED]')
    .replace(/X-MBX-APIKEY:\s*[\w-]+/gi, 'X-MBX-APIKEY: [MASKED]');
}
