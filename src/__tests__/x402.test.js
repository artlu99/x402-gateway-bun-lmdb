// src/__tests__/x402.test.js

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock store before importing x402 (x402 imports store)
const mockGetNonce = mock(() => Promise.resolve(null));
const mockSetNoncePending = mock(() => Promise.resolve(true));
const mockSetNonceConfirmed = mock(() => Promise.resolve());
const mockDeleteNonce = mock(() => Promise.resolve());
const mockGetIdempotencyCache = mock(() => Promise.resolve(null));
const mockSetIdempotencyCache = mock(() => Promise.resolve());

mock.module('../utils/store', () => ({
  getNonce: mockGetNonce,
  setNoncePending: mockSetNoncePending,
  setNonceConfirmed: mockSetNonceConfirmed,
  deleteNonce: mockDeleteNonce,
  getIdempotencyCache: mockGetIdempotencyCache,
  setIdempotencyCache: mockSetIdempotencyCache,
}));

// Import real x402 middleware and route config
const { withPayment } = await import('../middleware/x402');
const { ROUTE_CONFIG } = await import('../config/routes');

// Helper to create native Request mock
function createMockRequest(overrides = {}) {
  const {
    method = 'POST',
    url = 'https://api.example.com/v1/myapi/endpoint',
    headers = {},
  } = overrides;

  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

// Helper to wrap withPayment and call it
async function callWithPayment(routeKey, req, handler = null) {
  const defaultHandler = handler ?? (async () => new Response('OK', { status: 200 }));
  const wrappedHandler = withPayment(routeKey, defaultHandler);
  return wrappedHandler(req);
}

describe('x402 Middleware (withPayment wrapper)', () => {
  beforeEach(() => {
    mockGetNonce.mockClear();
    mockSetNoncePending.mockClear();
    mockSetNonceConfirmed.mockClear();
    mockDeleteNonce.mockClear();
    mockGetIdempotencyCache.mockClear();
    mockSetIdempotencyCache.mockClear();
    mockGetNonce.mockResolvedValue(null);
    mockGetIdempotencyCache.mockResolvedValue(null);
    mockSetNoncePending.mockResolvedValue(true);
  });

  describe('No payment header', () => {
    test('should return 402 with PAYMENT-REQUIRED header and accepts array', async () => {
      const req = createMockRequest();
      const response = await callWithPayment('myapi', req);

      expect(response.status).toBe(402);
      expect(response.headers.get('PAYMENT-REQUIRED')).not.toBeNull();

      const body = await response.json();
      expect(body.accepts).toBeDefined();
      expect(Array.isArray(body.accepts)).toBe(true);
      expect(body.extensions['payment-identifier']).toEqual({ supported: true, required: false });
    });

    test('should include resource URL in response', async () => {
      const req = createMockRequest({
        url: 'https://api.example.com/v1/myapi/custom/path',
      });
      const response = await callWithPayment('myapi', req);

      const body = await response.json();
      expect(body.resource?.url).toContain('/v1/myapi/custom/path');
    });
  });

  describe('Invalid payment header', () => {
    test('should return 400 for invalid base64', async () => {
      const req = createMockRequest({
        headers: { 'x-payment': 'invalid!!!' },
      });
      const response = await callWithPayment('myapi', req);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid payment payload encoding');
    });

    test('should return 400 for invalid JSON in base64', async () => {
      const header = Buffer.from('not json').toString('base64');
      const req = createMockRequest({
        headers: { 'payment-signature': header },
      });
      const response = await callWithPayment('myapi', req);

      expect(response.status).toBe(400);
    });
  });

  describe('Unsupported network', () => {
    test('should return 402 when network is not in SUPPORTED_NETWORKS', async () => {
      const payload = {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:99999',
        payload: { authorization: {}, signature: '0x' },
      };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');
      const req = createMockRequest({
        headers: { 'x-payment': header },
      });
      const response = await callWithPayment('myapi', req);

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.error).toBe('Unsupported network');
      expect(body.reason).toContain('eip155:99999');
    });
  });

  describe('Unknown route', () => {
    test('should return 500 for unknown route key', async () => {
      const req = createMockRequest();
      const response = await callWithPayment('nonexistent', req);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Unknown route: nonexistent');
    });
  });

  describe('Idempotency cache', () => {
    test('should call handler when payment has cached idempotency response', async () => {
      const payload = {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        extensions: { 'payment-identifier': { paymentId: 'test-payment-id-12345678' } },
        payload: { authorization: {}, signature: '0x' },
      };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');
      mockGetIdempotencyCache.mockResolvedValueOnce({
        response: { paymentResponseHeader: 'cached-header-base64' },
      });

      const req = createMockRequest({
        headers: { 'x-payment': header },
      });

      let handlerCalled = false;
      const response = await callWithPayment('myapi', req, async () => {
        handlerCalled = true;
        return new Response('OK', { status: 200 });
      });

      expect(mockGetIdempotencyCache).toHaveBeenCalledWith('test-payment-id-12345678');
      expect(response.headers.get('PAYMENT-RESPONSE')).toBe('cached-header-base64');
      expect(handlerCalled).toBe(true);
      expect(response.status).toBe(200);
    });
  });

  describe('Verification failure - nonce already used', () => {
    test('should return 402 when nonce was already used', async () => {
      const payTo = ROUTE_CONFIG.myapi.payTo;
      expect(payTo, 'payTo must be configured for myapi route (PAY_TO_ADDRESS or MY_PAY_TO_ADDRESS)').toBeDefined();

      const now = Math.floor(Date.now() / 1000);
      const payload = {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: {
          authorization: {
            from: '0x1234567890123456789012345678901234567890',
            to: payTo,
            value: '10000',
            validAfter: '0',
            validBefore: String(now + 3600),
            nonce: '0xusednonce',
          },
          signature: '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001b',
        },
      };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');
      mockGetNonce.mockResolvedValueOnce({ status: 'pending' });

      const req = createMockRequest({
        headers: { 'x-payment': header },
      });
      const response = await callWithPayment('myapi', req);

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.error).toBe('Payment verification failed');
      expect(body.reason).toContain('Nonce already used');
    });
  });

  describe('Verification failure - unsupported scheme', () => {
    test('should return 402 when scheme is not exact', async () => {
      const payload = {
        x402Version: 2,
        scheme: 'other',
        network: 'eip155:8453',
        payload: { authorization: {}, signature: '0x' },
      };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');

      const req = createMockRequest({
        headers: { 'x-payment': header },
      });
      const response = await callWithPayment('myapi', req);

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.reason).toContain('Unsupported scheme');
    });
  });

  describe('Payment identifier extraction (via real module)', () => {
    test('should extract payment identifier from payload.extensions', async () => {
      const payTo = ROUTE_CONFIG.myapi.payTo;
      expect(payTo, 'payTo must be configured for myapi route').toBeDefined();

      const now = Math.floor(Date.now() / 1000);
      const payload = {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        extensions: { 'payment-identifier': { paymentId: 'test_id-12345678' } },
        payload: {
          authorization: {
            from: '0x1234567890123456789012345678901234567890',
            to: payTo,
            value: '10000',
            validAfter: '0',
            validBefore: String(now + 3600),
            nonce: '0xuniquenonce',
          },
          signature: '0x00',
        },
      };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');
      mockGetIdempotencyCache.mockResolvedValue(null);
      mockGetNonce.mockResolvedValue(null);

      const req = createMockRequest({
        headers: { 'x-payment': header },
      });
      const response = await callWithPayment('myapi', req);

      expect(mockGetIdempotencyCache).toHaveBeenCalledWith('test_id-12345678');
      // Verification proceeds and fails at signature check, but we've exercised extractPaymentIdentifier
      expect(response.status).toBe(402);
    });
  });

  describe('Header preference', () => {
    test('should accept payment-signature header', async () => {
      const payload = {
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:99999',
        payload: {},
      };
      const header = Buffer.from(JSON.stringify(payload)).toString('base64');

      const req = createMockRequest({
        headers: { 'payment-signature': header },
      });
      const response = await callWithPayment('myapi', req);

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.error).toBe('Unsupported network');
    });
  });

  describe('CORS headers', () => {
    test('should include CORS headers in 402 response', async () => {
      const req = createMockRequest();
      const response = await callWithPayment('myapi', req);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeDefined();
    });
  });
});
