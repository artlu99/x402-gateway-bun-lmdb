import { ROUTE_CONFIG, SUPPORTED_NETWORKS } from './config/routes';
import { withPayment } from './middleware/x402';
import { proxyToBackend } from './proxy';
import { CORS_HEADERS, CORS_OPTIONS_RESPONSE, corsJson } from './utils/cors';
import { pingRedis } from './utils/redis';

const PORT = process.env.PORT ?? 8080;

// ============================================================
// Helpers
// ============================================================

// Helper: Extract subpath from wildcard route
function extractSubpath(url: string, prefix: string): string {
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname;
  const after = path.slice(prefix.length);
  return after.startsWith('/') ? after.slice(1) : after;
}

// Helper: Get base URL for discovery endpoints
function getBaseUrl(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get('host') ?? 'localhost';
  return `${url.protocol}//${host}`;
}

// ============================================================
// Pre-create static responses for zero-allocation dispatch
// ============================================================
const STATIC_RESPONSES = {
  index: new Response(Bun.file('./public/index.html')),
  notFound: Response.json({ error: 'Not Found' }, { status: 404, headers: CORS_HEADERS }),
  serverError: Response.json({ error: 'Internal Server Error' }, { status: 500, headers: CORS_HEADERS }),
};

// ============================================================
// Route Handlers
// ============================================================

// Health check (unprotected)
async function handleHealth(): Promise<Response> {
  const redisHealthy = await pingRedis();

  // Categorize networks
  const networkKeys = Object.keys(SUPPORTED_NETWORKS);
  const evmNetworks = networkKeys.filter(k => SUPPORTED_NETWORKS[k]?.vm === 'evm');
  const svmNetworks = networkKeys.filter(k => SUPPORTED_NETWORKS[k]?.vm === 'svm');

  // Check backend status for each route
  const backends: Record<string, { configured: boolean; status: string }> = {};
  for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
    const configured = !!route.backendUrl;
    backends[key] = {
      configured,
      status: configured ? 'ready' : 'not configured',
    };
  }

  return corsJson({
    status: redisHealthy ? 'healthy' : 'degraded',
    service: 'x402-gateway',
    version: '1.0.0',
    backends,
    store: {
      status: redisHealthy ? 'connected' : 'unreachable',
      features: ['nonce-tracking', 'idempotency-cache'],
    },
    payment: {
      settlement: 'local',
      networks: networkKeys.map(caip2 => {
        const net = SUPPORTED_NETWORKS[caip2];
        if (!net) return null;
        return {
          network: caip2,
          vm: net.vm,
          ...(net.chainId !== undefined && { chainId: net.chainId }),
          token: net.token.address,
          settlement: net.facilitator ? 'facilitator' : 'local',
        };
      }).filter((n): n is NonNullable<typeof n> => n !== null),
      summary: {
        total: networkKeys.length,
        evm: evmNetworks.length,
        svm: svmNetworks.length,
      },
    },
    routes: Object.keys(ROUTE_CONFIG).map(key => {
      const route = ROUTE_CONFIG[key];
      if (!route) return null;
      return {
        path: route.path,
        price: route.price,
        backend: route.backendName,
        description: route.description,
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null),
  });
}

// x402 Discovery Document (/.well-known/x402)
function handleDiscovery(req: Request): Response {
  const baseUrl = getBaseUrl(req);
  const resources = Object.values(ROUTE_CONFIG).map(route => `${baseUrl}${route.path}`);

  // Build chain list for instructions
  const networkKeys = Object.keys(SUPPORTED_NETWORKS);
  const chainNames = networkKeys.map(caip2 => {
    const net = SUPPORTED_NETWORKS[caip2];
    if (!net) return 'Unknown';
    // Simple name extraction from CAIP-2 or config
    if (net.vm === 'svm') return 'Solana';
    const chainMap: Record<number, string> = {
      8453: 'Base', 1: 'Ethereum', 42161: 'Arbitrum', 10: 'Optimism',
      137: 'Polygon', 43114: 'Avalanche', 130: 'Unichain', 59144: 'Linea',
    };
    return net.chainId !== undefined ? (chainMap[net.chainId] ?? `Chain ${net.chainId}`) : 'Unknown';
  });

  // Build route documentation
  const routeDocs = Object.entries(ROUTE_CONFIG).map(([_key, route]) => [
    `### ${route.backendName} — ${route.price}/request`,
    `\`POST /v1/${_key}/*\``,
    route.description,
    '',
  ].join('\n')).join('\n');

  return corsJson({
    version: 1,
    resources,
    instructions: [
      '# x402 Payment Gateway',
      '',
      'Pay-per-request APIs with USDC micropayments — no API keys, no subscriptions.',
      '',
      '## Resources',
      '',
      routeDocs,
      '## Payment',
      '',
      `Pay on any of ${networkKeys.length} chains: ${chainNames.join(', ')}.`,
      'Idempotency supported via `payment-identifier` extension — safe retries without double-charging.',
    ].join('\n'),
  });
}

// Accepted payment routes (agent-friendly discovery)
function handleAccepted(): Response {
  const basePriceDecimals = 6;

  const routes = Object.entries(ROUTE_CONFIG).map(([key, route]) => {
    const basePriceAtomic = BigInt(route.priceAtomic);

    const networks = Object.entries(SUPPORTED_NETWORKS).map(([caip2, network]) => {
      if (!network) return null;
      const decimalDiff = network.token.decimals - basePriceDecimals;
      const amountRequired = decimalDiff > 0
        ? (basePriceAtomic * (10n ** BigInt(decimalDiff))).toString()
        : basePriceAtomic.toString();

      return {
        network: caip2,
        vm: network.vm,
        ...(network.chainId !== undefined && { chainId: network.chainId }),
        asset: network.token.address,
        assetName: network.token.name ?? network.token.address,
        decimals: network.token.decimals,
        amountRequired,
        settlement: network.facilitator ? 'facilitator' : 'local',
      };
    }).filter((n): n is NonNullable<typeof n> => n !== null);

    return {
      path: `/v1/${key}/*`,
      backend: route.backendName,
      price: route.price,
      payTo: route.payTo ?? null,
      payToSol: route.payToSol ?? null,
      description: route.description,
      mimeType: route.mimeType,
      networks,
      extensions: {
        'payment-identifier': {
          supported: true,
          required: false,
        },
        bazaar: {
          discoverable: true,
        },
      },
    };
  });

  return corsJson({
    x402Version: 2,
    service: 'x402-gateway',
    routes,
  });
}

// ============================================================
// Build paid route handler
// ============================================================
function createPaidRouteHandler(routeKey: string): (req: Request) => Promise<Response> {
  return withPayment(routeKey, async (req: Request) => {
    const route = ROUTE_CONFIG[routeKey];
    if (!route) {
      return corsJson({ error: `Route ${routeKey} not configured` }, 500);
    }

    if (!route.backendUrl) {
      return corsJson({
        error: 'Backend not configured',
        message: `${routeKey.toUpperCase()}_BACKEND_URL environment variable is not set`,
      }, 503);
    }

    const subpath = extractSubpath(req.url, `/v1/${routeKey}`);

    // Optional: Map friendly paths to backend paths
    const PATH_ALIASES: Record<string, string> = {
      // 'friendly-name': 'actual-backend-endpoint',
    };
    const resolvedSubpath = PATH_ALIASES[subpath] ?? subpath;

    const apiKey = process.env[route.backendApiKeyEnv];
    return proxyToBackend({
      req,
      targetBase: route.backendUrl,
      targetPath: '/api/' + resolvedSubpath,
      ...(apiKey && { apiKey }),
      apiKeyHeader: route.backendApiKeyHeader,
    });
  });
}

// ============================================================
// Build routes object for Bun.serve
// ============================================================
function buildRoutes(): Record<string, (req: Request) => Response | Promise<Response>> {
  const routes: Record<string, (req: Request) => Response | Promise<Response>> = {
    // Static file (zero-copy via sendfile)
    '/': () => STATIC_RESPONSES.index,

    // Public endpoints
    '/health': handleHealth,
    '/.well-known/x402': handleDiscovery,
    '/accepted': handleAccepted,
  };

  // Dynamic paid routes (wildcard)
  for (const routeKey of Object.keys(ROUTE_CONFIG)) {
    routes[`/v1/${routeKey}/*`] = createPaidRouteHandler(routeKey);
  }

  return routes;
}

// ============================================================
// Start server
// ============================================================
Bun.serve({
  port: PORT,
  routes: buildRoutes(),
  async fetch(req) {
    // Handle OPTIONS preflight - return pre-created response (zero allocation)
    if (req.method === 'OPTIONS') return CORS_OPTIONS_RESPONSE;

    // Fallback 404 - return pre-created response
    return STATIC_RESPONSES.notFound;
  },
  error(error) {
    console.error('[x402-gateway] Error:', error);
    return STATIC_RESPONSES.serverError;
  },
});

// ============================================================
// Startup logging
// ============================================================
console.log(`[x402-gateway] Listening on port ${PORT}`);
console.log(`[x402-gateway] Settlement: local (viem + @x402/svm)`);

// Check store connectivity (LMDB is always available if initialized)
const redisOk = await pingRedis();
console.log(`[x402-gateway] Store: ${redisOk ? '✓ ready (lmdb)' : '✗ error'}`);

// Log backend status
console.log(`[x402-gateway] Backends:`);
for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
  const configured = !!route.backendUrl;
  console.log(`  ${key}: ${configured ? '✓ configured' : '✗ not set'}`);
}

// Log active networks
const networkKeys = Object.keys(SUPPORTED_NETWORKS);
const evmCount = networkKeys.filter(k => SUPPORTED_NETWORKS[k]?.vm === 'evm').length;
const svmCount = networkKeys.filter(k => SUPPORTED_NETWORKS[k]?.vm === 'svm').length;
console.log(`[x402-gateway] Active networks (${networkKeys.length}): ${evmCount} EVM, ${svmCount} SVM`);

networkKeys.forEach(caip2 => {
  const net = SUPPORTED_NETWORKS[caip2];
  if (!net) return;
  let mode: string;
  if (net.vm === 'svm') {
    mode = 'local settlement (@x402/svm)';
  } else if (net.facilitator) {
    mode = `facilitator (${net.facilitator.url})`;
  } else {
    mode = 'local settlement (viem)';
  }
  const chainLabel = net.chainId !== undefined ? `chain ${net.chainId}` : net.vm.toUpperCase();
  console.log(`  ${caip2} (${chainLabel}) — ${mode}`);
});

// Log routes
console.log(`[x402-gateway] Routes:`);
Object.entries(ROUTE_CONFIG).forEach(([key, route]) => {
  console.log(`  /v1/${key}/* -> ${route.backendName} (${route.price})`);
});
