import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock global fetch
const mockFetch = mock(() =>
	Promise.resolve({
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": "application/json" }),
		text: () =>
			Promise.resolve(JSON.stringify({ success: true, data: "test" })),
	}),
);

global.fetch = mockFetch;

// Import after mocking
const { proxyToBackend } = await import("../proxy");

// Helper to create native Request mock
function createMockRequest(options = {}) {
	const {
		method = "POST",
		url = "https://gateway.example.com/api/endpoint",
		body = null,
		headers = {},
	} = options;

	const req = new Request(url, {
		method,
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		...(body && { body: JSON.stringify(body) }),
	});

	return req;
}

describe("proxyToBackend", () => {
	beforeEach(() => {
		mockFetch.mockClear();
	});

	describe("basic proxying", () => {
		test("should proxy POST request with body", async () => {
			const mockReq = createMockRequest({
				method: "POST",
				url: "https://gateway.example.com/api/endpoint",
				body: { query: "test", param: "value" },
			});

			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
				apiKey: "test-api-key",
				apiKeyHeader: "x-api-key",
			});

			expect(mockFetch).toHaveBeenCalled();
			const [fetchUrl, options] = mockFetch.mock.calls[0];

			expect(fetchUrl).toBe("https://api.example.com/api/endpoint");
			expect(options.method).toBe("POST");
			expect(options.headers["x-api-key"]).toBe("test-api-key");
			expect(options.headers["Content-Type"]).toBe("application/json");
			expect(options.body).toBe(
				JSON.stringify({ query: "test", param: "value" }),
			);
			expect(response.status).toBe(200);
		});

		test("should proxy GET request", async () => {
			const mockReq = createMockRequest({
				method: "GET",
				url: "https://gateway.example.com/api/endpoint",
			});

			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.method).toBe("GET");
			expect(options.body).toBeUndefined();
			expect(response.status).toBe(200);
		});

		test("should convert GET query params to body with forceMethod POST", async () => {
			const mockReq = createMockRequest({
				method: "GET",
				url: "https://gateway.example.com/api/search?search=term&limit=10",
			});

			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/search",
				forceMethod: "POST",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.method).toBe("POST");
			expect(options.body).toBe(
				JSON.stringify({ search: "term", limit: "10" }),
			);
			expect(response.status).toBe(200);
		});

		test("should use PUT method when specified", async () => {
			const mockReq = createMockRequest({
				method: "PUT",
				url: "https://gateway.example.com/api/resource",
				body: { id: 1, value: "updated" },
			});

			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/resource",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.method).toBe("PUT");
			expect(options.body).toBe(JSON.stringify({ id: 1, value: "updated" }));
			expect(response.status).toBe(200);
		});

		test("should use PATCH method when specified", async () => {
			const mockReq = createMockRequest({
				method: "PATCH",
				url: "https://gateway.example.com/api/resource",
				body: { value: "patched" },
			});

			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/resource",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.method).toBe("PATCH");
			expect(response.status).toBe(200);
		});
	});

	describe("header forwarding", () => {
		test("should inject API key with custom header name", async () => {
			const mockReq = createMockRequest({
				headers: {},
			});

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
				apiKey: "secret-key-123",
				apiKeyHeader: "Authorization",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.headers.Authorization).toBe("secret-key-123");
		});

		test("should forward X-Forwarded-For header", async () => {
			const mockReq = createMockRequest({
				headers: { "x-forwarded-for": "203.0.113.50" },
			});

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.headers["X-Forwarded-For"]).toBe("203.0.113.50");
		});

		test("should set X-Forwarded-Proto from URL protocol", async () => {
			const mockReq = createMockRequest({
				url: "https://gateway.example.com/api/endpoint",
			});

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.headers["X-Forwarded-Proto"]).toBe("https");
		});

		test("should set X-x402-Payer header", async () => {
			const mockReq = createMockRequest({
				headers: { "x-x402-payer": "0xpayeraddress" },
			});

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.headers["X-x402-Payer"]).toBe("0xpayeraddress");
		});

		test('should use "unknown" for missing X-x402-Payer', async () => {
			const mockReq = createMockRequest();

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.headers["X-x402-Payer"]).toBe("unknown");
		});

		test("should include User-Agent header", async () => {
			const mockReq = createMockRequest();

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			const [, options] = mockFetch.mock.calls[0];
			expect(options.headers["User-Agent"]).toBe("x402-Gateway/1.0");
		});
	});

	describe("response handling", () => {
		test("should forward status code from backend", async () => {
			mockFetch.mockReturnValueOnce(
				Promise.resolve({
					ok: true,
					status: 201,
					headers: new Headers({ "content-type": "application/json" }),
					text: () => Promise.resolve(JSON.stringify({ created: true })),
				}),
			);

			const mockReq = createMockRequest();
			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/create",
			});

			expect(response.status).toBe(201);
		});

		test("should forward JSON response", async () => {
			const responseData = { success: true, data: { id: 123 } };
			mockFetch.mockReturnValueOnce(
				Promise.resolve({
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					text: () => Promise.resolve(JSON.stringify(responseData)),
				}),
			);

			const mockReq = createMockRequest();
			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			const data = await response.json();
			expect(data).toEqual(responseData);
		});

		test("should include CORS headers in response", async () => {
			const mockReq = createMockRequest();
			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		});

		test("should handle non-JSON 5xx responses", async () => {
			mockFetch.mockReturnValueOnce(
				Promise.resolve({
					ok: false,
					status: 503,
					headers: new Headers({ "content-type": "text/html" }),
					text: () => Promise.resolve("<html>Service Unavailable</html>"),
				}),
			);

			const mockReq = createMockRequest();
			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			expect(response.status).toBe(503);
			const data = await response.json();
			expect(data).toEqual(
				expect.objectContaining({
					error: "Backend unavailable",
					status: 503,
				}),
			);
		});

		test("should pass through non-JSON 4xx responses", async () => {
			mockFetch.mockReturnValueOnce(
				Promise.resolve({
					ok: false,
					status: 400,
					headers: new Headers({ "content-type": "text/plain" }),
					text: () => Promise.resolve("Bad Request"),
				}),
			);

			const mockReq = createMockRequest();
			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			expect(response.status).toBe(400);
			const text = await response.text();
			expect(text).toBe("Bad Request");
		});
	});

	describe("URL construction", () => {
		test("should construct correct URL with path", async () => {
			const mockReq = createMockRequest();

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/v1/users/123",
			});

			const [fetchUrl] = mockFetch.mock.calls[0];
			expect(fetchUrl).toBe("https://api.example.com/v1/users/123");
		});

		test("should handle trailing slash in base URL", async () => {
			const mockReq = createMockRequest();

			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com/",
				targetPath: "/api/endpoint",
			});

			const [fetchUrl] = mockFetch.mock.calls[0];
			// URL constructor normalizes this
			expect(fetchUrl).toContain("api.example.com");
		});
	});

	describe("error handling", () => {
		test("should handle fetch network errors", async () => {
			mockFetch.mockReturnValueOnce(Promise.reject(new Error("Network error")));

			const mockReq = createMockRequest();

			await expect(
				proxyToBackend({
					req: mockReq,
					targetBase: "https://api.example.com",
					targetPath: "/api/endpoint",
				}),
			).rejects.toThrow("Network error");
		});

		test("should handle malformed JSON response gracefully", async () => {
			mockFetch.mockReturnValueOnce(
				Promise.resolve({
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					text: () => Promise.resolve("not valid json"),
				}),
			);

			const mockReq = createMockRequest();
			const response = await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			// Should return text since JSON parse failed and status is 200
			const text = await response.text();
			expect(text).toBe("not valid json");
		});
	});

	describe("logging", () => {
		test("should log proxy request details", async () => {
			const consoleSpy = mock(() => {});
			const originalLog = console.log;
			console.log = consoleSpy;

			const mockReq = createMockRequest();
			await proxyToBackend({
				req: mockReq,
				targetBase: "https://api.example.com",
				targetPath: "/api/endpoint",
			});

			console.log = originalLog;

			expect(consoleSpy).toHaveBeenCalled();
			const logCall = consoleSpy.mock.calls[0][0];
			expect(logCall).toContain("[proxy]");
			expect(logCall).toContain("POST");
			expect(logCall).toContain("api.example.com");
		});
	});
});
