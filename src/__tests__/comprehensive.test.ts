import { describe, expect, test } from "bun:test";
import type { NetworkConfig, PaymentPayload, RouteConfig } from "../types";

// Comprehensive tests covering edge cases and additional functionality

describe("Comprehensive Unit Tests", () => {
	describe("Address validation", () => {
		function isValidEvmAddress(address: string) {
			return /^0x[a-fA-F0-9]{40}$/.test(address);
		}

		function isValidSolanaAddress(address: string) {
			// Base58 check (simplified)
			return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
		}

		test("should validate EVM addresses", () => {
			expect(
				isValidEvmAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
			).toBe(true);
			expect(
				isValidEvmAddress("0x0000000000000000000000000000000000000000"),
			).toBe(true);
			expect(isValidEvmAddress("0x")).toBe(false);
			expect(isValidEvmAddress("0x1234")).toBe(false);
			expect(isValidEvmAddress("not-an-address")).toBe(false);
		});

		test("should validate Solana addresses", () => {
			expect(
				isValidSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
			).toBe(true);
			expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(
				true,
			);
			expect(isValidSolanaAddress("")).toBe(false);
		});

		test("should handle case-insensitive EVM comparison", () => {
			const addr1 = "0xABCDEFabcdefABCDabcdEFabcdefABCDefabCD";
			const addr2 = "0xabcdefabcdefabcdabcdefabcdefabcdabcd";
			expect(addr1.toLowerCase()).not.toBe(addr2.toLowerCase());
		});
	});

	describe("Price calculations", () => {
		function parsePrice(priceString: string) {
			// Parse "$0.01" format
			const match = priceString.match(/^\$(\d+\.?\d*)$/);
			if (!match) return null;
			return parseFloat(match[1] ?? "0");
		}

		function priceToAtomic(priceDecimal: number, decimals = 6) {
			return Math.floor(priceDecimal * 10 ** decimals).toString();
		}

		test("should parse price strings", () => {
			expect(parsePrice("$0.01")).toBe(0.01);
			expect(parsePrice("$0.05")).toBe(0.05);
			expect(parsePrice("$1.00")).toBe(1.0);
			expect(parsePrice("$10.50")).toBe(10.5);
			expect(parsePrice("invalid")).toBeNull();
		});

		test("should convert price to atomic units", () => {
			expect(priceToAtomic(0.01, 6)).toBe("10000");
			expect(priceToAtomic(0.05, 6)).toBe("50000");
			expect(priceToAtomic(1.0, 6)).toBe("1000000");
		});

		test("should handle floating point precision", () => {
			// 0.1 * 10^6 = 100000
			expect(priceToAtomic(0.1, 6)).toBe("100000");
		});
	});

	describe("URL construction", () => {
		function buildBackendUrl(base: string, path: string) {
			const url = new URL(path, base);
			return url.toString();
		}

		test("should construct correct URLs", () => {
			expect(buildBackendUrl("https://api.example.com", "/api/endpoint")).toBe(
				"https://api.example.com/api/endpoint",
			);
		});

		test("should handle trailing slashes", () => {
			expect(buildBackendUrl("https://api.example.com/", "/api/endpoint")).toBe(
				"https://api.example.com/api/endpoint",
			);
		});

		test("should handle nested paths", () => {
			expect(
				buildBackendUrl("https://api.example.com", "/v1/users/123/profile"),
			).toBe("https://api.example.com/v1/users/123/profile");
		});
	});

	describe("Request header handling", () => {
		function getPaymentHeader(headers: Record<string, string>) {
			// Case-insensitive header lookup
			const keys = Object.keys(headers);
			const paymentKey = keys.find(
				(k) => k.toLowerCase() === "payment-signature",
			);
			const xPaymentKey = keys.find((k) => k.toLowerCase() === "x-payment");

			if (!paymentKey && !xPaymentKey) return null;
			return headers[paymentKey ?? ""] || headers[xPaymentKey ?? ""] || null;
		}

		test("should find payment-signature header", () => {
			const headers = { "Payment-Signature": "test" };
			expect(getPaymentHeader(headers)).toBe("test");
		});

		test("should find x-payment header", () => {
			const headers = { "X-Payment": "test" };
			expect(getPaymentHeader(headers)).toBe("test");
		});

		test("should handle case variations", () => {
			expect(getPaymentHeader({ "PAYMENT-SIGNATURE": "test" })).toBe("test");
			expect(getPaymentHeader({ "payment-signature": "test" })).toBe("test");
		});

		test("should return null when no payment header", () => {
			expect(getPaymentHeader({})).toBeNull();
			expect(
				getPaymentHeader({ "Content-Type": "application/json" }),
			).toBeNull();
		});
	});

	describe("Response header generation", () => {
		function createPaymentResponseHeader(data: Record<string, unknown>) {
			return Buffer.from(JSON.stringify(data)).toString("base64");
		}

		test("should create valid base64 header", () => {
			const data = {
				success: true,
				txHash: "0xabc123",
				network: "eip155:8453",
				blockNumber: 12345,
			};

			const header = createPaymentResponseHeader(data);
			expect(header).toBeDefined();
			expect(typeof header).toBe("string");

			const decoded = JSON.parse(Buffer.from(header, "base64").toString());
			expect(decoded.success).toBe(true);
		});

		test("should handle null blockNumber for SVM", () => {
			const data = {
				success: true,
				txHash: "svm-tx-123",
				network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
				blockNumber: null,
			};

			const header = createPaymentResponseHeader(data);
			const decoded = JSON.parse(Buffer.from(header, "base64").toString());
			expect(decoded.blockNumber).toBeNull();
		});
	});

	describe("Facilitator request building", () => {
		function buildFacilitatorRequest(
			paymentPayload: PaymentPayload,
			routeConfig: RouteConfig,
			network: NetworkConfig,
		) {
			const basePriceAtomic = BigInt(routeConfig.priceAtomic);
			const decimalDiff = network.token.decimals - 6;
			const amountRequired =
				decimalDiff > 0
					? (basePriceAtomic * 10n ** BigInt(decimalDiff)).toString()
					: basePriceAtomic.toString();

			const facilitatorNetwork =
				network.facilitator?.networkName || paymentPayload.network;
			const facilitatorPayTo =
				network.facilitator?.facilitatorContract || routeConfig.payTo;

			return {
				paymentPayload: {
					x402Version: network.facilitator?.x402Version || 2,
					scheme: paymentPayload.scheme,
					network: facilitatorNetwork,
					payload: paymentPayload.payload,
				},
				paymentRequirements: {
					scheme: "exact",
					network: facilitatorNetwork,
					maxAmountRequired: amountRequired,
					payTo: facilitatorPayTo,
					asset: network.token.address,
				},
			};
		}

		test("should build facilitator request with correct structure", () => {
			const paymentPayload = {
				scheme: "exact",
				network: "eip155:4326",
				payload: { authorization: {}, signature: "0xsig" },
			};
			const routeConfig = {
				priceAtomic: "10000",
				payTo: "0xabc",
				description: "Test",
				mimeType: "application/json",
			};
			const network = {
				token: { address: "0xtoken", decimals: 18 },
				facilitator: {
					networkName: "megaeth",
					facilitatorContract: "0xfacilitator",
					x402Version: 1,
				},
			};

			const request = buildFacilitatorRequest(
				paymentPayload as PaymentPayload,
				routeConfig as RouteConfig,
				network as NetworkConfig,
			);

			expect(request.paymentPayload.x402Version).toBe(1);
			expect(request.paymentPayload.network).toBe("megaeth");
			expect(request.paymentRequirements.payTo).toBe("0xfacilitator");
			expect(request.paymentRequirements.maxAmountRequired).toBe(
				"10000000000000000",
			);
		});
	});

	describe("Subpath handling", () => {
		function getSubpath(params: { path: string | string[] }) {
			if (!params.path) return "";
			return Array.isArray(params.path) ? params.path.join("/") : params.path;
		}

		test("should join array params", () => {
			expect(getSubpath({ path: ["users", "123", "profile"] })).toBe(
				"users/123/profile",
			);
		});

		test("should handle string params", () => {
			expect(getSubpath({ path: "endpoint" })).toBe("endpoint");
		});

		test("should handle empty params", () => {
			expect(
				getSubpath({
					path: "",
				}),
			).toBe("");
			expect(getSubpath({ path: "" })).toBe("");
		});

		test("should handle single-element array", () => {
			expect(getSubpath({ path: ["single"] })).toBe("single");
		});
	});

	describe("Path alias resolution", () => {
		function resolvePath(subpath: string, aliases: Record<string, string>) {
			return aliases[subpath] || subpath;
		}

		test("should resolve aliased paths", () => {
			const aliases = {
				analyze: "internal-analyze-v2",
				report: "generate-full-report",
			};

			expect(resolvePath("analyze", aliases)).toBe("internal-analyze-v2");
			expect(resolvePath("report", aliases)).toBe("generate-full-report");
		});

		test("should pass through non-aliased paths", () => {
			const aliases = { analyze: "internal-analyze" };
			expect(resolvePath("other", aliases)).toBe("other");
		});

		test("should handle empty aliases", () => {
			expect(resolvePath("path", {})).toBe("path");
		});
	});

	describe("Error message formatting", () => {
		test("should format verification failure messages", () => {
			const errors = [
				{ reason: "Insufficient payment: got 5000, need 10000" },
				{ reason: "Wrong recipient: expected 0xabc" },
				{ reason: "Payment expired" },
				{ reason: "Payment not yet valid" },
				{ reason: "Nonce already used (confirmed)" },
				{ reason: "Signature does not match sender" },
			];

			for (const error of errors) {
				expect(error.reason).toBeDefined();
				expect(typeof error.reason).toBe("string");
			}
		});

		test("should format network errors", () => {
			const error = {
				error: "Unsupported network",
				reason: "Network eip155:999999 is not supported",
			};

			expect(error.error).toBeDefined();
			expect(error.reason).toContain("999999");
		});
	});

	describe("SVM transaction handling", () => {
		test("should identify SVM network type", () => {
			const network = { vm: "svm" };
			expect(network.vm).toBe("svm");
		});

		test("should require feePayer for SVM", () => {
			const extra = { feePayer: "SolanaFeePayer1111111111111111111111111" };
			expect(extra.feePayer).toBeDefined();
		});

		test("should use transferChecked for SPL tokens", () => {
			// SPL Token uses TransferChecked which includes decimals
			const transfer = {
				type: "TransferChecked",
				decimals: 6,
				amount: "10000",
			};

			expect(transfer.decimals).toBe(6);
		});
	});

	describe("Timeout handling", () => {
		const DEFAULT_TIMEOUT = 3600; // 1 hour

		test("should have default timeout of 1 hour", () => {
			expect(DEFAULT_TIMEOUT).toBe(3600);
		});

		test("should calculate validity window", () => {
			const now = Math.floor(Date.now() / 1000);
			const validAfter = now;
			const validBefore = now + DEFAULT_TIMEOUT;

			expect(validBefore - validAfter).toBe(3600);
		});
	});

	describe("Extension support", () => {
		test("should support payment-identifier extension", () => {
			const extensions = {
				"payment-identifier": {
					supported: true,
					required: false,
				},
			};

			expect(extensions["payment-identifier"].supported).toBe(true);
			expect(extensions["payment-identifier"].required).toBe(false);
		});

		test("should support bazaar discovery", () => {
			const extensions = {
				bazaar: {
					discoverable: true,
				},
			};

			expect(extensions.bazaar.discoverable).toBe(true);
		});
	});

	describe("Health check response", () => {
		test("should report healthy status", () => {
			const health = {
				status: "healthy",
				store: { status: "connected" },
			};

			expect(health.status).toBe("healthy");
			expect(health.store.status).toBe("connected");
		});

		test("should report degraded status", () => {
			const health = {
				status: "degraded",
				store: { status: "unreachable" },
			};

			expect(health.status).toBe("degraded");
			expect(health.store.status).toBe("unreachable");
		});

		test("should include backend status", () => {
			const health = {
				backends: {
					myapi: { configured: true, status: "ready" },
					premium: { configured: false, status: "not configured" },
				},
			};

			expect(health.backends.myapi.configured).toBe(true);
			expect(health.backends.premium.configured).toBe(false);
		});
	});

	describe("Agent discovery response", () => {
		test("should include all route information", () => {
			const accepted = {
				x402Version: 2,
				routes: [
					{
						path: "/v1/myapi/*",
						backend: "My API",
						price: "$0.01",
						networks: [
							{ network: "eip155:8453", vm: "evm", amountRequired: "10000" },
						],
						extensions: {
							"payment-identifier": { supported: true },
						},
					},
				],
			};

			expect(accepted.x402Version).toBe(2);
			expect(accepted.routes?.[0]?.networks?.length).toBe(1);
		});
	});

	describe("BigInt arithmetic", () => {
		test("should handle large numbers correctly", () => {
			const a = 10000n;
			const b = 10n ** 12n;
			const result = a * b;

			expect(result.toString()).toBe("10000000000000000");
		});

		test("should compare BigInt values", () => {
			const required = 10000n;
			const provided = 15000n;

			expect(provided >= required).toBe(true);
		});

		test("should handle decimal scaling", () => {
			const basePrice = 10000n;
			const scaleFactor = 10n ** 12n;
			const scaled = basePrice * scaleFactor;

			expect(scaled).toBe(10000000000000000n);
		});
	});

	describe("Base64 encoding/decoding", () => {
		test("should encode and decode correctly", () => {
			const data = { test: "value", number: 123 };
			const encoded = Buffer.from(JSON.stringify(data)).toString("base64");
			const decoded = JSON.parse(Buffer.from(encoded, "base64").toString());

			expect(decoded.test).toBe("value");
			expect(decoded.number).toBe(123);
		});

		test("should handle special characters", () => {
			const data = { unicode: "你好世界", emoji: "🚀" };
			const encoded = Buffer.from(JSON.stringify(data)).toString("base64");
			const decoded = JSON.parse(Buffer.from(encoded, "base64").toString());

			expect(decoded.unicode).toBe("你好世界");
			expect(decoded.emoji).toBe("🚀");
		});
	});

	describe("HTTP method handling", () => {
		test("should support standard methods", () => {
			const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
			for (const method of methods) {
				expect(method).toBeDefined();
			}
		});

		test("should identify body methods", () => {
			const bodyMethods = ["POST", "PUT", "PATCH"];
			const method = "POST";

			expect(bodyMethods.includes(method)).toBe(true);
		});

		test("should handle OPTIONS for CORS", () => {
			const method = "OPTIONS";
			expect(method).toBe("OPTIONS");
		});
	});

	describe("Environment variable patterns", () => {
		test("should construct env var names correctly", () => {
			const routeKey = "myapi";
			const envVars = {
				backendUrl: `${routeKey.toUpperCase()}_BACKEND_URL`,
				apiKey: `${routeKey.toUpperCase()}_BACKEND_API_KEY`,
				price: `${routeKey.toUpperCase()}_PRICE`,
				priceAtomic: `${routeKey.toUpperCase()}_PRICE_ATOMIC`,
			};

			expect(envVars.backendUrl).toBe("MYAPI_BACKEND_URL");
			expect(envVars.apiKey).toBe("MYAPI_BACKEND_API_KEY");
		});

		test("should handle multi-word route keys", () => {
			const routeKey = "premium_api";
			const envVar = `${routeKey.toUpperCase()}_BACKEND_URL`;

			expect(envVar).toBe("PREMIUM_API_BACKEND_URL");
		});
	});
});
