// src/__tests__/x402.test.js

import { test, expect, describe, beforeEach, mock } from 'bun:test';

// Mock Redis before importing x402 (x402 imports redis)
const mockGetNonce = mock(() => Promise.resolve(null));
const mockSetNoncePending = mock(() => Promise.resolve(true));
const mockSetNonceConfirmed = mock(() => Promise.resolve());
const mockDeleteNonce = mock(() => Promise.resolve());
const mockGetIdempotencyCache = mock(() => Promise.resolve(null));
const mockSetIdempotencyCache = mock(() => Promise.resolve());

mock.module('../utils/redis.js', () => ({
  getNonce: mockGetNonce,
  setNoncePending: mockSetNoncePending,
  setNonceConfirmed: mockSetNonceConfirmed,
  deleteNonce: mockDeleteNonce,
  getIdempotencyCache: mockGetIdempotencyCache,
  setIdempotencyCache: mockSetIdempotencyCache,
}));

// Import real x402 middleware and route config
const { x402PaymentMiddleware } = await import('../middleware/x402.js');
const { ROUTE_CONFIG } = await import('../config/routes.js');

// Helper to create mock Express req/res/next
function createMockReq(overrides = {}) {
  return {
    headers: {},
    protocol: 'https',
    get: mock((name) => (name === 'host' ? 'api.example.com' : '')),
    originalUrl: '/v1/myapi/endpoint',
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    _status: null,
    _json: null,
    _headers: {},
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._json = body;
      return res;
    },
    set(name, value) {
      res._headers[name] = value;
      return res;
    },
  };
  return res;
}

describe('x402 Middleware (real module)', () => {
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
      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq();
      const res = createMockRes();
      const next = mock(() => {});

      await middleware(req, res, next);

      expect(res._status).toBe(402);
      expect(res._headers['PAYMENT-REQUIRED']).toBeDefined();
      expect(res._json).toBeDefined();
      expect(res._json.accepts).toBeDefined();
      expect(Array.isArray(res._json.accepts)).toBe(true);
      expect(res._json.extensions['payment-identifier']).toEqual({ supported: true, required: false });
      expect(next).not.toHaveBeenCalled();
    });

    test('should include resource URL in response', async () => {
      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ originalUrl: '/v1/myapi/custom/path' });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._json.resource?.url).toContain('/v1/myapi/custom/path');
    });
  });

  describe('Invalid payment header', () => {
    test('should return 400 for invalid base64', async () => {
      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ headers: { 'x-payment': 'invalid!!!' } });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._status).toBe(400);
      expect(res._json.error).toBe('Invalid payment payload encoding');
    });

    test('should return 400 for invalid JSON in base64', async () => {
      const middleware = x402PaymentMiddleware('myapi');
      const header = Buffer.from('not json').toString('base64');
      const req = createMockReq({ headers: { 'payment-signature': header } });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._status).toBe(400);
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
      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ headers: { 'x-payment': header } });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._status).toBe(402);
      expect(res._json.error).toBe('Unsupported network');
      expect(res._json.reason).toContain('eip155:99999');
    });
  });

  describe('Unknown route', () => {
    test('should return 500 for unknown route key', async () => {
      const middleware = x402PaymentMiddleware('nonexistent');
      const req = createMockReq();
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._status).toBe(500);
      expect(res._json.error).toBe('Unknown route: nonexistent');
    });
  });

  describe('Idempotency cache', () => {
    test('should call next() when payment has cached idempotency response', async () => {
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

      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ headers: { 'x-payment': header } });
      const res = createMockRes();
      const next = mock(() => {});

      await middleware(req, res, next);

      expect(mockGetIdempotencyCache).toHaveBeenCalledWith('test-payment-id-12345678');
      expect(res._headers['PAYMENT-RESPONSE']).toBe('cached-header-base64');
      expect(next).toHaveBeenCalled();
      expect(res._status).toBeNull();
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

      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ headers: { 'x-payment': header } });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._status).toBe(402);
      expect(res._json.error).toBe('Payment verification failed');
      expect(res._json.reason).toContain('Nonce already used');
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

      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ headers: { 'x-payment': header } });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._status).toBe(402);
      expect(res._json.reason).toContain('Unsupported scheme');
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

      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ headers: { 'x-payment': header } });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(mockGetIdempotencyCache).toHaveBeenCalledWith('test_id-12345678');
      // Verification proceeds and fails at signature check, but we've exercised extractPaymentIdentifier
      expect(res._status).toBe(402);
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

      const middleware = x402PaymentMiddleware('myapi');
      const req = createMockReq({ headers: { 'payment-signature': header } });
      const res = createMockRes();

      await middleware(req, res, mock(() => {}));

      expect(res._status).toBe(402);
      expect(res._json.error).toBe('Unsupported network');
    });
  });
});
