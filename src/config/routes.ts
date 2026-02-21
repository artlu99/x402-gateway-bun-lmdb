// ============================================================
// Route configuration for x402 gateway
//
// CUSTOMIZATION GUIDE:
//   1. Define your routes in ROUTE_CONFIG (bottom of file)
//   2. Each route key becomes a URL prefix: /v1/{key}/*
//   3. Set pricing, backend URL, and API key env vars
//   4. Networks are auto-discovered from env vars — no code changes needed
//
// SUPPORTED NETWORKS:
//   EVM: Native Circle USDC with EIP-3009 (transferWithAuthorization)
//        Domain: name="USD Coin", version="2", decimals=6
//
//   SVM: Solana USDC (SPL Token) via x402 SVM facilitator
//        Uses TransferChecked with partial signing
//        Requires SOLANA_FACILITATOR_PRIVATE_KEY for gas
//
// IMPORTANT: Only native USDC is supported, NOT bridged USDC.e
//   Bridged tokens use different contract implementations
//   that may not support EIP-3009.
//
// To add a new EVM chain:
//   1. Add network config below with CAIP-2 ID and RPC env var
//   2. Register in ALL_NETWORKS
//   3. Add RPC URL to .env
//   4. Fund settlement wallet with gas on that chain
//   5. Add viem chain import in src/middleware/x402.ts
//
// To add a new SVM chain:
//   1. Add network config with CAIP-2 ID (solana:<genesis-hash>)
//   2. Set vm: 'svm' and token config with SPL mint address
//   3. Add RPC URL to .env
//   4. Fund facilitator wallet with SOL for gas
// ============================================================

import type {
	NetworkConfig,
	NetworkRegistry,
	RouteConfig,
	RouteRegistry,
	TokenConfig,
} from "../types";

// ─── Token Configs ─────────────────────────────────────────
// All native Circle USDC contracts share the same EIP-712 domain:
//   name: "USD Coin"
//   version: "2"
//   decimals: 6

function usdc(address: string): TokenConfig {
	return {
		address,
		name: "USD Coin",
		version: "2",
		decimals: 6,
	};
}

// ─── EVM Network Configs ───────────────────────────────────

// Base (Coinbase L2) — Recommended primary chain (lowest fees)
const BASE: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:8453",
	chainId: 8453,
	rpcEnvVar: "BASE_RPC_URL",
	token: usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
};

// Ethereum Mainnet
const ETHEREUM: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:1",
	chainId: 1,
	rpcEnvVar: "ETHEREUM_RPC_URL",
	token: usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
};

// Arbitrum One
const ARBITRUM: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:42161",
	chainId: 42161,
	rpcEnvVar: "ARBITRUM_RPC_URL",
	token: usdc("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
};

// Optimism (OP Mainnet)
const OPTIMISM: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:10",
	chainId: 10,
	rpcEnvVar: "OPTIMISM_RPC_URL",
	token: usdc("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
};

// Polygon PoS (native USDC, NOT USDC.e)
const POLYGON: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:137",
	chainId: 137,
	rpcEnvVar: "POLYGON_RPC_URL",
	token: usdc("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
};

// Avalanche C-Chain (native USDC, NOT USDC.e)
const AVALANCHE: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:43114",
	chainId: 43114,
	rpcEnvVar: "AVALANCHE_RPC_URL",
	token: usdc("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
};

// Unichain
const UNICHAIN: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:130",
	chainId: 130,
	rpcEnvVar: "UNICHAIN_RPC_URL",
	token: usdc("0x078D782b760474a361dDA0AF3839290b0EF57AD6"),
};

// Linea
const LINEA: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:59144",
	chainId: 59144,
	rpcEnvVar: "LINEA_RPC_URL",
	token: usdc("0x176211869cA2b568f2A7D4EE941E073a821EE1ff"),
};

// ─── Facilitator-based Networks ────────────────────────────
// For chains where the stablecoin doesn't natively support EIP-3009,
// use an external facilitator service to verify + settle payments.

// MegaETH — USDM (MegaUSD) via Meridian facilitator
// WARNING: USDM uses 18 decimals (not 6 like USDC). Gateway auto-scales pricing.
// Meridian specifics:
//   - Uses x402 v1 with short network names (not CAIP-2)
//   - Funds go to their facilitator contract, not directly to payTo
//   - Your payTo wallet is configured in Meridian's org settings
//   - 1% fee on withdrawal from Meridian
const MEGAETH: NetworkConfig = {
	vm: "evm",
	caip2: "eip155:4326",
	chainId: 4326,
	rpcEnvVar: "MEGAETH_RPC_URL",
	facilitator: {
		url: "https://api.mrdn.finance/v1",
		apiKeyEnv: "MERIDIAN_API_KEY",
		networkName: "megaeth", // Meridian uses short names, not CAIP-2
		facilitatorContract: "0x8E7769D440b3460b92159Dd9C6D17302b036e2d6",
		x402Version: 1, // Meridian uses v1
	},
	token: {
		address: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
		name: "MegaUSD",
		version: "1",
		decimals: 18, // ⚠️ USDM uses 18 decimals, NOT 6
	},
};

// ─── Solana Networks ───────────────────────────────────────
// Uses x402 SVM facilitator pattern: client partially signs,
// your facilitator wallet co-signs as feePayer and submits.
//
// USDC on Solana: 6 decimals, SPL Token program
// Mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

const SOLANA_MAINNET: NetworkConfig = {
	vm: "svm",
	caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
	rpcEnvVar: "SOLANA_RPC_URL",
	token: {
		address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		name: "USDC",
		version: "1",
		decimals: 6,
	},
};

// ─── Network Registry ──────────────────────────────────────
// Add or remove networks here. Only networks with a configured
// RPC URL in .env will be advertised to agents.
export const ALL_NETWORKS: NetworkRegistry = {
	"eip155:8453": BASE,
	"eip155:1": ETHEREUM,
	"eip155:42161": ARBITRUM,
	"eip155:10": OPTIMISM,
	"eip155:137": POLYGON,
	"eip155:43114": AVALANCHE,
	"eip155:130": UNICHAIN,
	"eip155:59144": LINEA,
	"eip155:4326": MEGAETH,
	"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": SOLANA_MAINNET,
};

// ─── Active Network Filter ────────────────────────────────
// Auto-filters to only networks with configured RPC URLs.
// SVM networks also require SOLANA_FACILITATOR_PRIVATE_KEY.
function getActiveNetworks(): NetworkRegistry {
	const active: NetworkRegistry = {};
	for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
		if (!process.env[network.rpcEnvVar]) continue;
		if (network.vm === "svm" && !process.env.SOLANA_FACILITATOR_PRIVATE_KEY)
			continue;
		active[caip2] = network;
	}
	return active;
}

// Lazy getter — resolves after dotenv loads
let _cachedNetworks: NetworkRegistry | null = null;

function getNetworkValue(prop: string | symbol): NetworkConfig | undefined {
	if (!_cachedNetworks) _cachedNetworks = getActiveNetworks();
	if (typeof prop === "string") {
		return _cachedNetworks[prop];
	}
	return undefined;
}

export const SUPPORTED_NETWORKS: NetworkRegistry = new Proxy(
	{} as NetworkRegistry,
	{
		get(
			_target: NetworkRegistry,
			prop: string | symbol,
		): NetworkConfig | undefined {
			return getNetworkValue(prop);
		},
		ownKeys(): string[] {
			if (!_cachedNetworks) _cachedNetworks = getActiveNetworks();
			return Object.keys(_cachedNetworks);
		},
		getOwnPropertyDescriptor(
			_target: NetworkRegistry,
			prop: string | symbol,
		): PropertyDescriptor | undefined {
			if (!_cachedNetworks) _cachedNetworks = getActiveNetworks();
			if (typeof prop === "string" && prop in _cachedNetworks) {
				return {
					configurable: true,
					enumerable: true,
					value: _cachedNetworks[prop],
				};
			}
			return undefined;
		},
	},
);

// ============================================================
// ROUTE CONFIG — CUSTOMIZE THIS FOR YOUR API
// ============================================================
//
// Each key here becomes a paid route at /v1/{key}/*
//
// Required fields:
//   path             — Express route pattern
//   backendName      — Display name for health/discovery
//   backendUrl       — Use getter for lazy env resolution
//   backendApiKeyEnv — Env var name holding your backend API key
//   backendApiKeyHeader — Header name your backend expects
//   price            — Human-readable price string
//   priceAtomic      — Price in USDC atomic units (6 decimals)
//                       $0.01 = 10000, $0.05 = 50000, $0.10 = 100000, $1.00 = 1000000
//   payTo            — EVM address to receive payments
//   description      — Used in 402 response and agent discovery
//   mimeType         — Response content type
//
// Optional:
//   payToSol         — Solana address for SOL payments
//   bazaarSchema     — Input/output schemas for Bazaar discovery (see BAZAAR_SCHEMAS in x402.ts)

interface InternalRouteConfig extends RouteConfig {
	get backendUrl(): string;
	get price(): string;
	get priceAtomic(): string;
	get payTo(): string | undefined;
	get payToSol(): string | undefined;
}

function createRouteConfig(
	config: Omit<
		RouteConfig,
		"backendUrl" | "price" | "priceAtomic" | "payTo" | "payToSol"
	> & {
		get backendUrl(): string;
		get price(): string;
		get priceAtomic(): string;
		get payTo(): string | undefined;
		get payToSol(): string | undefined;
	},
): InternalRouteConfig {
	return config;
}

export const ROUTE_CONFIG: RouteRegistry = {
	// ── Example Route: "myapi" ─────────────────────────────
	// Access at: POST /v1/myapi/endpoint
	// Cost: $0.01 per request
	myapi: createRouteConfig({
		path: "/v1/myapi/*",
		backendName: "My API",
		get backendUrl(): string {
			return process.env.MY_BACKEND_URL ?? "";
		},
		backendApiKeyEnv: "MY_BACKEND_API_KEY",
		backendApiKeyHeader: "x-api-key",
		get price(): string {
			return process.env.MY_PRICE ?? "$0.01";
		},
		get priceAtomic(): string {
			return process.env.MY_PRICE_ATOMIC ?? "10000";
		},
		get payTo(): string | undefined {
			return process.env.MY_PAY_TO_ADDRESS ?? process.env.PAY_TO_ADDRESS;
		},
		get payToSol(): string | undefined {
			return process.env.MY_PAY_TO_ADDRESS_SOL;
		},
		description:
			"Your API description here. This appears in 402 responses and agent discovery.",
		mimeType: "application/json",
	}),

	// ── Add more routes here ───────────────────────────────
	// premium: createRouteConfig({
	//   path: '/v1/premium/*',
	//   backendName: 'Premium API',
	//   get backendUrl(): string { return process.env.PREMIUM_BACKEND_URL ?? ''; },
	//   backendApiKeyEnv: 'PREMIUM_BACKEND_API_KEY',
	//   backendApiKeyHeader: 'Authorization',
	//   get price(): string { return '$0.50'; },
	//   get priceAtomic(): string { return '500000'; },
	//   get payTo(): string | undefined { return process.env.PREMIUM_PAY_TO_ADDRESS ?? process.env.PAY_TO_ADDRESS; },
	//   get payToSol(): string | undefined { return process.env.PREMIUM_PAY_TO_ADDRESS_SOL; },
	//   description: 'Premium tier with higher rate limits and richer data',
	//   mimeType: 'application/json',
	// }),
};
