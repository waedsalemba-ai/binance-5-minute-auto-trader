import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Request, Response, NextFunction } from 'express';
import { Logger } from './logger.ts';

function resolveDataDir(): string {
  let envDir = process.env.DATA_DIR?.trim();
  if (envDir && envDir.startsWith('=')) {
    envDir = envDir.substring(1).trim();
  }
  const dir = envDir && envDir.length > 0 ? path.resolve(process.cwd(), envDir) : path.resolve(process.cwd(), '.data');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    const fallback = path.resolve(process.cwd(), '.data');
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }
}

const DATA_DIR = resolveDataDir();
const TOKEN_FILE = path.join(DATA_DIR, 'admin.token');

let cachedToken: string | null = null;

/**
 * Returns the active admin authentication token.
 * Sourced from process.env.API_ADMIN_TOKEN / process.env.ADMIN_TOKEN or generated and stored securely.
 */
export function getAdminToken(): string {
  if (cachedToken) return cachedToken;

  const envToken = process.env.API_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    cachedToken = envToken.trim();
    return cachedToken;
  }

  // Load from persistent file if exists
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const stored = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (stored.length >= 16) {
        cachedToken = stored;
        return cachedToken;
      }
    } catch {
      // Regenerate if file read fails
    }
  }

  // Generate cryptographically secure token (32 bytes = 64 hex chars)
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, generated, { mode: 0o600 });
  } catch (err) {
    // Keep in memory if write fails
  }
  cachedToken = generated;
  return cachedToken;
}

/**
 * Validates whether an incoming request presents valid authentication credentials.
 */
export function validateRequestAuth(req: Request): boolean {
  const masterToken = getAdminToken();

  // 1. Check X-Admin-Token or X-API-Key header
  const headerToken = req.headers['x-admin-token'] || req.headers['x-api-key'];
  if (headerToken && typeof headerToken === 'string') {
    const trimmed = headerToken.trim();
    if (trimmed.length === masterToken.length && crypto.timingSafeEqual(Buffer.from(trimmed), Buffer.from(masterToken))) {
      return true;
    }
  }

  // 2. Check Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.substring(7).trim();
    if (bearerToken.length === masterToken.length && crypto.timingSafeEqual(Buffer.from(bearerToken), Buffer.from(masterToken))) {
      return true;
    }
  }

  // 3. Check session cookie / token query param
  const queryToken = req.query.token as string | undefined;
  if (queryToken && typeof queryToken === 'string') {
    const trimmed = queryToken.trim();
    if (trimmed.length === masterToken.length && crypto.timingSafeEqual(Buffer.from(trimmed), Buffer.from(masterToken))) {
      return true;
    }
  }

  return false;
}

/**
 * Express middleware requiring valid authentication on sensitive trading/credential endpoints.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Allow OPTIONS pre-flight
  if (req.method === 'OPTIONS') {
    return next();
  }

  if (!validateRequestAuth(req)) {
    Logger.warn('PAPER', 'SECURITY', `Unauthorized access attempt rejected on ${req.method} ${req.path} from IP: ${req.ip}`);
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Provide a valid X-Admin-Token or Bearer token header.',
        retryable: false,
      },
    });
  }

  next();
}

/**
 * Validates whether a CORS origin is in the allowed whitelist.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // allow same-origin / server-to-server

  // Check APP_ORIGIN (e.g. Render public URL: https://binance-trader.onrender.com)
  const appOrigin = process.env.APP_ORIGIN;
  if (appOrigin && appOrigin.trim().length > 0) {
    if (origin.toLowerCase() === appOrigin.trim().toLowerCase()) {
      return true;
    }
  }

  const allowedEnv = process.env.ALLOWED_ORIGINS;
  if (allowedEnv && allowedEnv.trim().length > 0) {
    const origins = allowedEnv.split(',').map(o => o.trim().toLowerCase());
    return origins.includes(origin.toLowerCase()) || origins.includes('*');
  }

  // In production with no explicit cross-origin whitelist, only allow same-origin
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev) return true;

  return false;
}
