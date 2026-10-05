import crypto from 'node:crypto';
import { Candle, SymbolFilterRules } from '../types/index.ts';
import { BinanceTimeService } from './binance-time.ts';
import { BinanceSymbolNormalizer } from './symbol-normalizer.ts';
import { BinanceSymbolValidator } from './symbol-validator.ts';
import { Logger } from './logger.ts';
import { sanitizeLogMessage } from './security.ts';

export interface BinanceAccountInfo {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: number;
  accountType: string;
  balances: {
    asset: string;
    free: string;
    locked: string;
  }[];
  permissions: string[];
}

export interface BinanceOrderResponse {
  symbol: string;
  orderId: number;
  orderListId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string; // NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED
  timeInForce: string;
  type: string;
  side: string;
  fills?: {
    price: string;
    qty: string;
    commission: string;
    commissionAsset: string;
    tradeId: number;
  }[];
}

export interface BinanceTradeItem {
  symbol: string;
  id: number;
  orderId: number;
  orderListId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
  isBestMatch: boolean;
}

export function normalizeBinanceBaseUrl(rawUrl?: string): string {
  const defaultUrl = 'https://api.binance.com';
  if (!rawUrl || typeof rawUrl !== 'string') return defaultUrl;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    // Redact/ignore invalid non-URL values (e.g., if an API key was accidentally passed)
    return defaultUrl;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return defaultUrl;
  }
}

const FALLBACK_BASE_URLS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://data-api.binance.vision',
];

export class BinanceRequestManager {
  private static instance: BinanceRequestManager;
  private baseUrl: string;
  private currentFallbackIndex = 0;
  private concurrencyLimit = 8;
  private activeRequests = 0;
  private queue: Array<() => Promise<void>> = [];
  private rateLimitBlockedUntil = 0;
  private symbolFiltersCache: Map<string, SymbolFilterRules> = new Map();
  private cacheExpiry = 0;

  private constructor() {
    this.baseUrl = normalizeBinanceBaseUrl(process.env.BINANCE_API_BASE_URL);
  }

  public static getInstance(): BinanceRequestManager {
    if (!BinanceRequestManager.instance) {
      BinanceRequestManager.instance = new BinanceRequestManager();
    }
    return BinanceRequestManager.instance;
  }

  private async processQueue(): Promise<void> {
    if (this.activeRequests >= this.concurrencyLimit || this.queue.length === 0) {
      return;
    }

    if (Date.now() < this.rateLimitBlockedUntil) {
      const waitMs = this.rateLimitBlockedUntil - Date.now();
      setTimeout(() => this.processQueue(), waitMs);
      return;
    }

    const task = this.queue.shift();
    if (task) {
      this.activeRequests++;
      task().finally(() => {
        this.activeRequests--;
        this.processQueue();
      });
    }
  }

  public async executeRequest<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const res = await fn();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
      this.processQueue();
    });
  }

  private signParams(params: Record<string, string | number | boolean>, secret: string): string {
    const timeService = BinanceTimeService.getInstance();
    const timestamp = timeService.getSyncedTimestamp();
    const queryObj = { ...params, timestamp, recvWindow: 5000 };

    const queryString = Object.entries(queryObj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.toString())}`)
      .join('&');

    const signature = crypto.createHmac('sha256', secret).update(queryString).digest('hex');
    return `${queryString}&signature=${signature}`;
  }

  public async fetchPublic<T>(endpoint: string, params: Record<string, any> = {}): Promise<T> {
    return this.executeRequest(async () => {
      const qs = Object.entries(params)
        .filter(([_, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.toString())}`)
        .join('&');

      const activeBase = normalizeBinanceBaseUrl(this.baseUrl);
      const url = `${activeBase}${endpoint}${qs ? `?${qs}` : ''}`;
      
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Binance-Scanner-AutoTrader/1.0',
            'Accept': 'application/json',
          },
        });

        if (res.status === 429 || res.status === 418) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 60;
          this.rateLimitBlockedUntil = Date.now() + retryAfter * 1000;
          Logger.warn('PAPER', 'BINANCE', `Rate limit hit (HTTP ${res.status}). Pausing requests for ${retryAfter}s`);
          throw new Error(`Binance Rate Limit (HTTP ${res.status}). Pausing for ${retryAfter} seconds.`);
        }

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Binance Public API error (${res.status}): ${sanitizeLogMessage(errText)}`);
        }

        return (await res.json()) as T;
      } catch (err: any) {
        // If the primary host failed, try alternate endpoints
        for (const altBase of FALLBACK_BASE_URLS) {
          if (altBase === activeBase) continue;
          try {
            const altUrl = `${altBase}${endpoint}${qs ? `?${qs}` : ''}`;
            const altRes = await fetch(altUrl, {
              headers: {
                'User-Agent': 'Binance-Scanner-AutoTrader/1.0',
                'Accept': 'application/json',
              },
            });
            if (altRes.ok) {
              this.baseUrl = altBase; // switch to functioning endpoint
              return (await altRes.json()) as T;
            }
          } catch {
            // try next fallback
          }
        }
        throw err;
      }
    });
  }

  public async fetchSigned<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE',
    params: Record<string, any>,
    apiKey: string,
    apiSecret: string
  ): Promise<T> {
    return this.executeRequest(async () => {
      const signedQuery = this.signParams(params, apiSecret);
      const activeBase = normalizeBinanceBaseUrl(this.baseUrl);
      let url = `${activeBase}${endpoint}`;
      const headers: Record<string, string> = {
        'X-MBX-APIKEY': apiKey,
        'User-Agent': 'Binance-Scanner-AutoTrader/1.0',
        'Accept': 'application/json',
      };

      let body: string | undefined;

      if (method === 'GET' || method === 'DELETE') {
        url += `?${signedQuery}`;
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = signedQuery;
      }

      const res = await fetch(url, {
        method,
        headers,
        body,
      });

      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers.get('Retry-After')) || 60;
        this.rateLimitBlockedUntil = Date.now() + retryAfter * 1000;
        Logger.error('REAL', 'BINANCE', `Rate limit hit on signed endpoint (HTTP ${res.status}). Blocked for ${retryAfter}s`);
        throw new Error(`Binance Rate Limit (HTTP ${res.status}). Blocked for ${retryAfter} seconds.`);
      }

      const json = await res.json();
      if (!res.ok) {
        const msg = json?.msg || JSON.stringify(json);
        const code = json?.code || res.status;
        throw new Error(`Binance API error [${code}]: ${sanitizeLogMessage(msg)}`);
      }

      return json as T;
    });
  }

  // --- Exchange Info & Filters ---
  public async getExchangeInfo(): Promise<{ symbols: any[] }> {
    return this.fetchPublic<{ symbols: any[] }>('/api/v3/exchangeInfo');
  }

  public async getSymbolFilters(symbol: string): Promise<SymbolFilterRules> {
    if (this.symbolFiltersCache.has(symbol) && Date.now() < this.cacheExpiry) {
      return this.symbolFiltersCache.get(symbol)!;
    }

    const exInfo = await this.getExchangeInfo();
    this.cacheExpiry = Date.now() + 30 * 60 * 1000; // cache 30m

    for (const sym of exInfo.symbols) {
      let minNotional = 5;
      let minQty = 0.00001;
      let maxQty = 9999999;
      let stepSize = 0.00001;
      let tickSize = 0.01;
      let minPrice = 0.000001;
      let maxPrice = 1000000;

      for (const f of sym.filters || []) {
        if (f.filterType === 'LOT_SIZE') {
          minQty = parseFloat(f.minQty);
          maxQty = parseFloat(f.maxQty);
          stepSize = parseFloat(f.stepSize);
        } else if (f.filterType === 'PRICE_FILTER') {
          minPrice = parseFloat(f.minPrice);
          maxPrice = parseFloat(f.maxPrice);
          tickSize = parseFloat(f.tickSize);
        } else if (f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') {
          minNotional = parseFloat(f.minNotional || f.notional || '5');
        }
      }

      this.symbolFiltersCache.set(sym.symbol, {
        minNotional,
        minQty,
        maxQty,
        stepSize,
        tickSize,
        minPrice,
        maxPrice,
      });
    }

    return this.symbolFiltersCache.get(symbol) || {
      minNotional: 5,
      minQty: 0.00001,
      maxQty: 9999999,
      stepSize: 0.00001,
      tickSize: 0.01,
      minPrice: 0.000001,
      maxPrice: 1000000,
    };
  }

  // --- Market Data ---
  public async get24hrTickers(): Promise<any[]> {
    return this.fetchPublic<any[]>('/api/v3/ticker/24hr');
  }

  public async getKlines(symbol: string, interval = '5m', limit = 200): Promise<Candle[]> {
    const rawKlines = await this.fetchPublic<any[]>('/api/v3/klines', {
      symbol,
      interval,
      limit,
    });

    const now = Date.now();
    return rawKlines.map((k: any) => {
      const closeTime = Number(k[6]);
      return {
        timestamp: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: closeTime,
        quoteVolume: parseFloat(k[7]),
        trades: Number(k[8]),
        isClosed: closeTime < now,
      };
    });
  }

  public async getLatestPrice(symbol: string): Promise<number> {
    const res = await this.fetchPublic<{ symbol: string; price: string }>('/api/v3/ticker/price', { symbol });
    return parseFloat(res.price);
  }

  // --- Account & Signed Endpoints ---
  public async testCredentials(apiKey: string, apiSecret: string): Promise<BinanceAccountInfo> {
    await BinanceTimeService.getInstance().syncWithBinance(this.baseUrl);
    return this.fetchSigned<BinanceAccountInfo>('/api/v3/account', 'GET', {}, apiKey, apiSecret);
  }

  public async getAccount(apiKey: string, apiSecret: string): Promise<BinanceAccountInfo> {
    return this.fetchSigned<BinanceAccountInfo>('/api/v3/account', 'GET', {}, apiKey, apiSecret);
  }

  public async getOpenOrders(apiKey: string, apiSecret: string, symbol?: string): Promise<any[]> {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol;
    return this.fetchSigned<any[]>('/api/v3/openOrders', 'GET', params, apiKey, apiSecret);
  }

  public async getMyTrades(apiKey: string, apiSecret: string, symbol: string, limit = 50): Promise<BinanceTradeItem[]> {
    return this.fetchSigned<BinanceTradeItem[]>('/api/v3/myTrades', 'GET', { symbol, limit }, apiKey, apiSecret);
  }

  public async queryOrder(apiKey: string, apiSecret: string, symbol: string, origClientOrderId?: string, orderId?: number): Promise<BinanceOrderResponse> {
    const params: Record<string, any> = { symbol };
    if (origClientOrderId) params.origClientOrderId = origClientOrderId;
    if (orderId) params.orderId = orderId;
    return this.fetchSigned<BinanceOrderResponse>('/api/v3/order', 'GET', params, apiKey, apiSecret);
  }

  public async placeMarketBuy(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    quoteOrderQty: number,
    newClientOrderId: string
  ): Promise<BinanceOrderResponse> {
    const params: Record<string, any> = {
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: quoteOrderQty.toFixed(2),
      newClientOrderId,
    };
    return this.fetchSigned<BinanceOrderResponse>('/api/v3/order', 'POST', params, apiKey, apiSecret);
  }

  public async placeMarketSell(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    quantity: number,
    newClientOrderId: string
  ): Promise<BinanceOrderResponse> {
    const filter = await this.getSymbolFilters(symbol);
    const precision = Math.max(0, Math.round(-Math.log10(filter.stepSize)));
    // Floor quantity to stepSize precision so we don't exceed available balance
    const formattedQty = (Math.floor(quantity / filter.stepSize) * filter.stepSize).toFixed(precision);

    const params: Record<string, any> = {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: formattedQty,
      newClientOrderId,
    };
    return this.fetchSigned<BinanceOrderResponse>('/api/v3/order', 'POST', params, apiKey, apiSecret);
  }
}
