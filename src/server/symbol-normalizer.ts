import { SymbolNormalizationResult } from '../types/index.ts';
import { Logger } from './logger.ts';

/**
 * Known legacy to current Binance base asset migration map.
 * Format: LEGACY_BASE_ASSET -> CURRENT_BASE_ASSET
 */
export const ASSET_MIGRATION_MAP: Readonly<Record<string, string>> = {
  RNDR: 'RENDER',
  COCOS: 'COMBO',
  POLY: 'POLYX',
  TOMO: 'VIC',
  // Direct identity mappings or other known migrations
  TON: 'TON',
  RENDER: 'RENDER',
  COMBO: 'COMBO',
  POLYX: 'POLYX',
  VIC: 'VIC',
};

const KNOWN_QUOTE_ASSETS = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];

export class BinanceSymbolNormalizer {
  private static instance: BinanceSymbolNormalizer;

  private constructor() {}

  public static getInstance(): BinanceSymbolNormalizer {
    if (!BinanceSymbolNormalizer.instance) {
      BinanceSymbolNormalizer.instance = new BinanceSymbolNormalizer();
    }
    return BinanceSymbolNormalizer.instance;
  }

  /**
   * Normalizes a cryptocurrency symbol or pair deterministically.
   * Examples:
   * - "RNDRUSDT" -> "RENDERUSDT" (mapping: RNDR -> RENDER)
   * - "COCOSUSDT" -> "COMBOUSDT" (mapping: COCOS -> COMBO)
   * - "POLYUSDT" -> "POLYXUSDT" (mapping: POLY -> POLYX)
   * - "TOMOUSDT" -> "VICUSDT" (mapping: TOMO -> VIC)
   * - "TONUSDT" -> "TONUSDT" (no migration needed)
   * - "BTCUSDT" -> "BTCUSDT" (no migration needed)
   */
  public normalize(rawSymbol: string): SymbolNormalizationResult {
    if (!rawSymbol || typeof rawSymbol !== 'string') {
      return {
        originalSymbol: '',
        normalizedSymbol: '',
        baseAsset: '',
        quoteAsset: '',
        mappingApplied: false,
        mappingReason: null,
      };
    }

    const cleanInput = rawSymbol.trim().toUpperCase();

    // 1. Separate base and quote asset
    let baseAsset = cleanInput;
    let quoteAsset = '';

    for (const quote of KNOWN_QUOTE_ASSETS) {
      if (cleanInput.endsWith(quote) && cleanInput.length > quote.length) {
        baseAsset = cleanInput.slice(0, cleanInput.length - quote.length);
        quoteAsset = quote;
        break;
      }
    }

    // If no quote matched, assume input is a base asset alone (defaulting quote to empty)
    const migratedBase = ASSET_MIGRATION_MAP[baseAsset] || baseAsset;
    const mappingApplied = migratedBase !== baseAsset;

    const normalizedSymbol = quoteAsset ? `${migratedBase}${quoteAsset}` : migratedBase;
    const mappingReason = mappingApplied
      ? `Migration mapping applied: ${baseAsset} → ${migratedBase}`
      : null;

    if (mappingApplied) {
      Logger.info(
        'PAPER',
        'STRATEGY',
        `[SYMBOL] Normalized ${cleanInput} → ${normalizedSymbol} (${mappingReason})`
      );
    }

    return {
      originalSymbol: cleanInput,
      normalizedSymbol,
      baseAsset: migratedBase,
      quoteAsset,
      mappingApplied,
      mappingReason,
    };
  }

  /**
   * Fast helper to return the normalized pair string directly.
   */
  public normalizePair(rawSymbol: string): string {
    return this.normalize(rawSymbol).normalizedSymbol;
  }
}
