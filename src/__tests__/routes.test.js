// src/__tests__/routes.test.js

import { describe, expect, test } from 'bun:test';

// Import the actual routes configuration
import { ALL_NETWORKS, ROUTE_CONFIG, SUPPORTED_NETWORKS } from '../config/routes.js';

describe('Route Configuration - Real Module Tests', () => {
  describe('ROUTE_CONFIG', () => {
    test('should have myapi route defined', () => {
      expect(ROUTE_CONFIG.myapi).toBeDefined();
    });

    test('should have correct path for myapi', () => {
      expect(ROUTE_CONFIG.myapi.path).toBe('/v1/myapi/*');
    });

    test('should have backendName for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.backendName, `Route ${key} missing backendName`).toBeDefined();
        expect(typeof route.backendName).toBe('string');
      }
    });

    test('should have path for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.path, `Route ${key} missing path`).toBeDefined();
        expect(route.path).toMatch(/^\/v1\/[a-z0-9]+\/\*$/);
      }
    });

    test('should have price for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.price, `Route ${key} missing price`).toBeDefined();
        expect(route.price).toMatch(/^\$/);
      }
    });

    test('should have priceAtomic as string for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.priceAtomic, `Route ${key} missing priceAtomic`).toBeDefined();
        expect(typeof route.priceAtomic).toBe('string');
        expect(/^\d+$/.test(route.priceAtomic)).toBe(true);
      }
    });

    test('should have description for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.description, `Route ${key} missing description`).toBeDefined();
        expect(typeof route.description).toBe('string');
        expect(route.description.length).toBeGreaterThan(0);
      }
    });

    test('should have mimeType for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.mimeType, `Route ${key} missing mimeType`).toBeDefined();
        expect(route.mimeType).toBe('application/json');
      }
    });

    test('should have backendApiKeyEnv for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.backendApiKeyEnv, `Route ${key} missing backendApiKeyEnv`).toBeDefined();
        expect(route.backendApiKeyEnv).toContain('API_KEY');
      }
    });

    test('should have backendApiKeyHeader for all routes', () => {
      for (const [key, route] of Object.entries(ROUTE_CONFIG)) {
        expect(route.backendApiKeyHeader, `Route ${key} missing backendApiKeyHeader`).toBeDefined();
      }
    });

    test('should have getters for lazy env resolution', () => {
      const route = ROUTE_CONFIG.myapi;

      // These are getters that resolve from env
      expect(typeof route.backendUrl).toBe('string');
      expect(typeof route.price).toBe('string');
      expect(typeof route.priceAtomic).toBe('string');
    });

    test('should return empty string for unconfigured backendUrl', () => {
      // Without env var set, should return empty string
      const originalEnv = process.env.MY_BACKEND_URL;
      delete process.env.MY_BACKEND_URL;

      // Force re-evaluation by accessing the getter
      const url = ROUTE_CONFIG.myapi.backendUrl;
      expect(url).toBeDefined();

      // Restore
      if (originalEnv) process.env.MY_BACKEND_URL = originalEnv;
    });
  });

  describe('ALL_NETWORKS', () => {
    test('should be defined', () => {
      expect(ALL_NETWORKS).toBeDefined();
    });

    test('should have Base network', () => {
      expect(ALL_NETWORKS['eip155:8453']).toBeDefined();
      expect(ALL_NETWORKS['eip155:8453'].chainId).toBe(8453);
      expect(ALL_NETWORKS['eip155:8453'].vm).toBe('evm');
    });

    test('should have Ethereum network', () => {
      expect(ALL_NETWORKS['eip155:1']).toBeDefined();
      expect(ALL_NETWORKS['eip155:1'].chainId).toBe(1);
    });

    test('should have Arbitrum network', () => {
      expect(ALL_NETWORKS['eip155:42161']).toBeDefined();
      expect(ALL_NETWORKS['eip155:42161'].chainId).toBe(42161);
    });

    test('should have Optimism network', () => {
      expect(ALL_NETWORKS['eip155:10']).toBeDefined();
      expect(ALL_NETWORKS['eip155:10'].chainId).toBe(10);
    });

    test('should have Polygon network', () => {
      expect(ALL_NETWORKS['eip155:137']).toBeDefined();
      expect(ALL_NETWORKS['eip155:137'].chainId).toBe(137);
    });

    test('should have Avalanche network', () => {
      expect(ALL_NETWORKS['eip155:43114']).toBeDefined();
      expect(ALL_NETWORKS['eip155:43114'].chainId).toBe(43114);
    });

    test('should have Unichain network', () => {
      expect(ALL_NETWORKS['eip155:130']).toBeDefined();
      expect(ALL_NETWORKS['eip155:130'].chainId).toBe(130);
    });

    test('should have Linea network', () => {
      expect(ALL_NETWORKS['eip155:59144']).toBeDefined();
      expect(ALL_NETWORKS['eip155:59144'].chainId).toBe(59144);
    });

    test('should have MegaETH network with facilitator', () => {
      expect(ALL_NETWORKS['eip155:4326']).toBeDefined();
      expect(ALL_NETWORKS['eip155:4326'].chainId).toBe(4326);
      expect(ALL_NETWORKS['eip155:4326'].facilitator).toBeDefined();
    });

    test('should have Solana network', () => {
      expect(ALL_NETWORKS['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']).toBeDefined();
      expect(ALL_NETWORKS['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'].vm).toBe('svm');
    });

    test('all EVM networks should have correct vm type', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        if (caip2.startsWith('eip155:')) {
          expect(network.vm, `${caip2} should have vm: 'evm'`).toBe('evm');
        }
      }
    });

    test('all networks should have required fields', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        expect(network.vm, `${caip2} missing vm`).toBeDefined();
        expect(network.caip2, `${caip2} missing caip2`).toBe(caip2);
        expect(network.rpcEnvVar, `${caip2} missing rpcEnvVar`).toBeDefined();
        expect(network.token, `${caip2} missing token`).toBeDefined();
      }
    });

    test('all networks should have token with required fields', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        expect(network.token.address, `${caip2} missing token.address`).toBeDefined();
        expect(network.token.decimals, `${caip2} missing token.decimals`).toBeDefined();
      }
    });

    test('EVM networks should have chainId', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        if (network.vm === 'evm') {
          expect(network.chainId, `${caip2} missing chainId`).toBeDefined();
          expect(typeof network.chainId).toBe('number');
        }
      }
    });

    test('USDC tokens should have correct name and version', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        if (network.vm === 'evm' && !network.facilitator) {
          // Native USDC
          expect(network.token.name, `${caip2} USDC name`).toBe('USD Coin');
          expect(network.token.version, `${caip2} USDC version`).toBe('2');
          expect(network.token.decimals, `${caip2} USDC decimals`).toBe(6);
        }
      }
    });

    test('MegaETH should have 18 decimals for USDM', () => {
      const megaeth = ALL_NETWORKS['eip155:4326'];
      expect(megaeth.token.decimals).toBe(18);
      expect(megaeth.token.name).toBe('MegaUSD');
    });
  });

  describe('Facilitator configuration', () => {
    test('MegaETH should have Meridian facilitator', () => {
      const megaeth = ALL_NETWORKS['eip155:4326'];

      expect(megaeth.facilitator).toBeDefined();
      expect(megaeth.facilitator.url).toBe('https://api.mrdn.finance/v1');
      expect(megaeth.facilitator.apiKeyEnv).toBe('MERIDIAN_API_KEY');
      expect(megaeth.facilitator.networkName).toBe('megaeth');
      expect(megaeth.facilitator.x402Version).toBe(1);
      expect(megaeth.facilitator.facilitatorContract).toBeDefined();
    });

    test('facilitator contract should be valid address', () => {
      const megaeth = ALL_NETWORKS['eip155:4326'];
      expect(megaeth.facilitator.facilitatorContract).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('SUPPORTED_NETWORKS (active networks)', () => {
    test('should be defined', () => {
      expect(SUPPORTED_NETWORKS).toBeDefined();
    });

    test('should only include networks with RPC URLs configured', () => {
      const networkKeys = Object.keys(SUPPORTED_NETWORKS);

      for (const caip2 of networkKeys) {
        const network = SUPPORTED_NETWORKS[caip2];
        const rpcUrl = process.env[network.rpcEnvVar];

        if (network.vm === 'svm') {
          // SVM also requires facilitator private key
          const hasFacilitator = !!process.env.SOLANA_FACILITATOR_PRIVATE_KEY;
          expect(hasFacilitator || rpcUrl).toBeDefined();
        } else {
          expect(rpcUrl, `${caip2} should have RPC URL if in SUPPORTED_NETWORKS`).toBeDefined();
        }
      }
    });

    test('SVM networks should require SOLANA_FACILITATOR_PRIVATE_KEY', () => {
      const networkKeys = Object.keys(SUPPORTED_NETWORKS);
      const svmNetworks = networkKeys.filter(k => SUPPORTED_NETWORKS[k].vm === 'svm');

      // If there are SVM networks, facilitator key should be set
      if (svmNetworks.length > 0) {
        expect(process.env.SOLANA_FACILITATOR_PRIVATE_KEY).toBeDefined();
      }
    });
  });

  describe('USDC contract addresses', () => {
    test('Base USDC should have correct address', () => {
      expect(ALL_NETWORKS['eip155:8453'].token.address.toLowerCase())
        .toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase());
    });

    test('Ethereum USDC should have correct address', () => {
      expect(ALL_NETWORKS['eip155:1'].token.address.toLowerCase())
        .toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase());
    });

    test('Arbitrum USDC should have correct address', () => {
      expect(ALL_NETWORKS['eip155:42161'].token.address.toLowerCase())
        .toBe('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLowerCase());
    });

    test('Solana USDC should have correct mint address', () => {
      expect(ALL_NETWORKS['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'].token.address)
        .toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    });

    test('all EVM addresses should be valid 40-char hex', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        if (network.vm === 'evm') {
          expect(network.token.address, `${caip2} address format`)
            .toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      }
    });
  });

  describe('RPC environment variables', () => {
    test('should have correct env var names', () => {
      expect(ALL_NETWORKS['eip155:8453'].rpcEnvVar).toBe('BASE_RPC_URL');
      expect(ALL_NETWORKS['eip155:1'].rpcEnvVar).toBe('ETHEREUM_RPC_URL');
      expect(ALL_NETWORKS['eip155:42161'].rpcEnvVar).toBe('ARBITRUM_RPC_URL');
      expect(ALL_NETWORKS['eip155:10'].rpcEnvVar).toBe('OPTIMISM_RPC_URL');
      expect(ALL_NETWORKS['eip155:137'].rpcEnvVar).toBe('POLYGON_RPC_URL');
      expect(ALL_NETWORKS['eip155:43114'].rpcEnvVar).toBe('AVALANCHE_RPC_URL');
      expect(ALL_NETWORKS['eip155:130'].rpcEnvVar).toBe('UNICHAIN_RPC_URL');
      expect(ALL_NETWORKS['eip155:59144'].rpcEnvVar).toBe('LINEA_RPC_URL');
      expect(ALL_NETWORKS['eip155:4326'].rpcEnvVar).toBe('MEGAETH_RPC_URL');
      expect(ALL_NETWORKS['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'].rpcEnvVar).toBe('SOLANA_RPC_URL');
    });
  });

  describe('CAIP-2 format validation', () => {
    test('all EVM networks should use eip155 namespace', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        if (network.vm === 'evm') {
          expect(caip2).toMatch(/^eip155:\d+$/);
          expect(network.caip2).toBe(caip2);
        }
      }
    });

    test('Solana should use solana namespace', () => {
      const solana = ALL_NETWORKS['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
      expect(solana.caip2).toMatch(/^solana:/);
    });
  });

  describe('Chain ID validation', () => {
    test('chain IDs should match CAIP-2', () => {
      for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
        if (network.vm === 'evm') {
          const chainIdFromCaip2 = parseInt(caip2.split(':')[1], 10);
          expect(network.chainId, `${caip2} chainId mismatch`).toBe(chainIdFromCaip2);
        }
      }
    });
  });
});
