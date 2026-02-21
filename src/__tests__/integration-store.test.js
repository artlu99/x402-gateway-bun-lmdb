// Integration tests for LMDB store utilities.
// LMDB is always available locally, no external service needed.
//
// Run with: bun test src/__tests__/integration-store.test.js

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

// Import store module
import {
	deleteNonce,
	getIdempotencyCache,
	getNonce,
	IDEMPOTENCY_PREFIX,
	NONCE_PREFIX,
	pingStore,
	setIdempotencyCache,
	setNonceConfirmed,
	setNoncePending,
} from "../utils/store";

// Verify store is ready before running tests
beforeAll(async () => {
	const available = await pingStore();
	if (!available) {
		throw new Error("LMDB store is not available.");
	}

	console.log("[lmdb-integration] LMDB store initialized successfully");
});

// Helper to generate unique test keys
function uniqueKey(prefix = "test") {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Track keys created during tests for cleanup
const createdKeys = new Set();

describe("LMDB Integration Tests", () => {
	afterAll(async () => {
		// Clean up all keys created during tests
		console.log(
			`[lmdb-integration] Cleaning up ${createdKeys.size} test keys...`,
		);

		for (const key of createdKeys) {
			try {
				// Extract the nonce/paymentId from the full key
				if (key.startsWith(NONCE_PREFIX)) {
					await deleteNonce(key.slice(NONCE_PREFIX.length));
				}
				// Note: No deleteIdempotencyCache function exists, entries will expire naturally
			} catch {
				// Ignore cleanup errors
			}
		}
		createdKeys.clear();
	});

	describe("pingStore", () => {
		test("should return true when LMDB is available", async () => {
			const result = await pingStore();
			expect(result).toBe(true);
		});
	});

	describe("Nonce Operations", () => {
		let testNonce;

		beforeEach(() => {
			testNonce = uniqueKey("nonce");
			createdKeys.add(`${NONCE_PREFIX}${testNonce}`);
		});

		test("getNonce should return null for non-existent nonce", async () => {
			const result = await getNonce(testNonce);
			expect(result).toBeNull();
		});

		test("setNoncePending should set nonce and return true", async () => {
			const metadata = {
				network: "eip155:8453",
				payer: "0x1234567890123456789012345678901234567890",
				route: "test-route",
				vm: "evm",
			};

			const result = await setNoncePending(testNonce, metadata);
			expect(result).toBe(true);

			// Verify the nonce was set
			const stored = await getNonce(testNonce);
			expect(stored).not.toBeNull();
			expect(stored.status).toBe("pending");
			expect(stored.network).toBe("eip155:8453");
			expect(stored.payer).toBe("0x1234567890123456789012345678901234567890");
			expect(stored.route).toBe("test-route");
			expect(stored.vm).toBe("evm");
			expect(stored.timestamp).toBeDefined();
			expect(typeof stored.timestamp).toBe("number");
		});

		test("setNoncePending should return false for duplicate nonce", async () => {
			// Set nonce first time
			const result1 = await setNoncePending(testNonce, { payer: "0xabc" });
			expect(result1).toBe(true);

			// Try to set same nonce again
			const result2 = await setNoncePending(testNonce, { payer: "0xdef" });
			expect(result2).toBe(false);

			// Verify original data is preserved
			const stored = await getNonce(testNonce);
			expect(stored.payer).toBe("0xabc"); // Should still be original
		});

		test("setNonceConfirmed should update nonce status", async () => {
			// First set as pending
			await setNoncePending(testNonce, { payer: "0xabc" });

			// Then confirm it (must include all desired metadata)
			const settlementData = {
				txHash: "0xtxhash123456789",
				network: "eip155:8453",
				blockNumber: 12345,
				payer: "0xabc", // Include payer in settlement data
			};

			await setNonceConfirmed(testNonce, settlementData);

			// Verify updated status
			const stored = await getNonce(testNonce);
			expect(stored.status).toBe("confirmed");
			expect(stored.txHash).toBe("0xtxhash123456789");
			expect(stored.blockNumber).toBe(12345);
			expect(stored.payer).toBe("0xabc");
		});

		test("deleteNonce should remove nonce", async () => {
			// Set nonce
			await setNoncePending(testNonce, { payer: "0xabc" });

			// Verify it exists
			let stored = await getNonce(testNonce);
			expect(stored).not.toBeNull();

			// Delete it
			await deleteNonce(testNonce);

			// Verify it's gone
			stored = await getNonce(testNonce);
			expect(stored).toBeNull();
		});
	});

	describe("Idempotency Operations", () => {
		let testPaymentId;

		beforeEach(() => {
			testPaymentId = uniqueKey("payment");
			createdKeys.add(`${IDEMPOTENCY_PREFIX}${testPaymentId}`);
		});

		test("getIdempotencyCache should return null for non-existent entry", async () => {
			const result = await getIdempotencyCache(testPaymentId);
			expect(result).toBeNull();
		});

		test("setIdempotencyCache should store response", async () => {
			const responseData = {
				paymentResponseHeader: Buffer.from(
					JSON.stringify({ txHash: "0xabc" }),
				).toString("base64"),
				settlement: {
					success: true,
					txHash: "0xabc123",
					network: "eip155:8453",
				},
			};

			await setIdempotencyCache(testPaymentId, responseData);

			// Retrieve and verify
			const cached = await getIdempotencyCache(testPaymentId);
			expect(cached).not.toBeNull();
			expect(cached.timestamp).toBeDefined();
			expect(cached.response.paymentResponseHeader).toBe(
				responseData.paymentResponseHeader,
			);
			expect(cached.response.settlement.txHash).toBe("0xabc123");
		});

		test("idempotency cache should return same data on repeated calls", async () => {
			const responseData = {
				paymentResponseHeader: "test-header",
				value: 12345,
			};

			await setIdempotencyCache(testPaymentId, responseData);

			// Retrieve multiple times
			const result1 = await getIdempotencyCache(testPaymentId);
			const result2 = await getIdempotencyCache(testPaymentId);

			expect(result1.response).toEqual(result2.response);
			expect(result1.timestamp).toBe(result2.timestamp);
		});
	});

	describe("Full Payment Flow Simulation", () => {
		test("should handle complete nonce lifecycle", async () => {
			const nonce = uniqueKey("lifecycle");
			const paymentId = uniqueKey("flow");
			createdKeys.add(`${NONCE_PREFIX}${nonce}`);
			createdKeys.add(`${IDEMPOTENCY_PREFIX}${paymentId}`);

			// 1. Check nonce doesn't exist
			const initialCheck = await getNonce(nonce);
			expect(initialCheck).toBeNull();

			// 2. Set nonce as pending (before settlement)
			const pendingResult = await setNoncePending(nonce, {
				network: "eip155:8453",
				payer: "0xpayer123",
				route: "myapi",
				vm: "evm",
			});
			expect(pendingResult).toBe(true);

			// 3. Verify pending state
			const pendingData = await getNonce(nonce);
			expect(pendingData.status).toBe("pending");

			// 4. Simulate successful settlement
			await setNonceConfirmed(nonce, {
				txHash: "0xsettlementhash",
				blockNumber: 99999,
			});

			// 5. Verify confirmed state
			const confirmedData = await getNonce(nonce);
			expect(confirmedData.status).toBe("confirmed");
			expect(confirmedData.txHash).toBe("0xsettlementhash");

			// 6. Cache the response for idempotency
			await setIdempotencyCache(paymentId, {
				paymentResponseHeader: Buffer.from(
					JSON.stringify({
						success: true,
						txHash: "0xsettlementhash",
					}),
				).toString("base64"),
			});

			// 7. Verify idempotency cache
			const cached = await getIdempotencyCache(paymentId);
			expect(cached).not.toBeNull();
			expect(cached.response.paymentResponseHeader).toBeDefined();

			// 8. Verify duplicate nonce is rejected
			const duplicateResult = await setNoncePending(nonce, {
				network: "eip155:8453",
				payer: "0xother",
			});
			expect(duplicateResult).toBe(false);
		});

		test("should allow retry after deleting failed nonce", async () => {
			const nonce = uniqueKey("retry");
			createdKeys.add(`${NONCE_PREFIX}${nonce}`);

			// 1. Set pending
			await setNoncePending(nonce, { payer: "0xpayer" });

			// 2. Simulate settlement failure - delete nonce to allow retry
			await deleteNonce(nonce);

			// 3. Verify nonce is gone
			const afterDelete = await getNonce(nonce);
			expect(afterDelete).toBeNull();

			// 4. Should be able to set pending again
			const retryResult = await setNoncePending(nonce, { payer: "0xpayer" });
			expect(retryResult).toBe(true);
		});
	});

	describe("Edge Cases", () => {
		test("should handle empty metadata", async () => {
			const nonce = uniqueKey("empty");
			createdKeys.add(`${NONCE_PREFIX}${nonce}`);

			const result = await setNoncePending(nonce, {});
			expect(result).toBe(true);

			const stored = await getNonce(nonce);
			expect(stored.status).toBe("pending");
			expect(stored.timestamp).toBeDefined();
		});

		test("should handle special characters in nonce", async () => {
			const nonce = `special-chars_123/${uniqueKey()}`;
			createdKeys.add(`${NONCE_PREFIX}${nonce}`);

			const result = await setNoncePending(nonce, { payer: "0xabc" });
			expect(result).toBe(true);

			const stored = await getNonce(nonce);
			expect(stored).not.toBeNull();
		});

		test("should handle large metadata objects", async () => {
			const nonce = uniqueKey("large");
			createdKeys.add(`${NONCE_PREFIX}${nonce}`);

			const largeMetadata = {
				network: "eip155:8453",
				payer: "0xpayer",
				route: "test",
				vm: "evm",
				extraData: {
					array: new Array(100).fill("test-data"),
					nested: { deep: { value: "test" } },
				},
			};

			const result = await setNoncePending(nonce, largeMetadata);
			expect(result).toBe(true);

			const stored = await getNonce(nonce);
			expect(stored.extraData.array).toHaveLength(100);
			expect(stored.extraData.nested.deep.value).toBe("test");
		});
	});
});
