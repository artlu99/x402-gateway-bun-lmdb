import { type Database, open, type RootDatabase } from 'lmdb';
import type { IdempotencyCache, NonceData } from '../types';

// ============================================================
// LMDB store for x402 payment gateway
//
// Used for:
//   1. Nonce tracking (replay attack prevention)
//   2. Payment-identifier idempotency (duplicate charge prevention)
//
// All keys are prefixed with "x402:"
//
// NOTE: TTL is implemented via lazy expiry (checked on read).
// Expired entries may accumulate until accessed, but storage
// impact is minimal given the small size of nonce entries.
// ============================================================

interface NonceEntry {
  data: NonceData;
  expiresAt: number;
}

interface IdempotencyEntry {
  data: IdempotencyCache;
  expiresAt: number;
}

// Initialize LMDB store
const store: RootDatabase = open({
  path: process.env.LMDB_PATH ?? './data/store',
  maxDbs: 2,
});

// Open sub-databases for nonces and idempotency
const nonceDb: Database<NonceEntry, string> = store.openDB({ name: 'nonces' });
const idempotencyDb: Database<IdempotencyEntry, string> = store.openDB({ name: 'idempotency' });

// ─── Key Prefixes ──────────────────────────────────────────
export const NONCE_PREFIX = 'x402:nonce:';
export const IDEMPOTENCY_PREFIX = 'x402:idempotency:';

// ─── TTLs (seconds) ────────────────────────────────────────
export const NONCE_PENDING_TTL = 3600;        // 1 hour for pending settlements
export const NONCE_CONFIRMED_TTL = 604800;    // 7 days for confirmed settlements
export const IDEMPOTENCY_TTL = 3600;          // 1 hour for cached responses

// ─── Helper: Get with lazy expiry check ────────────────────
async function getWithExpiry<T extends { expiresAt: number; data: unknown }>(
  db: Database<T, string>,
  key: string
): Promise<T['data'] | null> {
  const entry = await db.get(key);
  if (!entry) return null;

  // Check if expired
  if (Date.now() > entry.expiresAt) {
    await db.remove(key);
    return null;
  }

  return entry.data;
}

// ============================================================
// Nonce Operations — Replay Attack Prevention
// ============================================================

/**
 * Check if a nonce has already been used.
 * Returns the stored data if used, null if available.
 */
export async function getNonce(nonce: string): Promise<NonceData | null> {
  try {
    return await getWithExpiry(nonceDb, `${NONCE_PREFIX}${nonce}`);
  } catch (err) {
    const error = err as Error;
    console.error('[lmdb] getNonce error:', error.message);
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
    const key = `${NONCE_PREFIX}${nonce}`;
    const entry: NonceEntry = {
      data: { status: 'pending', timestamp: Date.now(), ...metadata } as NonceData,
      expiresAt: Date.now() + NONCE_PENDING_TTL * 1000,
    };
    // Use transaction for atomicity — check if key exists before setting
    return await nonceDb.transaction(() => {
      const existing = nonceDb.get(key);
      if (existing !== undefined) {
        return false; // Key exists, nonce already used
      }
      nonceDb.putSync(key, entry);
      return true;
    });
  } catch (err) {
    const error = err as Error;
    console.error('[lmdb] setNoncePending error:', error.message);
    return false; // Fail closed — reject payment to be safe
  }
}

/**
 * Mark a nonce as confirmed after successful settlement.
 */
export async function setNonceConfirmed(nonce: string, settlementData: Record<string, unknown> = {}): Promise<void> {
  try {
    const key = `${NONCE_PREFIX}${nonce}`;
    const entry: NonceEntry = {
      data: { status: 'confirmed', timestamp: Date.now(), ...settlementData } as NonceData,
      expiresAt: Date.now() + NONCE_CONFIRMED_TTL * 1000,
    };
    await nonceDb.put(key, entry);
  } catch (err) {
    const error = err as Error;
    console.error('[lmdb] setNonceConfirmed error:', error.message);
  }
}

/**
 * Delete a nonce (e.g., if settlement fails and we want to allow retry).
 */
export async function deleteNonce(nonce: string): Promise<void> {
  try {
    await nonceDb.remove(`${NONCE_PREFIX}${nonce}`);
  } catch (err) {
    const error = err as Error;
    console.error('[lmdb] deleteNonce error:', error.message);
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
    return await getWithExpiry(idempotencyDb, `${IDEMPOTENCY_PREFIX}${paymentId}`);
  } catch (err) {
    const error = err as Error;
    console.error('[lmdb] getIdempotencyCache error:', error.message);
    return null;
  }
}

/**
 * Cache a response for a payment identifier after successful settlement.
 */
export async function setIdempotencyCache(paymentId: string, responseData: Record<string, unknown>): Promise<void> {
  try {
    const key = `${IDEMPOTENCY_PREFIX}${paymentId}`;
    const entry: IdempotencyEntry = {
      data: { timestamp: Date.now(), response: responseData },
      expiresAt: Date.now() + IDEMPOTENCY_TTL * 1000,
    };
    await idempotencyDb.put(key, entry);
  } catch (err) {
    const error = err as Error;
    console.error('[lmdb] setIdempotencyCache error:', error.message);
  }
}

// ============================================================
// Health Check
// ============================================================

export async function pingStore(): Promise<boolean> {
  try {
    // LMDB is always available if we got this far
    return true;
  } catch (err) {
    const error = err as Error;
    console.error('[lmdb] ping error:', error.message);
    return false;
  }
}

// Export store for advanced usage
export default store;
