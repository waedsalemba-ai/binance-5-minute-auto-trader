import fs from 'node:fs';
import path from 'node:path';
import { TradingMode } from '../types/index.ts';
import { sanitizeLogMessage } from './security.ts';

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
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit-log.jsonl');

export type AuditEventType =
  | 'TRADING_STARTED'
  | 'TRADING_STOPPED'
  | 'EMERGENCY_STOP'
  | 'EMERGENCY_RESET'
  | 'BUY_AUTHORIZED'
  | 'BUY_REJECTED'
  | 'BUY_SUBMITTED'
  | 'BUY_FILLED'
  | 'BUY_PARTIAL'
  | 'SELL_AUTHORIZED'
  | 'SELL_REJECTED'
  | 'SELL_SUBMITTED'
  | 'SELL_FILLED'
  | 'SELL_PARTIAL'
  | 'ORDER_UNKNOWN'
  | 'RECONCILIATION_MISMATCH'
  | 'RECONCILIATION_SYNC'
  | 'REAL_MODE_CONFIRMED'
  | 'REAL_MODE_ENABLED'
  | 'REAL_MODE_DISABLED'
  | 'CREDENTIALS_UPDATED'
  | 'CREDENTIALS_REMOVED'
  | 'SETTINGS_UPDATED'
  | 'ACCOUNT_RESET';

export interface AuditRecord {
  id: string;
  timestamp: number;
  eventType: AuditEventType;
  mode: TradingMode;
  account?: string;
  symbol?: string;
  side?: 'BUY' | 'SELL';
  quantity?: number;
  price?: number;
  orderId?: string;
  clientOrderId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

class AuditLoggerEngine {
  private inMemoryAudit: AuditRecord[] = [];
  private maxInMemory = 1000;

  constructor() {
    this.loadRecentAuditRecords();
  }

  private loadRecentAuditRecords() {
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      try {
        const lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf8').trim().split('\n');
        const recent = lines.slice(-this.maxInMemory);
        for (const line of recent) {
          if (line.trim()) {
            this.inMemoryAudit.push(JSON.parse(line));
          }
        }
      } catch {
        // start empty if file is corrupt
      }
    }
  }

  public log(record: Omit<AuditRecord, 'id' | 'timestamp'>): AuditRecord {
    const fullRecord: AuditRecord = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      ...record,
      reason: record.reason ? sanitizeLogMessage(record.reason) : undefined,
    };

    this.inMemoryAudit.unshift(fullRecord);
    if (this.inMemoryAudit.length > this.maxInMemory) {
      this.inMemoryAudit.pop();
    }

    // Append to JSONL file
    try {
      fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(fullRecord) + '\n');
    } catch {
      // ignore disk write failure
    }

    return fullRecord;
  }

  public getRecent(limit = 100, eventType?: AuditEventType): AuditRecord[] {
    let list = this.inMemoryAudit;
    if (eventType) {
      list = list.filter(r => r.eventType === eventType);
    }
    return list.slice(0, limit);
  }
}

export const AuditLogger = new AuditLoggerEngine();
