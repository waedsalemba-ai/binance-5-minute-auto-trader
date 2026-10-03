import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let resolvedKey: Buffer | null = null;

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

  // Persistent local key file if not set in environment
  const dataDir = path.resolve(process.cwd(), '.data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
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

  // Generate new random 32-byte key and persist
  resolvedKey = crypto.randomBytes(KEY_LENGTH);
  try {
    fs.writeFileSync(keyFilePath, resolvedKey.toString('hex'), { mode: 0o600 });
  } catch (err) {
    // If filesystem write fails, key remains in memory
  }

  return resolvedKey;
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
