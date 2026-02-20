# x402 Payment Gateway Template

A production-ready, self-hosted payment gateway that implements the [x402 protocol](https://x402.org) — HTTP-native micropayments for APIs. Accept stablecoin payments (USDC) per-request with no API keys, no subscriptions, and no intermediaries.

**Fork this repo, configure your backend, and start accepting crypto micropayments in minutes.**

## What is x402?

x402 uses the HTTP `402 Payment Required` status code to create a machine-readable payment flow:

```
1. Agent/client calls your API
2. Gateway returns 402 with payment requirements (chain, amount, token)
3. Agent signs a USDC transfer authorization
4. Agent retries with signed payment in header
5. Gateway verifies signature, settles on-chain, proxies to your backend
6. Client gets the API response + payment receipt
```

No wallets to integrate. No payment pages. Just HTTP headers.

## Features

- **Multi-chain support** — Accept USDC on Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Unichain, Linea, and Solana out of the box
- **MegaETH support** — USDM (18 decimals) via Meridian facilitator
- **Hybrid settlement** — Local on-chain settlement via [viem](https://viem.sh) + optional external facilitators
- **Solana support** — SVM payments via [@x402/svm](https://www.npmjs.com/package/@x402/svm) facilitator pattern
- **Replay protection** — Redis-backed nonce tracking prevents double-spending
- **Idempotency** — `payment-identifier` extension for safe retries without double-charging
- **Agent discovery** — `/accepted` endpoint with full pricing, schemas, and network info
- **x402 well-known** — `/.well-known/x402` discovery document
- **Zero lock-in** — Your backend never knows about x402; it just gets authenticated requests
- **Deploy anywhere** — Docker-based; works on GCP Cloud Run, AWS ECS/Fargate, Railway, Fly.io, or bare metal

## Quick Start

```bash
# Clone the template
git clone https://github.com/YOUR_USERNAME/x402-gateway-template.git
cd x402-gateway-template

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your values (see Configuration section)

# Run locally
npm run dev

# Test
curl http://localhost:8080/health
curl http://localhost:8080/accepted
```

## Architecture

```
Client/Agent request
  → x402 Gateway (this service)
    → Verify payment signature (EIP-712 / SVM)
    → Settle on-chain (USDC transfer)
    → Proxy to your backend API (with internal auth)
    → Return response + payment receipt header
```

```
┌─────────────────────────────────────────────────┐
│                  x402 Gateway                    │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Payment  │→ │ On-chain │→ │ Backend Proxy │ │
│  │ Verify   │  │ Settle   │  │ (your API)    │ │
│  └──────────┘  └──────────┘  └───────────────┘ │
│       │              │                           │
│  ┌──────────┐  ┌──────────┐                     │
│  │  Redis   │  │  RPC     │                     │
│  │ (nonces) │  │ (chains) │                     │
│  └──────────┘  └──────────┘                     │
└─────────────────────────────────────────────────┘
```

## Configuration

### 1. Define Your Routes

Edit `src/config/routes.js` to define your paid API endpoints:

```js
export const ROUTE_CONFIG = {
  // Each key becomes a route prefix: /v1/{key}/*
  myapi: {
    path: '/v1/myapi/*',
    backendName: 'My API',
    get backendUrl() { return process.env.MY_BACKEND_URL; },
    backendApiKeyEnv: 'MY_BACKEND_API_KEY',
    backendApiKeyHeader: 'x-api-key',       // Header name your backend expects
    get price() { return process.env.MY_PRICE || '$0.01'; },
    get priceAtomic() { return process.env.MY_PRICE_ATOMIC || '10000'; }, // 0.01 USDC in 6-decimal units
    get payTo() { return process.env.MY_PAY_TO_ADDRESS || process.env.PAY_TO_ADDRESS; },
    get payToSol() { return process.env.MY_PAY_TO_ADDRESS_SOL; },
    description: 'Description of your API for agent discovery',
    mimeType: 'application/json',
  },
};
```

### 2. Environment Variables

#### Required

| Variable | Description |
|----------|-------------|
| `SETTLEMENT_PRIVATE_KEY` | Private key (0x hex) for the gas-paying settlement wallet |
| `PAY_TO_ADDRESS` | Default EVM wallet that receives USDC payments |
| `BASE_RPC_URL` | At least one RPC URL (Base recommended for low fees) |

#### Backend (per route)

| Variable | Description |
|----------|-------------|
| `MY_BACKEND_URL` | Your backend API base URL |
| `MY_BACKEND_API_KEY` | Internal API key for your backend |

#### RPC URLs (only configured chains are advertised)

| Variable | Chain | Required Gas Token |
|----------|-------|--------------------|
| `BASE_RPC_URL` | Base | ETH (~$5) |
| `ETHEREUM_RPC_URL` | Ethereum | ETH (~$20-50) |
| `ARBITRUM_RPC_URL` | Arbitrum | ETH (~$5) |
| `OPTIMISM_RPC_URL` | Optimism | ETH (~$5) |
| `POLYGON_RPC_URL` | Polygon | POL (~$2) |
| `AVALANCHE_RPC_URL` | Avalanche | AVAX (~$2) |
| `UNICHAIN_RPC_URL` | Unichain | ETH (~$2) |
| `LINEA_RPC_URL` | Linea | ETH (~$2) |
| `MEGAETH_RPC_URL` | MegaETH | N/A (facilitator pays) |
| `SOLANA_RPC_URL` | Solana | SOL (~$2) |

#### Solana (optional)

| Variable | Description |
|----------|-------------|
| `SOLANA_FACILITATOR_PRIVATE_KEY` | Base58 private key for Solana fee payer |
| `MY_PAY_TO_ADDRESS_SOL` | Solana wallet to receive USDC payments |

#### Redis (required for replay protection)

| Variable | Description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |

> **Tip:** [Upstash](https://upstash.com) has a generous free tier. Any Redis with REST API works.

#### Optional Overrides

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 8080) |
| `MY_PRICE` | Display price (e.g., "$0.05") |
| `MY_PRICE_ATOMIC` | Price in token atomic units (e.g., "50000" for $0.05 USDC) |

### 3. Settlement Wallet

The settlement wallet **only pays gas** to submit `transferWithAuthorization` on-chain. It never holds or receives stablecoins — payments flow directly from the payer to your `payTo` address.

```
Payer → (USDC) → Your payTo wallet     ← receives payment
Settlement wallet → (gas) → on-chain    ← only pays gas fees
```

Fund it with small amounts of native gas tokens on each chain you enable.

## Adding Routes

### Basic Route

1. Add route config in `src/config/routes.js`
2. Register the route in `src/index.js`:

```js
// Paid route
app.all('/v1/myapi/{*path}', x402PaymentMiddleware('myapi'), async (req, res) => {
  const subpath = getSubpath(req.params);
  const route = ROUTE_CONFIG.myapi;
  await proxyToBackend({
    req, res,
    targetBase: route.backendUrl,
    targetPath: '/api/' + subpath,
    apiKey: process.env[route.backendApiKeyEnv],
    apiKeyHeader: route.backendApiKeyHeader,
  });
});

// Free route (no middleware)
app.get('/v1/myapi/health', async (req, res) => {
  // Proxy directly without payment
});
```

### Path Aliases

Map user-friendly paths to your backend's actual routes:

```js
const PATH_ALIASES = {
  'analyze': 'internal-analyze-endpoint',
  'report':  'generate-full-report',
};
const resolvedSubpath = PATH_ALIASES[subpath] || subpath;
```

## Adding Chains

### New EVM Chain

1. Verify the chain has **native Circle USDC** with EIP-3009 support
2. Add to `src/config/routes.js`:

```js
const MY_CHAIN = {
  vm: 'evm',
  caip2: 'eip155:CHAIN_ID',
  chainId: CHAIN_ID,
  rpcEnvVar: 'MY_CHAIN_RPC_URL',
  token: usdc('0xUSDC_CONTRACT_ADDRESS'),
};
```

3. Register in `ALL_NETWORKS`
4. Add RPC URL to `.env`
5. Fund settlement wallet with gas on that chain
6. Add the viem chain import in `src/middleware/x402.js`

### New EVM Chain with Facilitator

For chains where USDC doesn't support EIP-3009 yet:

```js
const MY_CHAIN = {
  vm: 'evm',
  caip2: 'eip155:CHAIN_ID',
  chainId: CHAIN_ID,
  rpcEnvVar: 'MY_CHAIN_RPC_URL',
  facilitator: {
    url: 'https://facilitator-api.example.com/v1',
    apiKeyEnv: 'FACILITATOR_API_KEY',
    networkName: 'mychain',              // If facilitator uses short names
    facilitatorContract: '0x...',        // Facilitator's contract address
    x402Version: 1,                      // Facilitator's x402 version
  },
  token: {
    address: '0x...',
    name: 'Token Name',
    version: '1',
    decimals: 18,
  },
};
```

### Solana

Solana support uses the `@x402/svm` facilitator pattern where:
- The client partially signs a transaction
- Your facilitator wallet co-signs as fee payer and submits

Requirements:
- `SOLANA_FACILITATOR_PRIVATE_KEY` — Base58 private key
- `SOLANA_RPC_URL` — Solana RPC endpoint  
- `*_PAY_TO_ADDRESS_SOL` — Solana wallet per route

## Deployment

### Docker (any platform)

```bash
docker build -t x402-gateway .
docker run -p 8080:8080 --env-file .env x402-gateway
```

### GCP Cloud Run

See [`docs/deploy-gcp.md`](docs/deploy-gcp.md) for full Cloud Run deployment with Secret Manager.

```bash
# Quick deploy
gcloud run deploy x402-gateway \
  --source . \
  --region us-east1 \
  --allow-unauthenticated \
  --set-env-vars "BASE_RPC_URL=https://..." \
  --set-secrets "SETTLEMENT_PRIVATE_KEY=x402-settlement-key:latest"
```

### AWS ECS / Fargate

See [`docs/deploy-aws.md`](docs/deploy-aws.md).

### Railway / Fly.io / Render

See [`docs/deploy-paas.md`](docs/deploy-paas.md).

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Free | Gateway health + backend status |
| GET | `/accepted` | Free | Agent discovery — pricing, networks, schemas |
| GET | `/.well-known/x402` | Free | x402 discovery document |
| ALL | `/v1/{route}/*` | Paid | Your protected API routes |

## Agent Discovery

Agents call `GET /accepted` to discover your API before making paid requests:

```bash
curl https://your-gateway.com/accepted
```

Returns supported networks, pricing, and input/output schemas for each route. Compatible with [Bazaar](https://bazaar.computer) agent discovery protocol.

## Compatible Agent Wallets

Any wallet that supports the x402 protocol works:

| Wallet | Description |
|--------|-------------|
| [@x402/fetch](https://www.npmjs.com/package/@x402/fetch) | Official SDK — drop-in `fetch` replacement |
| [OpenClaw / Lobster](https://openclaw.ai) | Agent framework with built-in x402 |
| [AgentWallet (frames.ag)](https://frames.ag) | x402 endpoint for agents |
| [Vincent](https://heyvincent.ai) | MPC wallet with policy controls |
| [Sponge](https://paysponge.com) | x402_fetch one-liner integration |

## Client Example

```js
import { x402Fetch } from '@x402/fetch';

const res = await x402Fetch('https://your-gateway.com/v1/myapi/endpoint', {
  method: 'POST',
  body: JSON.stringify({ key: 'value' }),
  wallet  // any x402-compatible wallet
});

const data = await res.json();
```

## Project Structure

```
├── src/
│   ├── index.js              # Express app, route registration
│   ├── proxy.js              # Backend proxy (injects internal auth)
│   ├── middleware/
│   │   └── x402.js           # Payment verification + settlement
│   ├── config/
│   │   └── routes.js         # Route definitions + network registry
│   └── utils/
│       └── redis.js          # Nonce tracking + idempotency cache
├── public/
│   └── index.html            # Landing page (optional)
├── docs/
│   ├── deploy-gcp.md         # GCP Cloud Run guide
│   ├── deploy-aws.md         # AWS ECS/Fargate guide
│   └── deploy-paas.md        # Railway/Fly.io/Render guide
├── Dockerfile
├── cloudbuild.yaml           # GCP Cloud Build config
├── .env.example
└── package.json
```

## Security Considerations

- **Settlement key** — Store in a secrets manager (GCP Secret Manager, AWS Secrets Manager, etc.), never in env vars or code
- **Settlement wallet** — Only holds gas tokens, never stablecoins. If compromised, attacker can only drain small gas balances
- **Pay-to address** — This is YOUR wallet. Payments go directly from payer to you on-chain. The gateway never custodies funds
- **Redis** — Used for nonce tracking. If Redis is down, the gateway fails open on reads (settlement still checks on-chain) and fails closed on writes (rejects payment to be safe)
- **Backend API keys** — The gateway injects these server-side. Your backend never sees x402 traffic directly

## License

MIT — fork it, ship it, make money with it.

## Links

- [x402 Protocol Spec](https://x402.org)
- [x402 GitHub](https://github.com/coinbase/x402)
- [@x402/fetch SDK](https://www.npmjs.com/package/@x402/fetch)
- [@x402/svm SDK](https://www.npmjs.com/package/@x402/svm)
- [Bazaar Discovery Protocol](https://bazaar.computer)
