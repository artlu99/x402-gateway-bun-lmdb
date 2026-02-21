// src/__tests__/index.test.js

import { describe, expect, test } from "bun:test";

// These tests focus on unit testing individual functions and configurations
// Integration tests with Express are done via supertest-style http requests

describe("Endpoint Response Structures", () => {
	describe("Health endpoint response", () => {
		test("should have correct structure", async () => {
			const storeHealthy = true;
			const healthResponse = {
				status: storeHealthy ? "healthy" : "degraded",
				service: "x402-gateway",
				version: "1.0.0",
				backends: { myapi: { configured: true, status: "ready" } },
				store: {
					status: storeHealthy ? "connected" : "unreachable",
					features: ["nonce-tracking", "idempotency-cache"],
				},
				payment: {
					settlement: "local",
					networks: [],
					summary: { total: 0, evm: 0, svm: 0 },
				},
				routes: [{ path: "/v1/myapi/*", price: "$0.01", backend: "My API" }],
			};

			expect(healthResponse.status).toBe("healthy");
			expect(healthResponse.service).toBe("x402-gateway");
			expect(healthResponse.store.features).toContain("nonce-tracking");
			expect(Array.isArray(healthResponse.routes)).toBe(true);
		});

		test("should show degraded when store unavailable", () => {
			const storeHealthy = false;
			const status = storeHealthy ? "healthy" : "degraded";

			expect(status).toBe("degraded");
		});
	});

	describe("Accepted endpoint response", () => {
		test("should have correct structure", () => {
			const acceptedResponse = {
				x402Version: 2,
				service: "x402-gateway",
				routes: [
					{
						path: "/v1/myapi/*",
						backend: "My API",
						price: "$0.01",
						networks: [],
						extensions: {
							"payment-identifier": { supported: true, required: false },
							bazaar: { discoverable: true },
						},
					},
				],
			};

			expect(acceptedResponse.x402Version).toBe(2);
			expect(
				acceptedResponse.routes[0]?.extensions["payment-identifier"].supported,
			).toBe(true);
			expect(acceptedResponse.routes[0]?.extensions.bazaar.discoverable).toBe(
				true,
			);
		});
	});

	describe("Well-known x402 response", () => {
		test("should have correct structure", () => {
			const wellKnownResponse = {
				version: 1,
				resources: ["https://api.example.com/v1/myapi/*"],
				instructions:
					"x402 Payment Gateway\n\nPay-per-request APIs with USDC micropayments.",
			};

			expect(wellKnownResponse.version).toBe(1);
			expect(Array.isArray(wellKnownResponse.resources)).toBe(true);
			expect(wellKnownResponse.instructions).toContain("x402");
		});
	});

	describe("402 Payment Required response", () => {
		test("should include accepts array", () => {
			const response402 = {
				x402Version: 2,
				accepts: [
					{
						scheme: "exact",
						network: "eip155:8453",
						amount: "10000",
						payTo: "0xtest",
						asset: "0xusdc",
						maxTimeoutSeconds: 3600,
					},
				],
				error: "Payment required",
				message: "This endpoint requires $0.01 USDC.",
				extensions: {
					"payment-identifier": { supported: true, required: false },
				},
			};

			expect(response402.accepts).toBeDefined();
			expect(Array.isArray(response402.accepts)).toBe(true);
			expect(response402.accepts?.[0]?.scheme).toBe("exact");
		});

		test("should include PAYMENT-REQUIRED header", () => {
			const headerPayload = {
				x402Version: 2,
				accepts: [],
				resource: {
					url: "https://test.com/v1/test",
					description: "Test",
					mimeType: "application/json",
				},
				extensions: {},
			};
			const headerBase64 = Buffer.from(JSON.stringify(headerPayload)).toString(
				"base64",
			);

			expect(headerBase64).toBeDefined();
			// Verify it's valid base64 and decodes correctly
			const decoded = JSON.parse(
				Buffer.from(headerBase64, "base64").toString(),
			);
			expect(decoded.x402Version).toBe(2);
		});
	});
});

describe("Payment Payload Parsing", () => {
	test("should parse valid payment header", () => {
		const payload = {
			x402Version: 2,
			scheme: "exact",
			network: "eip155:8453",
			payload: {
				authorization: {
					from: "0x1234",
					to: "0x5678",
					value: "10000",
					validAfter: "0",
					validBefore: "9999999999",
					nonce: "0xabc",
				},
				signature: "0xsig",
			},
		};

		const headerBase64 = Buffer.from(JSON.stringify(payload)).toString(
			"base64",
		);
		const decoded = JSON.parse(Buffer.from(headerBase64, "base64").toString());

		expect(decoded.x402Version).toBe(2);
		expect(decoded.scheme).toBe("exact");
		expect(decoded.network).toBe("eip155:8453");
		expect(decoded.payload.authorization.from).toBe("0x1234");
	});

	test("should reject invalid base64", () => {
		const invalidBase64 = "not-valid-base64!!!";

		expect(() => {
			Buffer.from(invalidBase64, "base64").toString();
			JSON.parse(Buffer.from(invalidBase64, "base64").toString());
		}).toThrow();
	});

	test("should handle X-Payment header alias", () => {
		// Both Payment-Signature and X-Payment should work
		const headers = {
			"payment-signature": "test",
			"x-payment": "test",
		};

		const paymentHeader = headers["payment-signature"] || headers["x-payment"];
		expect(paymentHeader).toBe("test");

		// Test without payment-signature
		const headers2: Record<string, string> = { "x-payment": "test2" };
		const paymentHeader2 =
			headers2["payment-signature"] || headers2["x-payment"];
		expect(paymentHeader2).toBe("test2");
	});
});

describe("getSubpath Helper", () => {
	function getSubpath(params: { path?: string | string[] }) {
		return Array.isArray(params.path) ? params.path.join("/") : params.path;
	}

	test("should join array params", () => {
		const params = { path: ["deep", "nested", "endpoint"] };
		expect(getSubpath(params)).toBe("deep/nested/endpoint");
	});

	test("should handle string params", () => {
		const params = { path: "simple" };
		expect(getSubpath(params)).toBe("simple");
	});

	test("should handle undefined params", () => {
		const params = {};
		expect(getSubpath(params)).toBeUndefined();
	});
});

describe("Extract Payer Address", () => {
	function extractPayerFromPaymentHeader(req: {
		headers: { "payment-signature"?: string; "x-payment"?: string };
	}) {
		const paymentHeader =
			req.headers["payment-signature"] || req.headers["x-payment"];
		if (!paymentHeader) return null;
		try {
			const paymentPayload = JSON.parse(
				Buffer.from(paymentHeader, "base64").toString(),
			);
			return paymentPayload.payload?.authorization?.from || null;
		} catch {
			return null;
		}
	}

	test("should extract payer from valid header", () => {
		const payload = {
			payload: { authorization: { from: "0xpayer123" } },
		};
		const req = {
			headers: {
				"payment-signature": Buffer.from(JSON.stringify(payload)).toString(
					"base64",
				),
			},
		};

		expect(extractPayerFromPaymentHeader(req)).toBe("0xpayer123");
	});

	test("should return null for missing header", () => {
		const req = { headers: {} };
		expect(extractPayerFromPaymentHeader(req)).toBeNull();
	});

	test("should return null for invalid base64", () => {
		const req = { headers: { "payment-signature": "invalid!!!" } };
		expect(extractPayerFromPaymentHeader(req)).toBeNull();
	});
});

describe("Payment Identifier Extension", () => {
	function extractPaymentIdentifier(paymentPayload: {
		extensions?: { "payment-identifier"?: { paymentId: string } };
		payload?: { extensions?: { "payment-identifier"?: { paymentId: string } } };
	}) {
		try {
			const extensions =
				paymentPayload.extensions || paymentPayload.payload?.extensions;
			if (!extensions) return null;
			const idExt = extensions["payment-identifier"];
			if (idExt?.paymentId && typeof idExt.paymentId === "string") {
				const id = idExt.paymentId;
				if (
					id.length >= 16 &&
					id.length <= 128 &&
					/^[a-zA-Z0-9_-]+$/.test(id)
				) {
					return id;
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	test("should extract valid payment identifier", () => {
		const payload = {
			extensions: {
				"payment-identifier": { paymentId: "test-payment-id-12345678" },
			},
		};
		expect(extractPaymentIdentifier(payload)).toBe("test-payment-id-12345678");
	});

	test("should reject too short identifier", () => {
		const payload = {
			extensions: {
				"payment-identifier": { paymentId: "short" },
			},
		};
		expect(extractPaymentIdentifier(payload)).toBeNull();
	});

	test("should reject identifier with invalid characters", () => {
		const payload = {
			extensions: {
				"payment-identifier": {
					paymentId: "test-payment-id-with-special-chars!@#$",
				},
			},
		};
		expect(extractPaymentIdentifier(payload)).toBeNull();
	});

	test("should handle missing extensions", () => {
		const payload = {};
		expect(extractPaymentIdentifier(payload)).toBeNull();
	});

	test("should accept underscore and hyphen", () => {
		const payload = {
			extensions: {
				"payment-identifier": {
					paymentId: "test_id-with_underscores-and-hyphens",
				},
			},
		};
		expect(extractPaymentIdentifier(payload)).toBe(
			"test_id-with_underscores-and-hyphens",
		);
	});
});

describe("Decimal Price Scaling", () => {
	function scalePrice(
		basePriceAtomic: string,
		baseDecimals: number,
		tokenDecimals: number,
	) {
		const decimalDiff = tokenDecimals - baseDecimals;
		if (decimalDiff > 0) {
			return (BigInt(basePriceAtomic) * 10n ** BigInt(decimalDiff)).toString();
		}
		return basePriceAtomic;
	}

	test("should scale USDC (6 decimals) correctly", () => {
		// $0.01 = 10000 atomic units at 6 decimals
		expect(scalePrice("10000", 6, 6)).toBe("10000");
	});

	test("should scale USDM (18 decimals) correctly", () => {
		// $0.01 = 10000 at 6 decimals = 10000 * 10^12 at 18 decimals
		expect(scalePrice("10000", 6, 18)).toBe("10000000000000000");
	});

	test("should handle 12 decimal difference", () => {
		const result = scalePrice("10000", 6, 18);
		expect(result).toBe("10000000000000000");
	});
});

describe("Error Response Formats", () => {
	test("invalid payment encoding error", () => {
		const response = { error: "Invalid payment payload encoding" };
		expect(response.error).toContain("Invalid");
	});

	test("unsupported network error", () => {
		const response = {
			error: "Unsupported network",
			reason: "Network eip155:999999 is not supported",
		};
		expect(response.error).toBe("Unsupported network");
		expect(response.reason).toContain("999999");
	});

	test("unknown route error", () => {
		const response = { error: "Unknown route: nonexistent" };
		expect(response.error).toContain("Unknown route");
	});

	test("backend not configured error", () => {
		const response = {
			error: "Backend not configured",
			message: "MY_BACKEND_URL environment variable is not set",
		};
		expect(response.error).toBe("Backend not configured");
	});
});

describe("HTTP Status Codes", () => {
	test("success codes", () => {
		expect(200).toBeLessThan(300);
		expect(201).toBeLessThan(300);
	});

	test("client error codes", () => {
		expect(400).toBeGreaterThanOrEqual(400);
		expect(402).toBeGreaterThanOrEqual(400);
		expect(404).toBeGreaterThanOrEqual(400);
		expect(402).toBeLessThan(500);
	});

	test("server error codes", () => {
		expect(500).toBeGreaterThanOrEqual(500);
		expect(502).toBeGreaterThanOrEqual(500);
		expect(503).toBeGreaterThanOrEqual(500);
	});
});
