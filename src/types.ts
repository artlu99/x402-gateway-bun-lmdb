// Shared type definitions for x402 payment gateway

// ============================================================
// Virtual Machine Types
// ============================================================

export type VMType = 'evm' | 'svm';

// ============================================================
// Payment Payload Types
// ============================================================

export interface PaymentAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayloadExtensions {
  'payment-identifier'?: {
    paymentId: string;
  };
  [key: string]: unknown;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    authorization?: PaymentAuthorization;
    signature?: string;
    transaction?: string;
    extensions?: PaymentPayloadExtensions;
  };
  extensions?: PaymentPayloadExtensions;
}

// ============================================================
// Network Configuration Types
// ============================================================

export interface TokenConfig {
  address: string;
  name: string;
  version: string;
  decimals: number;
}

export interface FacilitatorConfig {
  url: string;
  apiKeyEnv: string;
  networkName?: string;
  facilitatorContract?: string;
  x402Version?: number;
}

export interface NetworkConfig {
  vm: VMType;
  caip2: string;
  chainId?: number;
  rpcEnvVar: string;
  token: TokenConfig;
  facilitator?: FacilitatorConfig;
}

export type NetworkRegistry = Record<string, NetworkConfig>;

// ============================================================
// Route Configuration Types
// ============================================================

export interface RouteConfig {
  path: string;
  backendName: string;
  readonly backendUrl: string;
  backendApiKeyEnv: string;
  backendApiKeyHeader: string;
  readonly price: string;
  readonly priceAtomic: string;
  readonly payTo: string | undefined;
  readonly payToSol: string | undefined;
  description: string;
  mimeType: string;
  resource?: string;
}

export type RouteRegistry = Record<string, RouteConfig>;

// ============================================================
// Redis Data Types
// ============================================================

export type NonceStatus = 'pending' | 'confirmed';

export interface NonceData {
  status: NonceStatus;
  timestamp: number;
  network?: string;
  payer?: string;
  route?: string;
  vm?: VMType;
  txHash?: string;
  blockNumber?: number;
}

export interface IdempotencyCache {
  timestamp: number;
  response: {
    paymentResponseHeader?: string;
    settlement?: PaymentResponseData;
    [key: string]: unknown;
  };
}

// ============================================================
// Verification and Settlement Types
// ============================================================

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  payer?: string;
}

export interface SettlementResult {
  txHash: string;
  network: string;
  blockNumber: number | null;
  payer?: string;
  facilitator?: string;
}

export interface PaymentResponseData {
  success: boolean;
  txHash: string;
  network: string;
  blockNumber?: number | null;
  facilitator?: string;
}

// ============================================================
// Payment Required Response Types
// ============================================================

export interface PaymentAccept {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  amount: string;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  asset: string;
  extra: Record<string, unknown>;
}

export interface PaymentRequiredBody {
  x402Version: number;
  accepts: PaymentAccept[];
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  extensions: Record<string, unknown>;
  error?: string;
  message?: string;
  reason?: string;
}

export interface PaymentRequiredResponse {
  headerBase64: string;
  body: PaymentRequiredBody;
}

// ============================================================
// Proxy Types
// ============================================================

export interface ProxyOptions {
  req: Request;
  targetBase: string;
  targetPath: string;
  apiKey?: string;
  apiKeyHeader?: string;
  forceMethod?: string;
}

// ============================================================
// Payment Context (for middleware wrapper)
// ============================================================

export interface PaymentContext {
  payer?: string;
  txHash?: string;
  network?: string;
  blockNumber?: number | null;
  facilitator?: string;
}

// ============================================================
// SVM Facilitator Types
// ============================================================

export interface SvmFacilitatorResult {
  facilitator: unknown;
  feePayerAddress: string;
}

export interface SvmVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SvmSettleResult {
  success: boolean;
  errorReason?: string;
  transaction?: string;
  network?: string;
  payer?: string;
}
