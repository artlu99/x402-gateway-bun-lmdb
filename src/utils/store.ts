import { type Database, open, type RootDatabase } from "lmdb";
import invariant from "tiny-invariant";
import type { IdempotencyCache, NonceData } from "../types";

// ============================================================
// LMDB store for x402 payment gateway
//
// Used for:
//   1. Nonce tracking (replay attack prevention)
//   2. Payment-identifier idempotency (duplicate charge prevention)
//   3. Credit system (backend failure compensation)
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

interface CreditEntry {
	data: number; // Credit "count" is the authoritative value
	expiresAt: number;
}

// Initialize LMDB store
const getStore: RootDatabase = open({
	path: process.env.LMDB_PATH ?? "./data/store",
	maxDbs: 3,
});

// Open sub-databases for nonces and idempotency
const nonceDb: Database<NonceEntry, string> = getStore.openDB({ name: "nonces" });
const idempotencyDb: Database<IdempotencyEntry, string> = getStore.openDB({
	name: "idempotency",
});
// credits sub-database uses optimistic locking for fast atomic updates
// without running a JS transaction callback on the main thread
const creditDb: Database<CreditEntry, string> = getStore.openDB({
	name: "credit",
	useVersions: true,
});

// ─── Key Prefixes ──────────────────────────────────────────
export const NONCE_PREFIX = "x402:nonce:";
export const IDEMPOTENCY_PREFIX = "x402:idempotency:";
export const CREDIT_PREFIX = "x402:credit:";

// ─── TTLs (seconds) ────────────────────────────────────────
export const NONCE_PENDING_TTL = 3600; // 1 hour for pending settlements
export const NONCE_CONFIRMED_TTL = 604800; // 7 days for confirmed settlements
export const IDEMPOTENCY_TTL = 3600; // 1 hour for cached responses

// ─── Helper: Get with lazy expiry check ────────────────────
async function getWithExpiry<T extends { expiresAt: number; data: unknown }>(
	db: Database<T, string>,
	key: string,
): Promise<T["data"] | null> {
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
		console.error("[lmdb] getNonce error:", error.message);
		return null; // Fail open — settlement still checks on-chain
	}
}

/**
 * Mark a nonce as pending (before settlement attempt).
 * Short TTL so it auto-cleans if settlement never completes.
 * Returns true if set (nonce was available), false if already exists (replay).
 */
export async function setNoncePending(
	nonce: string,
	metadata: Record<string, unknown> = {},
): Promise<boolean> {
	try {
		const key = `${NONCE_PREFIX}${nonce}`;
		const entry: NonceEntry = {
			data: {
				status: "pending",
				timestamp: Date.now(),
				...metadata,
			} as NonceData,
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
		console.error("[lmdb] setNoncePending error:", error.message);
		return false; // Fail closed — reject payment to be safe
	}
}

/**
 * Mark a nonce as confirmed after successful settlement.
 */
export async function setNonceConfirmed(
	nonce: string,
	settlementData: Record<string, unknown> = {},
): Promise<void> {
	try {
		const key = `${NONCE_PREFIX}${nonce}`;
		const entry: NonceEntry = {
			data: {
				status: "confirmed",
				timestamp: Date.now(),
				...settlementData,
			} as NonceData,
			expiresAt: Date.now() + NONCE_CONFIRMED_TTL * 1000,
		};
		await nonceDb.put(key, entry);
	} catch (err) {
		const error = err as Error;
		console.error("[lmdb] setNonceConfirmed error:", error.message);
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
		console.error("[lmdb] deleteNonce error:", error.message);
	}
}

// ============================================================
// Idempotency Operations — Payment-Identifier Extension
// ============================================================

/**
 * Get a cached response for a payment identifier.
 */
export async function getIdempotencyCache(
	paymentId: string,
): Promise<IdempotencyCache | null> {
	try {
		return await getWithExpiry(
			idempotencyDb,
			`${IDEMPOTENCY_PREFIX}${paymentId}`,
		);
	} catch (err) {
		const error = err as Error;
		console.error("[lmdb] getIdempotencyCache error:", error.message);
		return null;
	}
}

/**
 * Cache a response for a payment identifier after successful settlement.
 */
export async function setIdempotencyCache(
	paymentId: string,
	responseData: Record<string, unknown>,
): Promise<void> {
	try {
		const key = `${IDEMPOTENCY_PREFIX}${paymentId}`;
		const entry: IdempotencyEntry = {
			data: { timestamp: Date.now(), response: responseData },
			expiresAt: Date.now() + IDEMPOTENCY_TTL * 1000,
		};
		await idempotencyDb.put(key, entry);
	} catch (err) {
		const error = err as Error;
		console.error("[lmdb] setIdempotencyCache error:", error.message);
	}
}

// ============================================================
// Credit Operations — Backend Failure Compensation
//
// Credits are issued when a paid request settles on-chain but
// the backend returns a creditworthy error (e.g. 5xx).
// The payer can redeem credits on subsequent requests by
// presenting a valid payment signature (proves wallet ownership)
// without needing to settle on-chain again.
//
// Key format: x402:credit:{payerAddress}:{routeKey}
// Value: integer count of available credits
//
// Security: Payer address is extracted from the cryptographically
// verified EIP-712/SVM signature — cannot be spoofed.
//
// Degradation: All credit operations fail gracefully.
//   - Read failures → skip credits, proceed with normal payment
//   - Write failures → log and move on, agent misses one credit
// ============================================================

/**
 * Get credit count for a payer on a specific route.
 * Returns integer count (0 if no credits or on error).
 * Fails open — returns 0 on error so normal payment proceeds.
 */
export async function getCreditCount(payerAddress: string, routeKey: string): Promise<number> {
	try {
	  const key = `${CREDIT_PREFIX}${payerAddress.toLowerCase()}:${routeKey}`;
	  const count = await getWithExpiry(creditDb, key);
	  return typeof count === "number" ? count : 0;
	} catch (err) {
	  const error = err as Error;
	  console.error("[lmdb] getCreditCount error:", error.message);
	  return 0; // Fail open — no credits means normal payment flow
	}
  }
  
  /**
   * Atomically decrement a credit for a payer on a specific route.
   * Returns true if a credit was consumed, false if none available.
   *
   * Optimized LMDB version: optimistic locking (CAS) using record versions.
   */
  export async function decrementCredit(payerAddress: string, routeKey: string): Promise<boolean> {
	try {
	  const key = `${CREDIT_PREFIX}${payerAddress.toLowerCase()}:${routeKey}`;
	  // Retry on CAS conflicts (concurrent consumers)
	  for (let attempt = 0; attempt < 8; attempt += 1) {
		const entry = creditDb.getEntry(key);
		if (!entry) return false;
		const { value, version } = entry;
		invariant(version !== undefined, "Version is undefined");

		// Lazy expiry enforcement
		if (Date.now() > value.expiresAt) {
			await creditDb.remove(key, version);
			return false;
		}

		const current = typeof value.data === "number" ? value.data : 0;
		if (current <= 0) return false;

		const next = current - 1;
		if (next <= 0) {
			const removed = await creditDb.remove(key, version);
			if (removed) return true;
			continue;
		}

		const wrote = await creditDb.put(
			key,
			{ data: next, expiresAt: value.expiresAt },
			version + 1,
			version,
		);
		if (wrote) return true;
	  }

	  return false;
	} catch (err) {
	  const error = err as Error;
	  console.error("[lmdb] decrementCredit error:", error.message);
	  return false; // Fail closed — don't grant free access on error
	}
  }
  
  /**
   * Atomically increment a credit for a payer on a specific route,
   * capped at maxCredits. Resets TTL on every increment so credits
   * stay alive as long as failures keep occurring.
   *
   * @param {string} payerAddress - Wallet address of the payer
   * @param {string} routeKey - Route identifier (e.g. 'myapi')
   * @param {number} maxCredits - Maximum credits per payer per route
   * @param {number} ttlSeconds - TTL in seconds for the credit key
   * @returns {number} New credit count after increment, or -1 on error
   */
  export async function incrementCredit(
	payerAddress: string,
	routeKey: string,
	maxCredits: number,
	ttlSeconds: number,
  ): Promise<number> {
	try {
	  const key = `${CREDIT_PREFIX}${payerAddress.toLowerCase()}:${routeKey}`;
	  const cappedMax = Number.isFinite(maxCredits) && maxCredits > 0 ? maxCredits : 0;
	  const ttlMs = Math.max(0, ttlSeconds) * 1000;

	  for (let attempt = 0; attempt < 8; attempt += 1) {
		const now = Date.now();
		const expiresAt = now + ttlMs;

		const entry = creditDb.getEntry(key);
		if (!entry) {
			// Create if missing (atomic)
			const next = cappedMax > 0 ? 1 : 0;
			if (next <= 0) return 0;

			const created = await creditDb.ifNoExists(key, () => {
				// Enqueue put into the conditional transaction
				creditDb.put(key, { data: next, expiresAt }, 1);
			});
			if (created) return next;
			continue;
		}

		const { value, version } = entry;
		if (version === undefined) return -1;

		// If expired, try to clear it and retry as "missing"
		if (now > value.expiresAt) {
			await creditDb.remove(key, version);
			continue;
		}

		const current = typeof value.data === "number" ? value.data : 0;
		let next = current;
		if (next < cappedMax) next += 1;

		if (next <= 0) {
			await creditDb.remove(key, version);
			return 0;
		}

		// Always refresh TTL (even if already at cap)
		const wrote = await creditDb.put(
			key,
			{ data: next, expiresAt },
			version + 1,
			version,
		);
		if (wrote) return next;
	  }

	  return -1;
	} catch (err) {
	  const error = err as Error;
	  console.error("[lmdb] incrementCredit error:", error.message);
	  return -1; // Non-critical — agent misses one credit
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
		console.error("[lmdb] ping error:", error.message);
		return false;
	}
}

export default getStore;