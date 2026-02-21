// ============================================================
// Proxy verified x402 requests to backend services.
// Injects internal API key so the backend never needs to know
// about x402 — it just sees an authenticated request.
//
// Supports forceMethod to convert GET+query params into POST+body
// for backends that only accept POST.
// ============================================================

import type { Request, Response } from 'express';
import type { ProxyOptions } from './types.js';

interface ProxyParams {
  req: Request;
  res: Response;
  targetBase: string;
  targetPath: string;
  apiKey?: string;
  apiKeyHeader?: string;
  forceMethod?: string;
}

export async function proxyToBackend({
  req,
  res,
  targetBase,
  targetPath,
  apiKey,
  apiKeyHeader,
  forceMethod,
}: ProxyParams): Promise<void> {
  // Build the full backend URL
  const url = new URL(targetPath, targetBase);

  // Determine the method to send to the backend
  const backendMethod = forceMethod ?? req.method;

  // Build request body:
  //   - POST/PUT/PATCH with body → use body as-is
  //   - GET with query params + forceMethod POST → convert query to body
  let body: Record<string, unknown> | null = null;

  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body as object).length > 0) {
    body = req.body as Record<string, unknown>;
  } else if (req.query && Object.keys(req.query as object).length > 0) {
    body = { ...req.query as Record<string, unknown> };
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'x402-Gateway/1.0',
  };

  // Inject the internal API key
  if (apiKey && apiKeyHeader) {
    headers[apiKeyHeader] = apiKey;
  }

  // Forward context
  if (req.ip) {
    headers['X-Forwarded-For'] = req.ip;
  }
  headers['X-Forwarded-Proto'] = req.protocol ?? 'https';
  headers['X-x402-Payer'] = (req.headers?.['x-x402-payer'] as string | undefined) ?? 'unknown';

  // Build fetch options
  const fetchOptions: RequestInit = {
    method: backendMethod,
    headers,
  };

  if (['POST', 'PUT', 'PATCH'].includes(backendMethod) && body) {
    fetchOptions.body = JSON.stringify(body);
  }

  console.log(`[proxy] ${req.method} -> ${backendMethod} ${url.toString()}${body ? ` body: ${JSON.stringify(body)}` : ''}`);

  // Call the backend
  const backendRes = await fetch(url.toString(), fetchOptions);

  // Forward status
  res.status(backendRes.status);

  // Forward content-type
  const contentType = backendRes.headers.get('content-type');
  if (contentType) {
    res.set('Content-Type', contentType);
  }

  // Read and return the response
  const responseText = await backendRes.text();

  try {
    const json = JSON.parse(responseText) as unknown;
    res.json(json);
  } catch {
    // If backend returned non-JSON (e.g. Cloudflare HTML error page),
    // wrap it in JSON for agent-friendly consumption on 5xx
    if (backendRes.status >= 500) {
      res.set('Content-Type', 'application/json');
      res.json({
        error: 'Backend unavailable',
        status: backendRes.status,
        message: `Backend returned HTTP ${backendRes.status}. Please retry shortly.`,
      });
    } else {
      res.send(responseText);
    }
  }
}

// Export type for external use
export type { ProxyOptions };
