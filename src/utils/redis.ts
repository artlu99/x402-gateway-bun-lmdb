import { Redis } from '@upstash/redis';
import type { IdempotencyCache, NonceData } from '../types.js';

// ============================================================
// Upstash Redis client for x402 payment gateway
//
// Used for:
//   1. Nonce tracking (replay attack prevention)
//   2. Payment-identifier idempotency (duplicate charge prevention)
//
// All keys are prefixed with "x402:" to avoid conflicts
// with other services sharing the same Upstash instance.
//
// NOTE: Client is lazy-initialized on first use so that
// process.env values are available after dotenv.config() runs.
// ============================================================

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

// ─── Key Prefixes ──────────────────────────────────────────
export const NONCE_PREFIX = 'x402:nonce:';
export const IDEMPOTENCY_PREFIX = 'x402:idempotency:';

// ─── TTLs (seconds) ────────────────────────────────────────
export const NONCE_PENDING_TTL = 3600;        // 1 hour for pending settlements
export const NONCE_CONFIRMED_TTL = 604800;    // 7 days for confirmed settlements
export const IDEMPOTENCY_TTL = 3600;          // 1 hour for cached responses

// ============================================================
// Nonce Operations — Replay Attack Prevention
// ============================================================

/**
 * Check if a nonce has already been used.
 * Returns the stored data if used, null if available.
 */
export async function getNonce(nonce: string): Promise<NonceData | null> {
  try {
    const data = await getRedis().get<NonceData>(`${NONCE_PREFIX}${nonce}`);
    return data ?? null;
  } catch (err) {
    const error = err as Error;
    console.error('[redis] getNonce error:', error.message);
    return null; // Fail open — settlement still checks on-chain
  }
}

/**
 * Mark a nonce as pending (before settlement attempt).
 * Short TTL so it auto-cleans if settlement never completes.
 * Returns true if set (nonce was available), false if already exists (replay).
 */
export async function setNoncePending(nonce: string, metadata: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const result = await getRedis().set(
      `${NONCE_PREFIX}${nonce}`,
      { status: 'pending', timestamp: Date.now(), ...metadata },
      { nx: true, ex: NONCE_PENDING_TTL }
    );
    return result === 'OK';
  } catch (err) {
    const error = err as Error;
    console.error('[redis] setNoncePending error:', error.message);
    return false; // Fail closed — reject payment to be safe
  }
}

/**
 * Mark a nonce as confirmed after successful settlement.
 */
export async function setNonceConfirmed(nonce: string, settlementData: Record<string, unknown> = {}): Promise<void> {
  try {
    await getRedis().set(
      `${NONCE_PREFIX}${nonce}`,
      { status: 'confirmed', timestamp: Date.now(), ...settlementData },
      { ex: NONCE_CONFIRMED_TTL }
    );
  } catch (err) {
    const error = err as Error;
    console.error('[redis] setNonceConfirmed error:', error.message);
  }
}

/**
 * Delete a nonce (e.g., if settlement fails and we want to allow retry).
 */
export async function deleteNonce(nonce: string): Promise<void> {
  try {
    await getRedis().del(`${NONCE_PREFIX}${nonce}`);
  } catch (err) {
    const error = err as Error;
    console.error('[redis] deleteNonce error:', error.message);
  }
}

// ============================================================
// Idempotency Operations — Payment-Identifier Extension
// ============================================================

/**
 * Get a cached response for a payment identifier.
 */
export async function getIdempotencyCache(paymentId: string): Promise<IdempotencyCache | null> {
  try {
    const data = await getRedis().get<IdempotencyCache>(`${IDEMPOTENCY_PREFIX}${paymentId}`);
    return data ?? null;
  } catch (err) {
    const error = err as Error;
    console.error('[redis] getIdempotencyCache error:', error.message);
    return null;
  }
}

/**
 * Cache a response for a payment identifier after successful settlement.
 */
export async function setIdempotencyCache(paymentId: string, responseData: Record<string, unknown>): Promise<void> {
  try {
    await getRedis().set(
      `${IDEMPOTENCY_PREFIX}${paymentId}`,
      { timestamp: Date.now(), response: responseData },
      { ex: IDEMPOTENCY_TTL }
    );
  } catch (err) {
    const error = err as Error;
    console.error('[redis] setIdempotencyCache error:', error.message);
  }
}

// ============================================================
// Health Check
// ============================================================

export async function pingRedis(): Promise<boolean> {
  try {
    const result = await getRedis().ping();
    return result === 'PONG';
  } catch (err) {
    const error = err as Error;
    console.error('[redis] ping error:', error.message);
    return false;
  }
}

export default getRedis;
