// src/__tests__/proxy.test.js

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock global fetch
const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify({ success: true, data: 'test' })),
  })
);

global.fetch = mockFetch;

// Import after mocking
const { proxyToBackend } = await import('../proxy');

describe('proxyToBackend', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    mockFetch.mockClear();

    mockReq = {
      method: 'POST',
      headers: {},
      protocol: 'https',
      ip: '192.168.1.1',
      body: { query: 'test', param: 'value' },
      query: {},
      get: mock((key) => {
        if (key === 'host') return 'gateway.example.com';
        return null;
      }),
    };

    mockRes = {
      status: mock(() => mockRes),
      json: mock(() => mockRes),
      set: mock(() => mockRes),
      send: mock(() => mockRes),
    };
  });

  describe('basic proxying', () => {
    test('should proxy POST request with body', async () => {
      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
        apiKey: 'test-api-key',
        apiKeyHeader: 'x-api-key',
      });

      expect(mockFetch).toHaveBeenCalled();
      const [url, options] = mockFetch.mock.calls[0];

      expect(url).toBe('https://api.example.com/api/endpoint');
      expect(options.method).toBe('POST');
      expect(options.headers['x-api-key']).toBe('test-api-key');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.body).toBe(JSON.stringify({ query: 'test', param: 'value' }));
    });

    test('should proxy GET request', async () => {
      mockReq.method = 'GET';
      mockReq.body = null;

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
    });

    test('should convert GET query params to body with forceMethod POST', async () => {
      mockReq.method = 'GET';
      mockReq.body = null;
      mockReq.query = { search: 'term', limit: '10' };

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/search',
        forceMethod: 'POST',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
      expect(options.body).toBe(JSON.stringify({ search: 'term', limit: '10' }));
    });

    test('should use PUT method when specified', async () => {
      mockReq.method = 'PUT';
      mockReq.body = { id: 1, value: 'updated' };

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/resource',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('PUT');
      expect(options.body).toBe(JSON.stringify({ id: 1, value: 'updated' }));
    });

    test('should use PATCH method when specified', async () => {
      mockReq.method = 'PATCH';
      mockReq.body = { value: 'patched' };

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/resource',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('PATCH');
    });
  });

  describe('header forwarding', () => {
    test('should inject API key with custom header name', async () => {
      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
        apiKey: 'secret-key-123',
        apiKeyHeader: 'Authorization',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBe('secret-key-123');
    });

    test('should forward client IP in X-Forwarded-For', async () => {
      mockReq.ip = '203.0.113.50';

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['X-Forwarded-For']).toBe('203.0.113.50');
    });

    test('should set X-Forwarded-Proto', async () => {
      mockReq.protocol = 'https';

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['X-Forwarded-Proto']).toBe('https');
    });

    test('should set X-x402-Payer header', async () => {
      mockReq.headers['x-x402-payer'] = '0xpayeraddress';

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['X-x402-Payer']).toBe('0xpayeraddress');
    });

    test('should use "unknown" for missing X-x402-Payer', async () => {
      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['X-x402-Payer']).toBe('unknown');
    });

    test('should include User-Agent header', async () => {
      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['User-Agent']).toBe('x402-Gateway/1.0');
    });
  });

  describe('response handling', () => {
    test('should forward status code from backend', async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ created: true })),
        })
      );

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/create',
      });

      expect(mockRes.status).toHaveBeenCalledWith(201);
    });

    test('should forward JSON response', async () => {
      const responseData = { success: true, data: { id: 123 } };
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify(responseData)),
        })
      );

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      expect(mockRes.json).toHaveBeenCalledWith(responseData);
    });

    test('should set Content-Type header from backend', async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
          text: () => Promise.resolve(JSON.stringify({})),
        })
      );

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      expect(mockRes.set).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
    });

    test('should handle non-JSON 5xx responses', async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html>Service Unavailable</html>'),
        })
      );

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Backend unavailable',
          status: 503,
        })
      );
    });

    test('should pass through non-JSON 4xx responses', async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 400,
          headers: new Headers({ 'content-type': 'text/plain' }),
          text: () => Promise.resolve('Bad Request'),
        })
      );

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Bad Request');
    });
  });

  describe('URL construction', () => {
    test('should construct correct URL with path', async () => {
      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/v1/users/123',
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/v1/users/123');
    });

    test('should handle trailing slash in base URL', async () => {
      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com/',
        targetPath: '/api/endpoint',
      });

      const [url] = mockFetch.mock.calls[0];
      // URL constructor normalizes this
      expect(url).toContain('api.example.com');
    });
  });

  describe('error handling', () => {
    test('should handle fetch network errors', async () => {
      mockFetch.mockReturnValueOnce(Promise.reject(new Error('Network error')));

      await expect(
        proxyToBackend({
          req: mockReq,
          res: mockRes,
          targetBase: 'https://api.example.com',
          targetPath: '/api/endpoint',
        })
      ).rejects.toThrow('Network error');
    });

    test('should handle malformed JSON response gracefully', async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve('not valid json'),
        })
      );

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      // Should send as text since JSON parse failed and status is 200
      expect(mockRes.send).toHaveBeenCalledWith('not valid json');
    });
  });

  describe('logging', () => {
    test('should log proxy request details', async () => {
      const consoleSpy = mock(() => {});
      const originalLog = console.log;
      console.log = consoleSpy;

      await proxyToBackend({
        req: mockReq,
        res: mockRes,
        targetBase: 'https://api.example.com',
        targetPath: '/api/endpoint',
      });

      console.log = originalLog;

      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0];
      expect(logCall).toContain('[proxy]');
      expect(logCall).toContain('POST');
      expect(logCall).toContain('api.example.com');
    });
  });
});
