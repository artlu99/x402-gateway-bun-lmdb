// Pre-defined headers object - reused across all responses
export const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"Content-Type, Payment-Signature, X-Payment, X-X402-Payer",
};

// For dynamic JSON responses with CORS
export function corsJson(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: CORS_HEADERS });
}

// For responses with custom headers (e.g., PAYMENT-REQUIRED)
export function corsResponse(
	body: string,
	status: number,
	extraHeaders?: Record<string, string>,
): Response {
	return new Response(body, {
		status,
		headers: { ...CORS_HEADERS, ...extraHeaders },
	});
}

// For JSON responses with custom headers
export function corsJsonWithHeaders(
	data: unknown,
	status: number,
	extraHeaders?: Record<string, string>,
): Response {
	return Response.json(data, {
		status,
		headers: { ...CORS_HEADERS, ...extraHeaders },
	});
}
