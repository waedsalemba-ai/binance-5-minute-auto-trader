import {
  MarketType,
  SymbolFilterRules,
  SymbolValidationResult,
  SpotSymbolValidationResult,
} from '../types/index.ts';
import { BinanceSymbolNormalizer } from './symbol-normalizer.ts';
import { Logger } from './logger.ts';

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
    isSpotTradingAllowed?: boolean;
    permissions: string[];
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
  private lastValidationTime = 0;
  private lastValidatedSymbol?: string;
  private lastValidationError: string | null = null;
  private autoRefreshTimer: NodeJS.Timeout | null = null;

  private constructor() {
    // Periodically refresh Spot metadata cache every 5 minutes
    this.autoRefreshTimer = setInterval(() => {
      this.ensureFreshMetadata('SPOT', true).catch(() => {});
    }, DEFAULT_CACHE_TTL_MS);
    this.autoRefreshTimer.unref();
  }

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
      const isTradable = s.status === 'TRADING' && (s.isSpotTradingAllowed !== false);
      const permissions = Array.isArray(s.permissions) ? s.permissions : ['SPOT'];

      symbolsMap.set(s.symbol.toUpperCase(), {
        symbol: s.symbol.toUpperCase(),
        status: s.status,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        isSpotTradingAllowed: s.isSpotTradingAllowed ?? true,
        permissions,
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
   * Returns the authoritative current Binance Spot USDT universe.
   * Automatic scanning MUST use this list instead of treating ticker/24hr as the
   * source of truth, because ticker data alone is not a sufficient tradability gate.
   */
  public async getTradableSpotUsdtSymbols(forceRefresh = false): Promise<Set<string>> {
    await this.ensureFreshMetadata('SPOT', forceRefresh);

    if (!this.spotCache || this.spotCache.symbolsMap.size === 0) {
      throw new Error('BINANCE_SPOT_METADATA_UNAVAILABLE');
    }

    const symbols = new Set<string>();
    for (const [symbol, info] of this.spotCache.symbolsMap.entries()) {
      if (
        info.status === 'TRADING' &&
        info.tradable &&
        info.isSpotTradingAllowed !== false &&
        info.quoteAsset === 'USDT' &&
        (!info.permissions.length || info.permissions.includes('SPOT') || info.permissions.includes('TRD_GRP_001'))
      ) {
        symbols.add(symbol);
      }
    }

    return symbols;
  }

  /**
   * Strict check for automated trading: symbol must be the exact current Binance
   * Spot symbol. Legacy/rebranded aliases are NOT accepted for auto-generated
   * signals, even when the normalizer knows a migration mapping.
   */
  public async validateExactSpotUsdtSymbol(rawSymbol: string): Promise<SpotSymbolValidationResult> {
    const clean = (rawSymbol || '').trim().toUpperCase();
    const result = await this.validateSpotSymbol(clean);
    if (!result.tradable || result.normalizedSymbol !== clean || result.quoteAsset !== 'USDT') {
      return {
        ...result,
        tradable: false,
        reason: result.tradable ? 'STRICT_BINANCE_SYMBOL_MISMATCH' : result.reason,
      };
    }
    return result;
  }

  /**
   * Authoritative Binance Spot Symbol Validation.
   * Confirms symbol existence, TRADING status, isSpotTradingAllowed, SPOT permission, quoteAsset is USDT, and filters.
   */
  public async validateSpotSymbol(
    rawSymbol: string,
    forceRefresh = false
  ): Promise<SpotSymbolValidationResult> {
    const cleanRaw = (rawSymbol || '').trim().toUpperCase();
    this.lastValidationTime = Date.now();
    this.lastValidatedSymbol = cleanRaw;

    const defaultEmptyFilters: SymbolFilterRules = {
      minNotional: 5,
      minQty: 0.0001,
      maxQty: 9999999,
      stepSize: 0.0001,
      tickSize: 0.01,
      minPrice: 0.000001,
      maxPrice: 1000000,
    };

    if (!cleanRaw) {
      this.lastValidationError = 'INVALID_EMPTY_SYMBOL';
      return {
        requestedSymbol: rawSymbol,
        normalizedSymbol: '',
        exists: false,
        status: null,
        tradable: false,
        isSpotTradingAllowed: false,
        baseAsset: '',
        quoteAsset: '',
        permissions: [],
        filters: defaultEmptyFilters,
        reason: 'INVALID_EMPTY_SYMBOL',
        fetchedAt: Date.now(),
      };
    }

    // Ensure exchange metadata is available
    await this.ensureFreshMetadata('SPOT', forceRefresh);

    if (!this.spotCache || !this.spotCache.symbolsMap || this.spotCache.symbolsMap.size === 0) {
      const reason = 'EXCHANGE_METADATA_UNAVAILABLE';
      this.lastValidationError = reason;
      Logger.warn('REAL', 'BINANCE', `LIVE_ORDER_BLOCKED symbol=${cleanRaw} market=SPOT reason=${reason}`);
      return {
        requestedSymbol: cleanRaw,
        normalizedSymbol: cleanRaw,
        exists: false,
        status: null,
        tradable: false,
        isSpotTradingAllowed: false,
        baseAsset: '',
        quoteAsset: '',
        permissions: [],
        filters: defaultEmptyFilters,
        reason,
        fetchedAt: this.spotCache?.fetchedAt || Date.now(),
      };
    }

    const symbolsMap = this.spotCache.symbolsMap;

    // Normalization check: Determine candidate symbol
    const normalizer = BinanceSymbolNormalizer.getInstance();
    const candidateResult = normalizer.normalize(cleanRaw);
    let targetSymbol = cleanRaw;
    let appliedMigration = false;

    // Check if the original symbol exists directly in Binance Spot
    const directInfo = symbolsMap.get(cleanRaw);
    const candidateInfo = symbolsMap.get(candidateResult.normalizedSymbol);

    if (directInfo && directInfo.status === 'TRADING') {
      targetSymbol = cleanRaw;
    } else if (candidateResult.mappingApplied && candidateInfo && candidateInfo.status === 'TRADING') {
      // Confirmed on live Binance Spot that the migrated candidate exists and is TRADING
      targetSymbol = candidateResult.normalizedSymbol;
      appliedMigration = true;
    } else if (directInfo) {
      targetSymbol = cleanRaw;
    } else if (candidateResult.mappingApplied && candidateInfo) {
      targetSymbol = candidateResult.normalizedSymbol;
      appliedMigration = true;
    } else {
      targetSymbol = candidateResult.normalizedSymbol || cleanRaw;
    }

    const symbolInfo = symbolsMap.get(targetSymbol);

    if (!symbolInfo) {
      const reason = 'SYMBOL_NOT_TRADABLE';
      this.lastValidationError = reason;
      Logger.warn(
        'REAL',
        'BINANCE',
        `LIVE_ORDER_BLOCKED symbol=${cleanRaw} market=SPOT reason=${reason} (target: ${targetSymbol})`
      );
      return {
        requestedSymbol: cleanRaw,
        normalizedSymbol: targetSymbol,
        exists: false,
        status: null,
        tradable: false,
        isSpotTradingAllowed: false,
        baseAsset: candidateResult.baseAsset,
        quoteAsset: candidateResult.quoteAsset,
        permissions: [],
        filters: defaultEmptyFilters,
        reason,
        fetchedAt: this.spotCache.fetchedAt,
      };
    }

    // Check 1: Status must be TRADING
    if (symbolInfo.status !== 'TRADING') {
      const reason = `SYMBOL_STATUS_${symbolInfo.status}`;
      this.lastValidationError = reason;
      Logger.warn(
        'REAL',
        'BINANCE',
        `LIVE_ORDER_BLOCKED symbol=${cleanRaw} market=SPOT reason=${reason} binanceStatus=${symbolInfo.status}`
      );
      return {
        requestedSymbol: cleanRaw,
        normalizedSymbol: targetSymbol,
        exists: true,
        status: symbolInfo.status,
        tradable: false,
        isSpotTradingAllowed: symbolInfo.isSpotTradingAllowed ?? false,
        baseAsset: symbolInfo.baseAsset,
        quoteAsset: symbolInfo.quoteAsset,
        permissions: symbolInfo.permissions,
        filters: symbolInfo.filters,
        reason,
        fetchedAt: this.spotCache.fetchedAt,
      };
    }

    // Check 2: isSpotTradingAllowed must not be false
    if (symbolInfo.isSpotTradingAllowed === false) {
      const reason = 'SPOT_TRADING_NOT_ALLOWED';
      this.lastValidationError = reason;
      Logger.warn(
        'REAL',
        'BINANCE',
        `LIVE_ORDER_BLOCKED symbol=${cleanRaw} market=SPOT reason=${reason}`
      );
      return {
        requestedSymbol: cleanRaw,
        normalizedSymbol: targetSymbol,
        exists: true,
        status: symbolInfo.status,
        tradable: false,
        isSpotTradingAllowed: false,
        baseAsset: symbolInfo.baseAsset,
        quoteAsset: symbolInfo.quoteAsset,
        permissions: symbolInfo.permissions,
        filters: symbolInfo.filters,
        reason,
        fetchedAt: this.spotCache.fetchedAt,
      };
    }

    // Check 3: Permissions must include SPOT if permissions list is provided
    if (
      Array.isArray(symbolInfo.permissions) &&
      symbolInfo.permissions.length > 0 &&
      !symbolInfo.permissions.includes('SPOT') &&
      !symbolInfo.permissions.includes('TRD_GRP_001')
    ) {
      const reason = 'SPOT_PERMISSION_MISSING';
      this.lastValidationError = reason;
      Logger.warn(
        'REAL',
        'BINANCE',
        `LIVE_ORDER_BLOCKED symbol=${cleanRaw} market=SPOT reason=${reason}`
      );
      return {
        requestedSymbol: cleanRaw,
        normalizedSymbol: targetSymbol,
        exists: true,
        status: symbolInfo.status,
        tradable: false,
        isSpotTradingAllowed: symbolInfo.isSpotTradingAllowed ?? true,
        baseAsset: symbolInfo.baseAsset,
        quoteAsset: symbolInfo.quoteAsset,
        permissions: symbolInfo.permissions,
        filters: symbolInfo.filters,
        reason,
        fetchedAt: this.spotCache.fetchedAt,
      };
    }

    // Check 4: Quote asset must be USDT
    if (symbolInfo.quoteAsset !== 'USDT') {
      const reason = 'INVALID_QUOTE_ASSET';
      this.lastValidationError = reason;
      Logger.warn(
        'REAL',
        'BINANCE',
        `LIVE_ORDER_BLOCKED symbol=${cleanRaw} market=SPOT reason=${reason} (quoteAsset: ${symbolInfo.quoteAsset})`
      );
      return {
        requestedSymbol: cleanRaw,
        normalizedSymbol: targetSymbol,
        exists: true,
        status: symbolInfo.status,
        tradable: false,
        isSpotTradingAllowed: symbolInfo.isSpotTradingAllowed ?? true,
        baseAsset: symbolInfo.baseAsset,
        quoteAsset: symbolInfo.quoteAsset,
        permissions: symbolInfo.permissions,
        filters: symbolInfo.filters,
        reason,
        fetchedAt: this.spotCache.fetchedAt,
      };
    }

    // All validation passed
    this.lastValidationError = null;
    return {
      requestedSymbol: cleanRaw,
      normalizedSymbol: targetSymbol,
      exists: true,
      status: 'TRADING',
      tradable: true,
      isSpotTradingAllowed: true,
      baseAsset: symbolInfo.baseAsset,
      quoteAsset: symbolInfo.quoteAsset,
      permissions: symbolInfo.permissions,
      filters: symbolInfo.filters,
      reason: null,
      fetchedAt: this.spotCache.fetchedAt,
    };
  }

  /**
   * Generalized validator method
   */
  public async validateSymbol(
    rawSymbol: string,
    market: MarketType = 'SPOT',
    forceRefresh = false
  ): Promise<SymbolValidationResult> {
    if (market === 'SPOT') {
      const spotRes = await this.validateSpotSymbol(rawSymbol, forceRefresh);
      return {
        requestedSymbol: spotRes.requestedSymbol,
        normalizedSymbol: spotRes.normalizedSymbol,
        market: 'SPOT',
        exists: spotRes.exists,
        status: spotRes.status,
        tradable: spotRes.tradable,
        isSpotTradingAllowed: spotRes.isSpotTradingAllowed,
        permissions: spotRes.permissions,
        reason: spotRes.reason,
        baseAsset: spotRes.baseAsset,
        quoteAsset: spotRes.quoteAsset,
        filters: spotRes.filters,
        lastUpdated: spotRes.fetchedAt,
        fetchedAt: spotRes.fetchedAt,
      };
    }

    // Futures validation fallback
    const normalizer = BinanceSymbolNormalizer.getInstance();
    const normalized = normalizer.normalize(rawSymbol);
    const targetSymbol = normalized.normalizedSymbol;

    await this.ensureFreshMetadata('USDM_FUTURES', forceRefresh);
    const cache = this.futuresCache;

    if (!cache || !cache.symbolsMap || cache.symbolsMap.size === 0) {
      return {
        requestedSymbol: rawSymbol,
        normalizedSymbol: targetSymbol,
        market: 'USDM_FUTURES',
        exists: false,
        status: null,
        tradable: false,
        reason: 'EXCHANGE_METADATA_UNAVAILABLE',
      };
    }

    const symbolInfo = cache.symbolsMap.get(targetSymbol);
    if (!symbolInfo) {
      return {
        requestedSymbol: rawSymbol,
        normalizedSymbol: targetSymbol,
        market: 'USDM_FUTURES',
        exists: false,
        status: null,
        tradable: false,
        reason: 'SYMBOL_NOT_TRADABLE',
      };
    }

    const isTradable = symbolInfo.status === 'TRADING';
    return {
      requestedSymbol: rawSymbol,
      normalizedSymbol: targetSymbol,
      market: 'USDM_FUTURES',
      exists: true,
      status: symbolInfo.status,
      tradable: isTradable,
      reason: isTradable ? null : `SYMBOL_STATUS_${symbolInfo.status}`,
      baseAsset: symbolInfo.baseAsset,
      quoteAsset: symbolInfo.quoteAsset,
      filters: symbolInfo.filters,
      lastUpdated: cache.fetchedAt,
    };
  }

  /**
   * Retrieves live filters for a symbol on Spot.
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
        reason: `QUANTITY_BELOW_MIN (Floored ${numericQty} < Min ${filters.minQty})`,
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
   * Returns current Spot Market metadata summary for dashboard/telemetry.
   */
  public getSpotMarketTelemetry(): {
    spotMarketAvailable: boolean;
    symbolsCount: number;
    lastExchangeInfoRefresh: number;
    lastSymbolValidationTime: number;
    lastValidatedSymbol?: string;
    lastValidationError?: string | null;
  } {
    return {
      spotMarketAvailable: !!this.spotCache && this.spotCache.symbolsMap.size > 0,
      symbolsCount: this.spotCache?.symbolsMap.size || 0,
      lastExchangeInfoRefresh: this.spotCache?.fetchedAt || 0,
      lastSymbolValidationTime: this.lastValidationTime,
      lastValidatedSymbol: this.lastValidatedSymbol,
      lastValidationError: this.lastValidationError,
    };
  }

  /**
   * Ensures metadata cache is fresh; fetches if expired, missing, or explicitly forced.
   */
  public async ensureFreshMetadata(market: MarketType, forceRefresh = false): Promise<void> {
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
        const isTradable = s.status === 'TRADING' && (s.isSpotTradingAllowed !== false);
        const parsedFilters = this.extractFilters(s.filters || []);
        const permissions = Array.isArray(s.permissions) ? s.permissions : ['SPOT'];

        symbolsMap.set(symbolKey, {
          symbol: symbolKey,
          status: s.status,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          isSpotTradingAllowed: s.isSpotTradingAllowed ?? true,
          permissions,
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
    Logger.info('REAL', 'BINANCE', `[VALIDATION] Invalidated Binance ${market || 'all'} market metadata cache.`);
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
