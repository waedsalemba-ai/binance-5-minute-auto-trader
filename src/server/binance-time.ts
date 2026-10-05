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

const FALLBACK_TIME_URLS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

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
    const initialUrl = sanitizeUrl(rawBaseUrl || this.baseUrl);
    const urlsToTry = [initialUrl, ...FALLBACK_TIME_URLS.filter(u => u !== initialUrl)];

    try {
      for (const url of urlsToTry) {
        try {
          const localBefore = Date.now();
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000);

          const response = await fetch(`${url}/api/v3/time`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Binance-Scanner-Trader/2.0' },
          });
          clearTimeout(timeoutId);

          if (response.status === 451) {
            Logger.warn('PAPER', 'BINANCE', `Binance endpoint ${url} returned HTTP 451 (Region Restricted / Geo-blocked). Trying fallback endpoint...`);
            continue;
          }

          if (!response.ok) {
            continue;
          }

          const data = (await response.json()) as { serverTime: number };
          const localAfter = Date.now();
          const roundTrip = localAfter - localBefore;
          const estimatedServerTime = data.serverTime + Math.floor(roundTrip / 2);

          this.timeOffset = estimatedServerTime - localAfter;
          this.lastSyncedAt = Date.now();
          this.baseUrl = url;

          return true;
        } catch {
          // Try next fallback endpoint
        }
      }

      Logger.warn('PAPER', 'BINANCE', 'Periodic Binance time sync was unable to reach any Binance time endpoint. Using local time clock.');
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
