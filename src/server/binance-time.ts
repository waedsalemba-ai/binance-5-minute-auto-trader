import { Logger } from './logger.ts';

function sanitizeUrl(rawUrl?: string): string {
  const defaultUrl = 'https://api.binance.com';
  if (!rawUrl || typeof rawUrl !== 'string') return defaultUrl;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return defaultUrl;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return defaultUrl;
  }
}

export class BinanceTimeService {
  private static instance: BinanceTimeService;
  private timeOffset = 0; // binanceTime - localTime
  private lastSyncedAt = 0;
  private isSyncing = false;
  private driftThresholdMs = 1000; // max allowed drift for Binance spot signing
  private maxStalenessMs = 90000; // max 90s since last successful sync
  private periodicSyncTimer: NodeJS.Timeout | null = null;
  private baseUrl = 'https://api.binance.com';

  private constructor() {
    this.startPeriodicSync();
  }

  public static getInstance(): BinanceTimeService {
    if (!BinanceTimeService.instance) {
      BinanceTimeService.instance = new BinanceTimeService();
    }
    return BinanceTimeService.instance;
  }

  public startPeriodicSync(rawBaseUrl = 'https://api.binance.com'): void {
    this.baseUrl = sanitizeUrl(rawBaseUrl);
    if (this.periodicSyncTimer) return;

    // Initial sync
    this.syncWithBinance(this.baseUrl);

    // Sync every 30 seconds
    this.periodicSyncTimer = setInterval(() => {
      this.syncWithBinance(this.baseUrl).catch(() => {});
    }, 30000);
  }

  public async syncWithBinance(rawBaseUrl?: string): Promise<boolean> {
    if (this.isSyncing) return false;
    this.isSyncing = true;
    const url = sanitizeUrl(rawBaseUrl || this.baseUrl);
    try {
      const localBefore = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${url}/api/v3/time`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Binance-Scanner-Trader/2.0' },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to fetch Binance server time: HTTP ${response.status}`);
      }

      const data = (await response.json()) as { serverTime: number };
      const localAfter = Date.now();
      const roundTrip = localAfter - localBefore;
      const estimatedServerTime = data.serverTime + Math.floor(roundTrip / 2);

      this.timeOffset = estimatedServerTime - localAfter;
      this.lastSyncedAt = Date.now();

      return true;
    } catch (err: any) {
      Logger.warn('REAL', 'BINANCE', `Periodic Binance time sync error: ${err.message}`);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  public getSyncedTimestamp(): number {
    return Date.now() + this.timeOffset;
  }

  public getOffset(): number {
    return this.timeOffset;
  }

  public isSafeDrift(): boolean {
    if (this.lastSyncedAt === 0) return false;
    const isRecent = Date.now() - this.lastSyncedAt <= this.maxStalenessMs;
    const isDriftAcceptable = Math.abs(this.timeOffset) < this.driftThresholdMs;
    return isRecent && isDriftAcceptable;
  }

  public getLastSyncedAt(): number {
    return this.lastSyncedAt;
  }

  public getTelemetry() {
    return {
      serverTime: this.getSyncedTimestamp(),
      localTime: Date.now(),
      timeOffsetMs: this.timeOffset,
      lastSyncedAt: this.lastSyncedAt,
      isSafeDrift: this.isSafeDrift(),
      stalenessMs: Date.now() - this.lastSyncedAt,
    };
  }
}
