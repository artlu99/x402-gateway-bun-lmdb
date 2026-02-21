// Integration tests verifying 5 key endpoints
// Run with: bun run test:endpoints  or  RUN_INTEGRATION=1 bun test

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const PORT = 41880;
const BASE_URL = `http://localhost:${PORT}`;

let savedPort;

const runIntegration = !!process.env.RUN_INTEGRATION;

describe.skipIf(!runIntegration)('Endpoint Verification (Bun.serve)', () => {
  beforeAll(async () => {
    savedPort = process.env.PORT;
    process.env.PORT = String(PORT);
    const originalLog = console.log;
    console.log = () => {};
    try {
      await import('../index.js');
    } finally {
      console.log = originalLog;
    }
  });

  afterAll(() => {
    if (savedPort !== undefined) process.env.PORT = savedPort;
    else delete process.env.PORT;
  });

  describe('1. GET /health', () => {
    test('should return 200 status', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      expect(res.status).toBe(200);
    });

    test('should return JSON content type', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    test('should include CORS headers', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBeDefined();
    });

    test('should return health status object', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      const data = await res.json();
      expect(data.status).toBe('healthy');
      expect(data.service).toBe('x402-gateway');
      expect(data.version).toBeDefined();
    });

    test('should include store status', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      const data = await res.json();
      expect(data.store).toBeDefined();
      expect(data.store.status).toBe('connected');
    });

    test('should include routes', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      const data = await res.json();
      expect(Array.isArray(data.routes)).toBe(true);
      expect(data.routes.length).toBeGreaterThan(0);
    });
  });

  describe('2. GET /accepted', () => {
    test('should return 200 status', async () => {
      const res = await fetch(`${BASE_URL}/accepted`);
      expect(res.status).toBe(200);
    });

    test('should return JSON content type', async () => {
      const res = await fetch(`${BASE_URL}/accepted`);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    test('should include CORS headers', async () => {
      const res = await fetch(`${BASE_URL}/accepted`);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    test('should return x402Version 2', async () => {
      const res = await fetch(`${BASE_URL}/accepted`);
      const data = await res.json();
      expect(data.x402Version).toBe(2);
    });

    test('should include routes array with payment requirements', async () => {
      const res = await fetch(`${BASE_URL}/accepted`);
      const data = await res.json();
      expect(Array.isArray(data.routes)).toBe(true);
      expect(data.routes.length).toBeGreaterThan(0);
      const route = data.routes[0];
      expect(route.path).toBeDefined();
      expect(route.price).toBeDefined();
      expect(route.networks).toBeDefined();
      expect(Array.isArray(route.networks)).toBe(true);
    });
  });

  describe('3. GET /.well-known/x402', () => {
    test('should return 200 status', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/x402`);
      expect(res.status).toBe(200);
    });

    test('should return JSON content type', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/x402`);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    test('should include CORS headers', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/x402`);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    test('should return version 1 discovery document', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/x402`);
      const data = await res.json();
      expect(data.version).toBe(1);
    });

    test('should include resources array', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/x402`);
      const data = await res.json();
      expect(Array.isArray(data.resources)).toBe(true);
      expect(data.resources.length).toBeGreaterThan(0);
    });

    test('should include instructions', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/x402`);
      const data = await res.json();
      expect(data.instructions).toBeDefined();
      expect(typeof data.instructions).toBe('string');
    });
  });

  describe('4. GET /v1/myapi/test (no payment)', () => {
    test('should return 402 Payment Required status', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      expect(res.status).toBe(402);
    });

    test('should return PAYMENT-REQUIRED header', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      const paymentHeader = res.headers.get('PAYMENT-REQUIRED');
      expect(paymentHeader).not.toBeNull();
      // Should be valid base64
      expect(() => atob(paymentHeader)).not.toThrow();
    });

    test('should include CORS headers on 402 response', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBeDefined();
    });

    test('should return JSON body with x402Version 2', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      const data = await res.json();
      expect(data.x402Version).toBe(2);
    });

    test('should include accepts array with payment requirements', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      const data = await res.json();
      expect(Array.isArray(data.accepts)).toBe(true);
      expect(data.accepts.length).toBeGreaterThan(0);
      const accept = data.accepts[0];
      expect(accept.scheme).toBe('exact');
      expect(accept.network).toBeDefined();
      expect(accept.amount).toBeDefined();
      expect(accept.payTo).toBeDefined();
      expect(accept.asset).toBeDefined();
    });

    test('should include resource URL', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      const data = await res.json();
      expect(data.resource).toBeDefined();
      expect(data.resource.url).toContain('/v1/myapi/test');
    });

    test('should include payment-identifier extension', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      const data = await res.json();
      expect(data.extensions).toBeDefined();
      expect(data.extensions['payment-identifier']).toBeDefined();
      expect(data.extensions['payment-identifier'].supported).toBe(true);
    });

    test('PAYMENT-REQUIRED header should decode to valid JSON', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`);
      const paymentHeader = res.headers.get('PAYMENT-REQUIRED');
      const decoded = JSON.parse(atob(paymentHeader));
      expect(decoded.x402Version).toBe(2);
      expect(Array.isArray(decoded.accepts)).toBe(true);
    });
  });

  describe('5. OPTIONS /v1/myapi/test (preflight)', () => {
    test('should return 204 No Content status', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
    });

    test('should include Access-Control-Allow-Origin header', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`, { method: 'OPTIONS' });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    test('should include Access-Control-Allow-Methods header', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`, { method: 'OPTIONS' });
      const methods = res.headers.get('Access-Control-Allow-Methods');
      expect(methods).toBeDefined();
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('PUT');
      expect(methods).toContain('PATCH');
      expect(methods).toContain('DELETE');
      expect(methods).toContain('OPTIONS');
    });

    test('should include Access-Control-Allow-Headers header', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`, { method: 'OPTIONS' });
      const headers = res.headers.get('Access-Control-Allow-Headers');
      expect(headers).toBeDefined();
      expect(headers).toContain('Content-Type');
      expect(headers).toContain('Payment-Signature');
      expect(headers).toContain('X-Payment');
    });

    test('should have empty body', async () => {
      const res = await fetch(`${BASE_URL}/v1/myapi/test`, { method: 'OPTIONS' });
      const text = await res.text();
      expect(text).toBe('');
    });
  });

  describe('CORS on all endpoints', () => {
    const endpoints = [
      { name: '/health', path: '/health' },
      { name: '/accepted', path: '/accepted' },
      { name: '/.well-known/x402', path: '/.well-known/x402' },
      { name: '/v1/myapi/test (402)', path: '/v1/myapi/test' },
    ];

    for (const { name, path } of endpoints) {
      test(`${name} should have CORS headers`, async () => {
        const res = await fetch(`${BASE_URL}${path}`);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.headers.get('Access-Control-Allow-Methods')).toBeDefined();
        expect(res.headers.get('Access-Control-Allow-Headers')).toBeDefined();
      });
    }
  });
});
