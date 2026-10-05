import {
  MarketType,
  SymbolFilterRules,
  SymbolValidationResult,
  OrderSide,
} from '../types/index.ts';
import { BinanceSymbolNormalizer } from './symbol-normalizer.ts';
import { Logger } from './logger.ts';
import { Storage } from './storage.ts';

export interface BinanceRawSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
  filters: any[];
  permissions?: string[];
}

export interface CachedMarketMetadata {
  symbolsMap: Map<string, {
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    tradable: boolean;
    filters: SymbolFilterRules;
  }>;
  fetchedAt: number;
}

const DEFAULT_CACHE_TTL_MS = Number(process.env.BINANCE_SYMBOL_CACHE_TTL_MS) || 300000; // 5 minutes
const DEFAULT_MAX_STALE_MS = Number(process.env.BINANCE_SYMBOL_MAX_STALE_MS) || 900000; // 15 minutes

const SPOT_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const FUTURES_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

export class BinanceSymbolValidator {
  private static instance: BinanceSymbolValidator;
  private spotCache: CachedMarketMetadata | null = null;
  private futuresCache: CachedMarketMetadata | null = null;
  private refreshMutex = new Map<MarketType, Promise<boolean>>();

  private constructor() {}

  public static getInstance(): BinanceSymbolValidator {
    if (!BinanceSymbolValidator.instance) {
      BinanceSymbolValidator.instance = new BinanceSymbolValidator();
    }
    return BinanceSymbolValidator.instance;
  }

  /**
   * For testing: inject mock metadata cache directly
   */
  public setMockMetadata(market: MarketType, rawSymbols: BinanceRawSymbolInfo[]): void {
    const symbolsMap = new Map<string, any>();
    for (const s of rawSymbols) {
      const parsedFilters = this.extractFilters(s.filters || []);
      const isTradable = s.status === 'TRADING';
      symbolsMap.set(s.symbol.toUpperCase(), {
        symbol: s.symbol.toUpperCase(),
        status: s.status,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        tradable: isTradable,
        filters: parsedFilters,
      });
    }

    const metadata: CachedMarketMetadata = {
      symbolsMap,
      fetchedAt: Date.now(),
    };

    if (market === 'SPOT') {
      this.spotCache = metadata;
    } else {
      this.futuresCache = metadata;
    }
  }

  /**
   * Validates whether a symbol is currently tradable on Binance Spot or Futures.
   * Automatically normalizes legacy tokens (e.g. RNDRUSDT -> RENDERUSDT).
   */
  public async validateSymbol(
    rawSymbol: string,
    market: MarketType = 'SPOT',
    forceRefresh = false
  ): Promise<SymbolValidationResult> {
    const normalizer = BinanceSymbolNormalizer.getInstance();
    const normalized = normalizer.normalize(rawSymbol);
    const targetSymbol = normalized.normalizedSymbol;

    if (!targetSymbol) {
      return {
        requestedSymbol: rawSymbol,
        normalizedSymbol: '',
        market,
        exists: false,
        status: null,
        tradable: false,
        reason: 'INVALID_EMPTY_SYMBOL',
      };
    }

    // Ensure exchange metadata is available
    await this.ensureFreshMetadata(market, forceRefresh);

    const cache = market === 'SPOT' ? this.spotCache : this.futuresCache;

    if (!cache || !cache.symbolsMap || cache.symbolsMap.size === 0) {
      // FAIL CLOSED: No exchange metadata could be retrieved
      Logger.warn(
        'PAPER',
        'BINANCE',
        `[VALIDATION] Metadata unavailable for ${market} market. Failing closed on ${targetSymbol}.`
      );
      return {
        requestedSymbol: rawSymbol,
        normalizedSymbol: targetSymbol,
        market,
        exists: false,
        status: null,
        tradable: false,
        reason: 'EXCHANGE_METADATA_UNAVAILABLE',
      };
    }

    const symbolInfo = cache.symbolsMap.get(targetSymbol);

    if (!symbolInfo) {
      const reason = 'SYMBOL_NOT_TRADABLE';
      Logger.warn(
        'PAPER',
        'BINANCE',
        `[VALIDATION] Symbol ${targetSymbol} (from ${rawSymbol}) not found on Binance ${market}. Reason: ${reason}`
      );
      return {
        requestedSymbol: rawSymbol,
        normalizedSymbol: targetSymbol,
        market,
        exists: false,
        status: null,
        tradable: false,
        reason,
        baseAsset: normalized.baseAsset,
        quoteAsset: normalized.quoteAsset,
      };
    }

    if (symbolInfo.status !== 'TRADING') {
      const reason = `SYMBOL_STATUS_${symbolInfo.status}`;
      Logger.warn(
        'PAPER',
        'BINANCE',
        `[VALIDATION] Symbol ${targetSymbol} exists on Binance ${market} but status is '${symbolInfo.status}'. Non-tradable.`
      );
      return {
        requestedSymbol: rawSymbol,
        normalizedSymbol: targetSymbol,
        market,
        exists: true,
        status: symbolInfo.status,
        tradable: false,
        reason,
        baseAsset: symbolInfo.baseAsset,
        quoteAsset: symbolInfo.quoteAsset,
        filters: symbolInfo.filters,
        lastUpdated: cache.fetchedAt,
      };
    }

    return {
      requestedSymbol: rawSymbol,
      normalizedSymbol: targetSymbol,
      market,
      exists: true,
      status: 'TRADING',
      tradable: true,
      reason: null,
      baseAsset: symbolInfo.baseAsset,
      quoteAsset: symbolInfo.quoteAsset,
      filters: symbolInfo.filters,
      lastUpdated: cache.fetchedAt,
    };
  }

  /**
   * Retrieves live filters for a symbol on Spot or Futures.
   */
  public async getSymbolFilters(
    symbol: string,
    market: MarketType = 'SPOT'
  ): Promise<SymbolFilterRules | null> {
    const val = await this.validateSymbol(symbol, market);
    if (!val.tradable || !val.filters) {
      return null;
    }
    return val.filters;
  }

  /**
   * Formats quantity safely according to LOT_SIZE stepSize and min/max limits.
   * Prevents JavaScript float precision errors.
   */
  public async formatOrderQuantity(
    symbol: string,
    quantity: number,
    market: MarketType = 'SPOT'
  ): Promise<{ valid: boolean; formattedQty: string; numericQty: number; reason?: string }> {
    const filters = await this.getSymbolFilters(symbol, market);
    if (!filters) {
      return { valid: false, formattedQty: '0', numericQty: 0, reason: 'SYMBOL_NOT_TRADABLE' };
    }

    if (quantity < filters.minQty) {
      return {
        valid: false,
        formattedQty: '0',
        numericQty: 0,
        reason: `QUANTITY_BELOW_MIN (Quantity ${quantity} < Min ${filters.minQty})`,
      };
    }

    if (quantity > filters.maxQty) {
      return {
        valid: false,
        formattedQty: '0',
        numericQty: 0,
        reason: `QUANTITY_ABOVE_MAX (Quantity ${quantity} > Max ${filters.maxQty})`,
      };
    }

    // Step size precision
    const precision = this.getDecimalPrecision(filters.stepSize);
    // Floor quantity to stepSize multiple
    const stepCount = Math.floor(quantity / filters.stepSize);
    const numericQty = Number((stepCount * filters.stepSize).toFixed(precision));

    if (numericQty < filters.minQty) {
      return {
        valid: false,
        formattedQty: '0',
        numericQty: 0,
        reason: `STEP_FLOORED_QUANTITY_BELOW_MIN (${numericQty} < ${filters.minQty})`,
      };
    }

    return {
      valid: true,
      formattedQty: numericQty.toFixed(precision),
      numericQty,
    };
  }

  /**
   * Formats price according to PRICE_FILTER tickSize.
   */
  public async formatOrderPrice(
    symbol: string,
    price: number,
    market: MarketType = 'SPOT'
  ): Promise<{ valid: boolean; formattedPrice: string; numericPrice: number; reason?: string }> {
    const filters = await this.getSymbolFilters(symbol, market);
    if (!filters) {
      return { valid: false, formattedPrice: '0', numericPrice: 0, reason: 'SYMBOL_NOT_TRADABLE' };
    }

    if (price < filters.minPrice || price > filters.maxPrice) {
      return {
        valid: false,
        formattedPrice: '0',
        numericPrice: 0,
        reason: `PRICE_OUT_OF_BOUNDS (${price} outside [${filters.minPrice}, ${filters.maxPrice}])`,
      };
    }

    const precision = this.getDecimalPrecision(filters.tickSize);
    const tickCount = Math.round(price / filters.tickSize);
    const numericPrice = Number((tickCount * filters.tickSize).toFixed(precision));

    return {
      valid: true,
      formattedPrice: numericPrice.toFixed(precision),
      numericPrice,
    };
  }

  /**
   * Ensures metadata cache is fresh; fetches if expired, missing, or explicitly forced.
   */
  private async ensureFreshMetadata(market: MarketType, forceRefresh = false): Promise<void> {
    const cache = market === 'SPOT' ? this.spotCache : this.futuresCache;
    const now = Date.now();

    if (!forceRefresh && cache && (now - cache.fetchedAt < DEFAULT_CACHE_TTL_MS)) {
      return;
    }

    // If cache is within max stale age and fetch is already in progress, use existing stale cache
    if (!forceRefresh && cache && (now - cache.fetchedAt < DEFAULT_MAX_STALE_MS) && this.refreshMutex.has(market)) {
      return;
    }

    // Refresh with mutex lock to prevent concurrent fetch storms
    if (this.refreshMutex.has(market)) {
      await this.refreshMutex.get(market);
      return;
    }

    const fetchPromise = this.fetchExchangeInfo(market);
    this.refreshMutex.set(market, fetchPromise);

    try {
      await fetchPromise;
    } finally {
      this.refreshMutex.delete(market);
    }
  }

  /**
   * Fetches exchangeInfo from Binance Spot or USDM Futures.
   */
  public async fetchExchangeInfo(market: MarketType): Promise<boolean> {
    const url = market === 'SPOT' ? SPOT_EXCHANGE_INFO_URL : FUTURES_EXCHANGE_INFO_URL;

    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as { symbols: BinanceRawSymbolInfo[] };

      if (!data || !Array.isArray(data.symbols)) {
        throw new Error('Malformed exchangeInfo payload');
      }

      const symbolsMap = new Map<string, any>();

      for (const s of data.symbols) {
        if (!s.symbol) continue;
        const symbolKey = s.symbol.toUpperCase();
        const isTradable = s.status === 'TRADING';
        const parsedFilters = this.extractFilters(s.filters || []);

        symbolsMap.set(symbolKey, {
          symbol: symbolKey,
          status: s.status,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          tradable: isTradable,
          filters: parsedFilters,
        });
      }

      const newCache: CachedMarketMetadata = {
        symbolsMap,
        fetchedAt: Date.now(),
      };

      if (market === 'SPOT') {
        this.spotCache = newCache;
      } else {
        this.futuresCache = newCache;
      }

      Logger.info(
        'PAPER',
        'BINANCE',
        `[VALIDATION] Successfully refreshed Binance ${market} exchangeInfo (${symbolsMap.size} symbols indexed).`
      );
      return true;
    } catch (err: any) {
      Logger.error(
        'PAPER',
        'BINANCE',
        `[VALIDATION] Failed to fetch Binance ${market} exchangeInfo: ${err.message}`
      );
      return false;
    }
  }

  public invalidateCache(market?: MarketType): void {
    if (!market || market === 'SPOT') this.spotCache = null;
    if (!market || market === 'USDM_FUTURES') this.futuresCache = null;
  }

  private extractFilters(filters: any[]): SymbolFilterRules {
    let minNotional = 5;
    let minQty = 0.0001;
    let maxQty = 9999999;
    let stepSize = 0.0001;
    let tickSize = 0.01;
    let minPrice = 0.000001;
    let maxPrice = 1000000;

    for (const f of filters) {
      if (f.filterType === 'LOT_SIZE') {
        if (f.minQty) minQty = parseFloat(f.minQty);
        if (f.maxQty) maxQty = parseFloat(f.maxQty);
        if (f.stepSize) stepSize = parseFloat(f.stepSize);
      } else if (f.filterType === 'PRICE_FILTER') {
        if (f.minPrice) minPrice = parseFloat(f.minPrice);
        if (f.maxPrice) maxPrice = parseFloat(f.maxPrice);
        if (f.tickSize) tickSize = parseFloat(f.tickSize);
      } else if (f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') {
        if (f.minNotional) minNotional = parseFloat(f.minNotional);
        else if (f.notional) minNotional = parseFloat(f.notional);
      }
    }

    return {
      minNotional,
      minQty,
      maxQty,
      stepSize,
      tickSize,
      minPrice,
      maxPrice,
    };
  }

  private getDecimalPrecision(num: number): number {
    if (num <= 0) return 8;
    const str = num.toString();
    if (str.includes('e-')) {
      return parseInt(str.split('e-')[1], 10);
    }
    const parts = str.split('.');
    return parts.length > 1 ? parts[1].length : 0;
  }
}
