// ============================================================
// Proxy verified x402 requests to backend services.
// Injects internal API key so the backend never needs to know
// about x402 — it just sees an authenticated request.
//
// Supports forceMethod to convert GET+query params into POST+body
// for backends that only accept POST.
// ============================================================

import type { ProxyOptions } from "./types";
import { CORS_HEADERS } from "./utils/cors";

export async function proxyToBackend({
	req,
	targetBase,
	targetPath,
	apiKey,
	apiKeyHeader,
	forceMethod,
}: ProxyOptions): Promise<Response> {
	// Build the full backend URL
	const url = new URL(targetPath, targetBase);

	// Get URL info from native Request
	const reqUrl = new URL(req.url);

	// Determine the method to send to the backend
	const backendMethod = forceMethod ?? req.method;

	// Build request body:
	//   - POST/PUT/PATCH with body → use body as-is
	//   - GET with query params + forceMethod POST → convert query to body
	let body: Record<string, unknown> | null = null;

	// Get query params
	const queryParams = Object.fromEntries(reqUrl.searchParams);

	// For methods with body, parse the request body
	if (["POST", "PUT", "PATCH"].includes(req.method)) {
		try {
			const contentType = req.headers.get("content-type");
			if (contentType?.includes("application/json")) {
				body = (await req.json()) as Record<string, unknown>;
			}
		} catch {
			// Invalid JSON, body stays null
		}
	}

	// If no body and we have query params, use them as body
	if (!body && Object.keys(queryParams).length > 0) {
		body = { ...queryParams };
	}

	// Build headers
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": "x402-Gateway/1.0",
	};

	// Inject the internal API key
	if (apiKey && apiKeyHeader) {
		headers[apiKeyHeader] = apiKey;
	}

	// Forward context - get from native Request
	const xForwardedFor = req.headers.get("x-forwarded-for");
	if (xForwardedFor) {
		headers["X-Forwarded-For"] = xForwardedFor;
	}

	// Protocol from URL (remove trailing colon)
	headers["X-Forwarded-Proto"] = reqUrl.protocol.replace(":", "");

	// Forward x402 payer header
	const x402Payer = req.headers.get("x-x402-payer");
	headers["X-x402-Payer"] = x402Payer ?? "unknown";

	// Build fetch options
	const fetchOptions: RequestInit = {
		method: backendMethod,
		headers,
	};

	if (["POST", "PUT", "PATCH"].includes(backendMethod) && body) {
		fetchOptions.body = JSON.stringify(body);
	}

	console.log(
		`[proxy] ${req.method} -> ${backendMethod} ${url.toString()}${body ? ` body: ${JSON.stringify(body)}` : ""}`,
	);

	// Call the backend
	const backendRes = await fetch(url.toString(), fetchOptions);

	// Get content-type
	const contentType = backendRes.headers.get("content-type");

	// Read response text
	const responseText = await backendRes.text();

	// Try to parse as JSON
	try {
		const json = JSON.parse(responseText) as unknown;
		// Return JSON response with CORS headers
		return Response.json(json, {
			status: backendRes.status,
			headers: {
				...CORS_HEADERS,
				...(contentType && { "Content-Type": contentType }),
			},
		});
	} catch {
		// If backend returned non-JSON (e.g. Cloudflare HTML error page),
		// wrap it in JSON for agent-friendly consumption on 5xx
		if (backendRes.status >= 500) {
			return Response.json(
				{
					error: "Backend unavailable",
					status: backendRes.status,
					message: `Backend returned HTTP ${backendRes.status}. Please retry shortly.`,
				},
				{
					status: backendRes.status,
					headers: CORS_HEADERS,
				},
			);
		} else {
			// Return text response for non-5xx
			return new Response(responseText, {
				status: backendRes.status,
				headers: {
					...CORS_HEADERS,
					...(contentType && { "Content-Type": contentType }),
				},
			});
		}
	}
}

// Export type for external use
export type { ProxyOptions };
