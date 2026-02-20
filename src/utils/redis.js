// src/utils/redis.js

import { Redis } from '@upstash/redis';

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

let _redis = null;

function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

// ─── Key Prefixes ──────────────────────────────────────────
const NONCE_PREFIX = 'x402:nonce:';
const IDEMPOTENCY_PREFIX = 'x402:idempotency:';

// ─── TTLs (seconds) ────────────────────────────────────────
const NONCE_PENDING_TTL = 3600;        // 1 hour for pending settlements
const NONCE_CONFIRMED_TTL = 604800;    // 7 days for confirmed settlements
const IDEMPOTENCY_TTL = 3600;          // 1 hour for cached responses

// ============================================================
// Nonce Operations — Replay Attack Prevention
// ============================================================

/**
 * Check if a nonce has already been used.
 * Returns the stored data if used, null if available.
 */
export async function getNonce(nonce) {
  try {
    const data = await getRedis().get(`${NONCE_PREFIX}${nonce}`);
    return data || null;
  } catch (err) {
    console.error('[redis] getNonce error:', err.message);
    return null; // Fail open — settlement still checks on-chain
  }
}

/**
 * Mark a nonce as pending (before settlement attempt).
 * Short TTL so it auto-cleans if settlement never completes.
 * Returns true if set (nonce was available), false if already exists (replay).
 */
export async function setNoncePending(nonce, metadata = {}) {
  try {
    const result = await getRedis().set(
      `${NONCE_PREFIX}${nonce}`,
      { status: 'pending', timestamp: Date.now(), ...metadata },
      { nx: true, ex: NONCE_PENDING_TTL }
    );
    return result === 'OK';
  } catch (err) {
    console.error('[redis] setNoncePending error:', err.message);
    return false; // Fail closed — reject payment to be safe
  }
}

/**
 * Mark a nonce as confirmed after successful settlement.
 */
export async function setNonceConfirmed(nonce, settlementData = {}) {
  try {
    await getRedis().set(
      `${NONCE_PREFIX}${nonce}`,
      { status: 'confirmed', timestamp: Date.now(), ...settlementData },
      { ex: NONCE_CONFIRMED_TTL }
    );
  } catch (err) {
    console.error('[redis] setNonceConfirmed error:', err.message);
  }
}

/**
 * Delete a nonce (e.g., if settlement fails and we want to allow retry).
 */
export async function deleteNonce(nonce) {
  try {
    await getRedis().del(`${NONCE_PREFIX}${nonce}`);
  } catch (err) {
    console.error('[redis] deleteNonce error:', err.message);
  }
}

// ============================================================
// Idempotency Operations — Payment-Identifier Extension
// ============================================================

/**
 * Get a cached response for a payment identifier.
 */
export async function getIdempotencyCache(paymentId) {
  try {
    const data = await getRedis().get(`${IDEMPOTENCY_PREFIX}${paymentId}`);
    return data || null;
  } catch (err) {
    console.error('[redis] getIdempotencyCache error:', err.message);
    return null;
  }
}

/**
 * Cache a response for a payment identifier after successful settlement.
 */
export async function setIdempotencyCache(paymentId, responseData) {
  try {
    await getRedis().set(
      `${IDEMPOTENCY_PREFIX}${paymentId}`,
      { timestamp: Date.now(), response: responseData },
      { ex: IDEMPOTENCY_TTL }
    );
  } catch (err) {
    console.error('[redis] setIdempotencyCache error:', err.message);
  }
}

// ============================================================
// Health Check
// ============================================================

export async function pingRedis() {
  try {
    const result = await getRedis().ping();
    return result === 'PONG';
  } catch (err) {
    console.error('[redis] ping error:', err.message);
    return false;
  }
}

export default getRedis;
