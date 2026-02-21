import crypto from "node:crypto";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { type FacilitatorRpcConfig, toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import invariant from "tiny-invariant";
import {
	type Chain,
	createPublicClient,
	createWalletClient,
	type Hex,
	http,
	type PublicClient,
	parseAbi,
	parseSignature,
	verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	arbitrum,
	avalanche,
	base,
	linea,
	mainnet,
	megaeth,
	optimism,
	polygon,
	unichain,
} from "viem/chains";
import { ROUTE_CONFIG, SUPPORTED_NETWORKS } from "../config/routes";
import type {
	NetworkConfig,
	PaymentContext,
	PaymentPayload,
	PaymentResponseData,
	RouteConfig,
	SettlementResult,
	VerificationResult,
} from "../types";
import {
	CORS_HEADERS,
	corsJsonWithHeaders,
} from "../utils/cors";
import {
	deleteNonce,
	getIdempotencyCache,
	getNonce,
	setIdempotencyCache,
	setNonceConfirmed,
	setNoncePending,
} from "../utils/store";

// ============================================================
// EIP-3009 transferWithAuthorization ABI (EVM only)
// ============================================================
const ERC3009_ABI = parseAbi([
	"function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
	"function balanceOf(address account) view returns (uint256)",
]);

// ============================================================
// EIP-712 types for TransferWithAuthorization (EVM only)
// ============================================================
const EIP712_TYPES = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

// ============================================================
// Viem chain configs (EVM only)
// Add new chains here when adding EVM network support
// ============================================================
const VIEM_CHAINS: Record<number, Chain> = {
	1: mainnet,
	8453: base,
	42161: arbitrum,
	10: optimism,
	137: polygon,
	43114: avalanche,
	59144: linea,
	130: unichain,
	4326: megaeth,
	// Add more: import from viem/chains and register here
};

function getViemChain(network: NetworkConfig): Chain {
	if (network.chainId === undefined) {
		throw new Error(`Network ${network.caip2} has no chainId`);
	}
	const known = VIEM_CHAINS[network.chainId];
	if (known) return known;

	// Fallback for unknown chains — provide minimal config
	const rpcUrl = process.env[network.rpcEnvVar];
	if (!rpcUrl) {
		throw new Error(`No RPC URL for ${network.caip2}`);
	}
	return {
		id: network.chainId,
		name: `Chain ${network.chainId}`,
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: {
			default: { http: [rpcUrl] },
		},
	} as Chain;
}

// ============================================================
// Cache public clients per chain (EVM only)
// ============================================================
const publicClientCache = new Map<number, PublicClient>();

function getPublicClient(network: NetworkConfig): PublicClient | null {
	if (network.chainId === undefined) return null;

	const cacheKey = network.chainId;
	if (publicClientCache.has(cacheKey)) {
		return publicClientCache.get(cacheKey) ?? null;
	}

	const rpcUrl = process.env[network.rpcEnvVar];
	if (!rpcUrl) return null;

	const chain = getViemChain(network);
	const client = createPublicClient({ chain, transport: http(rpcUrl) });
	publicClientCache.set(cacheKey, client);
	return client;
}

// ============================================================
// SVM Facilitator — lazy singleton
// ============================================================
interface SvmFacilitatorInstance {
	facilitator: ExactSvmScheme;
	feePayerAddress: string;
}

let _svmFacilitator: ExactSvmScheme | null = null;
let _svmFacilitatorAddress: string | null = null;
let _svmInitPromise: Promise<SvmFacilitatorInstance> | null = null;

async function getSvmFacilitator(): Promise<SvmFacilitatorInstance> {
	if (_svmFacilitator && _svmFacilitatorAddress) {
		return {
			facilitator: _svmFacilitator,
			feePayerAddress: _svmFacilitatorAddress,
		};
	}
	if (_svmInitPromise) return _svmInitPromise;

	_svmInitPromise = (async (): Promise<SvmFacilitatorInstance> => {
		const privKeyBase58 = process.env.SOLANA_FACILITATOR_PRIVATE_KEY;
		if (!privKeyBase58) {
			throw new Error("SOLANA_FACILITATOR_PRIVATE_KEY not configured");
		}

		const privKeyBytes = base58.decode(privKeyBase58);
		const keypairSigner = await createKeyPairSignerFromBytes(privKeyBytes);

		const rpcConfig = { defaultRpcUrl: process.env.SOLANA_RPC_URL };
		const facilitatorSigner = toFacilitatorSvmSigner(
			keypairSigner,
			rpcConfig as FacilitatorRpcConfig,
		);
		const facilitator = new ExactSvmScheme(facilitatorSigner);

		const addresses = facilitatorSigner.getAddresses();
		const feePayerAddress = addresses[0]?.toString();
		if (!feePayerAddress) {
			throw new Error(
				"Failed to derive fee payer address from SOLANA_FACILITATOR_PRIVATE_KEY",
			);
		}

		console.log(
			`[x402] SVM facilitator initialized | feePayer: ${feePayerAddress}`,
		);

		_svmFacilitator = facilitator;
		_svmFacilitatorAddress = feePayerAddress;
		_svmInitPromise = null;
		return { facilitator, feePayerAddress };
	})();

	return _svmInitPromise;
}

// ============================================================
// Helpers
// ============================================================
function isSvmNetwork(network: NetworkConfig): boolean {
	return network.vm === "svm";
}

interface BalanceCheckResult {
	sufficient: boolean;
	balance?: string;
	required?: string;
}

async function checkBalance(
	network: NetworkConfig,
	from: Hex,
	requiredAmount: bigint,
): Promise<BalanceCheckResult> {
	if (network.chainId === undefined) {
		return { sufficient: true };
	}

	const client = getPublicClient(network);
	if (!client) {
		console.warn(
			`[x402] No public client for chain ${network.chainId}, skipping balance check`,
		);
		return { sufficient: true };
	}

	try {
		const balance = await client.readContract({
			address: network.token.address as Hex,
			abi: ERC3009_ABI,
			functionName: "balanceOf",
			args: [from],
		});

		if (balance < requiredAmount) {
			return {
				sufficient: false,
				balance: balance.toString(),
				required: requiredAmount.toString(),
			};
		}
		return { sufficient: true, balance: balance.toString() };
	} catch (err) {
		const error = err as Error;
		console.warn(
			`[x402] Balance check failed (non-critical): ${error.message}`,
		);
		return { sufficient: true };
	}
}

function extractPaymentIdentifier(
	paymentPayload: PaymentPayload,
): string | null {
	try {
		const extensions =
			paymentPayload.extensions ?? paymentPayload.payload?.extensions;
		if (!extensions) return null;
		const idExt = extensions["payment-identifier"];
		if (idExt?.paymentId && typeof idExt.paymentId === "string") {
			const id = idExt.paymentId;
			if (id.length >= 16 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id)) {
				return id;
			}
		}
		return null;
	} catch {
		return null;
	}
}

// ============================================================
// Helper: Get request URL info from native Request
// ============================================================
function getRequestUrl(req: Request): {
	protocol: string;
	host: string;
	resource: string;
} {
	const url = new URL(req.url);
	const host = req.headers.get("host") ?? "localhost";
	// url.protocol includes the colon, but we need it for constructing URLs
	const protocol = url.protocol.replace(":", "");
	const resource = `${protocol}://${host}${url.pathname}${url.search}`;
	return { protocol, host, resource };
}

// ============================================================
// EVM: Verify payment (local, no facilitator)
// ============================================================
async function verifyPaymentEvm(
	paymentPayload: PaymentPayload,
	routeConfig: RouteConfig,
): Promise<VerificationResult> {
	const { authorization, signature } = paymentPayload.payload;

	if (!authorization || !signature) {
		return { valid: false, reason: "Missing authorization or signature" };
	}

	const network = SUPPORTED_NETWORKS[paymentPayload.network];

	if (!network)
		return {
			valid: false,
			reason: `Unsupported network: ${paymentPayload.network}`,
		};
	if (paymentPayload.scheme !== "exact")
		return {
			valid: false,
			reason: `Unsupported scheme: ${paymentPayload.scheme}`,
		};

	// Check amount
	const basePriceAtomic = BigInt(routeConfig.priceAtomic);
	const decimalDiff = network.token.decimals - 6;
	const requiredAmount =
		decimalDiff > 0
			? basePriceAtomic * 10n ** BigInt(decimalDiff)
			: basePriceAtomic;
	if (BigInt(authorization.value) < requiredAmount) {
		return {
			valid: false,
			reason: `Insufficient payment: got ${authorization.value}, need ${requiredAmount}`,
		};
	}

	// Check recipient
	const payTo = routeConfig.payTo?.toLowerCase();
	if (!payTo) return { valid: false, reason: "No payTo address configured" };
	if (authorization.to.toLowerCase() !== payTo)
		return { valid: false, reason: `Wrong recipient: expected ${payTo}` };

	// Check validity window
	const now = Math.floor(Date.now() / 1000);
	if (now < Number(authorization.validAfter))
		return { valid: false, reason: "Payment not yet valid" };
	if (now > Number(authorization.validBefore))
		return { valid: false, reason: "Payment expired" };

	// Check nonce to prevent replay
	const existing = await getNonce(authorization.nonce);
	if (existing)
		return {
			valid: false,
			reason: `Nonce already used (${existing.status ?? "unknown"})`,
		};

	// Verify EIP-712 signature
	if (network.chainId === undefined) {
		return { valid: false, reason: "Network has no chainId" };
	}

	const domain = {
		name: network.token.name,
		version: network.token.version,
		chainId: network.chainId,
		verifyingContract: network.token.address as Hex,
	};
	const message = {
		from: authorization.from as Hex,
		to: authorization.to as Hex,
		value: BigInt(authorization.value),
		validAfter: BigInt(authorization.validAfter),
		validBefore: BigInt(authorization.validBefore),
		nonce: authorization.nonce as Hex,
	};

	try {
		const isValid = await verifyTypedData({
			address: authorization.from as Hex,
			domain,
			types: EIP712_TYPES,
			primaryType: "TransferWithAuthorization",
			message,
			signature: signature as Hex,
		});
		if (!isValid)
			return { valid: false, reason: "Signature does not match sender" };
	} catch (err) {
		const error = err as Error;
		return {
			valid: false,
			reason: `Signature verification failed: ${error.message}`,
		};
	}

	// Balance check
	const balanceCheck = await checkBalance(
		network,
		authorization.from as Hex,
		requiredAmount,
	);
	if (!balanceCheck.sufficient) {
		return {
			valid: false,
			reason: `Insufficient balance: has ${balanceCheck.balance}, needs ${balanceCheck.required}`,
		};
	}

	return { valid: true };
}

// ============================================================
// EVM: Settle payment on-chain
// ============================================================
async function settlePaymentEvm(
	paymentPayload: PaymentPayload,
): Promise<SettlementResult> {
	const { authorization, signature } = paymentPayload.payload;

	if (!authorization || !signature) {
		throw new Error("Missing authorization or signature");
	}

	const network = SUPPORTED_NETWORKS[paymentPayload.network];
	if (!network) {
		throw new Error(`Unsupported network: ${paymentPayload.network}`);
	}

	const rpcUrl = process.env[network.rpcEnvVar];

	if (!rpcUrl)
		throw new Error(
			`No RPC URL for ${paymentPayload.network} (env: ${network.rpcEnvVar})`,
		);

	const chain = getViemChain(network);
	const settlementKey = process.env.SETTLEMENT_PRIVATE_KEY;
	if (!settlementKey) {
		throw new Error("SETTLEMENT_PRIVATE_KEY not configured");
	}
	const account = privateKeyToAccount(settlementKey as Hex);

	const walletClient = createWalletClient({
		account,
		chain,
		transport: http(rpcUrl),
	});
	const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

	const { v, r, s } = parseSignature(signature as Hex);

	const txHash = await walletClient.writeContract({
		address: network.token.address as Hex,
		abi: ERC3009_ABI,
		functionName: "transferWithAuthorization",
		args: [
			authorization.from as Hex,
			authorization.to as Hex,
			BigInt(authorization.value),
			BigInt(authorization.validAfter),
			BigInt(authorization.validBefore),
			authorization.nonce as Hex,
			Number(v),
			r,
			s,
		],
	});

	const receipt = await publicClient.waitForTransactionReceipt({
		hash: txHash,
		confirmations: 1,
	});
	console.log(
		`[x402] EVM settled: ${txHash} | block ${receipt.blockNumber} | payer ${authorization.from}`,
	);

	return {
		txHash,
		network: paymentPayload.network,
		blockNumber: Number(receipt.blockNumber),
	};
}

// ============================================================
// SVM: Verify payment via @x402/svm facilitator
// ============================================================
interface SvmSettleResultInternal {
	success: boolean;
	errorReason?: string;
	transaction?: string;
	network?: string;
	payer?: string;
}

async function verifyPaymentSvm(
	paymentPayload: PaymentPayload,
	routeConfig: RouteConfig,
	network: NetworkConfig,
): Promise<VerificationResult> {
	const { facilitator, feePayerAddress } = await getSvmFacilitator();

	const payTo = routeConfig.payToSol;
	if (!payTo)
		return { valid: false, reason: "No Solana payTo address configured" };

	const basePriceAtomic = BigInt(routeConfig.priceAtomic);
	const decimalDiff = network.token.decimals - 6;
	const amountRequired =
		decimalDiff > 0
			? (basePriceAtomic * 10n ** BigInt(decimalDiff)).toString()
			: basePriceAtomic.toString();

	const svmPayload = {
		payload: paymentPayload.payload,
		accepted: { scheme: "exact", network: paymentPayload.network },
	};
	const svmRequirements = {
		scheme: "exact",
		network: paymentPayload.network,
		amount: amountRequired,
		asset: network.token.address,
		payTo,
		extra: { feePayer: feePayerAddress },
	};

	try {
		// biome-ignore lint/suspicious/noExplicitAny: @x402/svm library
		const result = await (facilitator.verify as any)(
			svmPayload,
			svmRequirements,
		);
		if (!result.isValid) {
			return {
				valid: false,
				reason: `SVM verification failed: ${result.invalidReason ?? "unknown"}`,
			};
		}
		invariant(result.payer, "Payer is required");
		return { valid: true, payer: result.payer };
	} catch (err) {
		const error = err as Error;
		return { valid: false, reason: `SVM verification error: ${error.message}` };
	}
}

// ============================================================
// SVM: Settle payment via @x402/svm facilitator
// ============================================================
async function settlePaymentSvm(
	paymentPayload: PaymentPayload,
	routeConfig: RouteConfig,
	network: NetworkConfig,
): Promise<SettlementResult> {
	const { facilitator, feePayerAddress } = await getSvmFacilitator();

	const payTo = routeConfig.payToSol;
	if (!payTo) throw new Error("No Solana payTo address configured");

	const basePriceAtomic = BigInt(routeConfig.priceAtomic);
	const decimalDiff = network.token.decimals - 6;
	const amountRequired =
		decimalDiff > 0
			? (basePriceAtomic * 10n ** BigInt(decimalDiff)).toString()
			: basePriceAtomic.toString();

	const svmPayload = {
		payload: paymentPayload.payload,
		accepted: { scheme: "exact", network: paymentPayload.network },
	};
	const svmRequirements = {
		scheme: "exact",
		network: paymentPayload.network,
		amount: amountRequired,
		asset: network.token.address,
		payTo,
		extra: { feePayer: feePayerAddress },
	};

	// biome-ignore lint/suspicious/noExplicitAny: @x402/svm library
	const result = (await (facilitator.settle as any)(
		svmPayload,
		svmRequirements,
	)) as SvmSettleResultInternal;
	if (!result.success)
		throw new Error(
			`SVM settlement failed: ${result.errorReason ?? "unknown"}`,
		);
	invariant(result.payer, "Payer is required");

	console.log(
		`[x402] SVM settled: ${result.transaction} | payer ${result.payer}`,
	);
	return {
		txHash: result.transaction ?? "",
		network: result.network ?? paymentPayload.network,
		blockNumber: null,
		payer: result.payer,
	};
}

// ============================================================
// Facilitator-based verify (EVM, external service)
// ============================================================
async function verifyPaymentViaFacilitator(
	paymentPayload: PaymentPayload,
	routeConfig: RouteConfig,
	network: NetworkConfig,
): Promise<VerificationResult> {
	const facilitatorConfig = network.facilitator;
	if (!facilitatorConfig) {
		return { valid: false, reason: "No facilitator configured" };
	}

	const { url, apiKeyEnv, networkName, facilitatorContract, x402Version } =
		facilitatorConfig;
	const apiKey = process.env[apiKeyEnv];
	if (!apiKey)
		return {
			valid: false,
			reason: `No API key for facilitator (env: ${apiKeyEnv})`,
		};

	const basePriceAtomic = BigInt(routeConfig.priceAtomic);
	const decimalDiff = network.token.decimals - 6;
	const amountRequired =
		decimalDiff > 0
			? (basePriceAtomic * 10n ** BigInt(decimalDiff)).toString()
			: basePriceAtomic.toString();

	const facilitatorNetwork = networkName ?? paymentPayload.network;
	const facilitatorPayTo = facilitatorContract ?? routeConfig.payTo;

	const body = {
		paymentPayload: {
			x402Version: x402Version ?? paymentPayload.x402Version ?? 2,
			scheme: paymentPayload.scheme,
			network: facilitatorNetwork,
			payload: paymentPayload.payload,
		},
		paymentRequirements: {
			scheme: "exact",
			network: facilitatorNetwork,
			maxAmountRequired: amountRequired,
			maxTimeoutSeconds: 3600,
			payTo: facilitatorPayTo,
			asset: network.token.address,
			resource: routeConfig.resource ?? "",
			description: routeConfig.description,
			mimeType: routeConfig.mimeType,
			amount: amountRequired,
			recipient: facilitatorPayTo,
		},
	};

	try {
		console.log(
			`[x402] Facilitator verify: ${url}/verify | network: ${facilitatorNetwork}`,
		);
		const res = await fetch(`${url}/verify`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});

		const resText = await res.text();
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(resText) as Record<string, unknown>;
		} catch {
			return {
				valid: false,
				reason: `Facilitator returned non-JSON (${res.status})`,
			};
		}

		if (!res.ok) {
			const errorObj = data.error as Record<string, unknown> | undefined;
			return {
				valid: false,
				reason: `Facilitator error (${res.status}): ${(errorObj?.message as string) ?? (data.invalidReason as string) ?? JSON.stringify(data)}`,
			};
		}
		if (data.isValid === true) {
			invariant(data.payer, "Payer is required");
			invariant(typeof data.payer === "string", "Payer must be a string");
			return { valid: true, payer: data.payer };
		}
		return {
			valid: false,
			reason: (data.invalidReason as string) ?? "Facilitator rejected payment",
		};
	} catch (err) {
		const error = err as Error;
		return {
			valid: false,
			reason: `Facilitator verify failed: ${error.message}`,
		};
	}
}

// ============================================================
// Facilitator-based settle (EVM, external service)
// ============================================================
async function settlePaymentViaFacilitator(
	paymentPayload: PaymentPayload,
	routeConfig: RouteConfig,
	network: NetworkConfig,
): Promise<SettlementResult> {
	const facilitatorConfig = network.facilitator;
	if (!facilitatorConfig) {
		throw new Error("No facilitator configured");
	}

	const { url, apiKeyEnv, networkName, facilitatorContract, x402Version } =
		facilitatorConfig;
	const apiKey = process.env[apiKeyEnv];
	if (!apiKey) {
		throw new Error(`No API key for facilitator (env: ${apiKeyEnv})`);
	}

	const basePriceAtomic = BigInt(routeConfig.priceAtomic);
	const decimalDiff = network.token.decimals - 6;
	const amountRequired =
		decimalDiff > 0
			? (basePriceAtomic * 10n ** BigInt(decimalDiff)).toString()
			: basePriceAtomic.toString();

	const facilitatorNetwork = networkName ?? paymentPayload.network;
	const facilitatorPayTo = facilitatorContract ?? routeConfig.payTo;

	const body = {
		paymentPayload: {
			x402Version: x402Version ?? paymentPayload.x402Version ?? 2,
			scheme: paymentPayload.scheme,
			network: facilitatorNetwork,
			payload: paymentPayload.payload,
		},
		paymentRequirements: {
			scheme: "exact",
			network: facilitatorNetwork,
			maxAmountRequired: amountRequired,
			maxTimeoutSeconds: 3600,
			payTo: facilitatorPayTo,
			asset: network.token.address,
			resource: routeConfig.resource ?? "",
			description: routeConfig.description,
			mimeType: routeConfig.mimeType,
			amount: amountRequired,
			recipient: facilitatorPayTo,
		},
	};

	console.log(
		`[x402] Facilitator settle: ${url}/settle | network: ${facilitatorNetwork}`,
	);
	const res = await fetch(`${url}/settle`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	const data = (await res.json()) as Record<string, unknown>;
	if (!res.ok || data.success !== true) {
		const errorObj = data.error as Record<string, unknown> | undefined;
		throw new Error(
			`Facilitator settle failed: ${(data.errorReason as string) ?? (errorObj?.message as string) ?? JSON.stringify(data)}`,
		);
	}

	console.log(
		`[x402] Settled via facilitator: ${data.transaction as string} | network ${data.network as string}`,
	);
	return {
		txHash: data.transaction as string,
		network: (data.network as string) ?? paymentPayload.network,
		blockNumber: null,
		facilitator: url,
	};
}

// ============================================================
// Build 402 Payment Required response
// ============================================================
interface PaymentRequiredResult {
	headerBase64: string;
	body: {
		x402Version: number;
		accepts: Array<{
			scheme: string;
			network: string;
			amount: string;
			payTo: string;
			maxTimeoutSeconds: number;
			asset: string;
			extra: Record<string, unknown>;
		}>;
		resource: {
			url: string;
			description: string;
			mimeType: string;
		};
		extensions: Record<string, unknown>;
		error?: string;
		message?: string;
		reason?: string;
	};
}

async function buildPaymentRequired(
	routeConfig: RouteConfig,
	req: Request,
	_routeKey: string,
): Promise<PaymentRequiredResult> {
	const { resource } = getRequestUrl(req);
	const basePriceAtomic = BigInt(routeConfig.priceAtomic);

	// Get SVM fee payer if any SVM networks are active
	let svmFeePayerAddress: string | null = null;
	const hasSvmNetworks = Object.values(SUPPORTED_NETWORKS).some(
		(n) => n.vm === "svm",
	);
	if (hasSvmNetworks) {
		try {
			const { feePayerAddress } = await getSvmFacilitator();
			svmFeePayerAddress = feePayerAddress;
		} catch (err) {
			const error = err as Error;
			console.warn(
				`[x402] Could not init SVM facilitator for 402 response: ${error.message}`,
			);
		}
	}

	const accepts: PaymentRequiredResult["body"]["accepts"] = [];

	for (const network of Object.values(SUPPORTED_NETWORKS)) {
		const decimalDiff = network.token.decimals - 6;
		const amountRequired =
			decimalDiff > 0
				? (basePriceAtomic * 10n ** BigInt(decimalDiff)).toString()
				: basePriceAtomic.toString();

		if (isSvmNetwork(network)) {
			const payTo = routeConfig.payToSol;
			if (!payTo || !svmFeePayerAddress) continue;

			accepts.push({
				scheme: "exact",
				network: network.caip2,
				amount: amountRequired,
				payTo,
				maxTimeoutSeconds: 3600,
				asset: network.token.address,
				extra: { feePayer: svmFeePayerAddress },
			});
		} else {
			const effectivePayTo =
				network.facilitator?.facilitatorContract ?? routeConfig.payTo;
			if (!effectivePayTo) continue;

			accepts.push({
				scheme: "exact",
				network: network.caip2,
				amount: amountRequired,
				payTo: effectivePayTo,
				maxTimeoutSeconds: 3600,
				asset: network.token.address,
				extra: { name: network.token.name, version: network.token.version },
			});
		}
	}

	const extensions = {
		"payment-identifier": { supported: true, required: false },
	};

	const headerPayload = {
		x402Version: 2,
		accepts: accepts.map((a) => ({
			...a,
			maxAmountRequired: a.amount,
			resource,
			description: routeConfig.description,
			mimeType: routeConfig.mimeType,
		})),
		resource: {
			url: resource,
			description: routeConfig.description,
			mimeType: routeConfig.mimeType,
		},
		extensions,
	};

	const headerBase64 = Buffer.from(JSON.stringify(headerPayload)).toString(
		"base64",
	);

	const body: PaymentRequiredResult["body"] = {
		x402Version: 2,
		accepts,
		resource: {
			url: resource,
			description: routeConfig.description,
			mimeType: routeConfig.mimeType,
		},
		extensions,
	};

	return { headerBase64, body };
}

// ============================================================
// Payment verification result (internal)
// ============================================================
interface VerifyAndSettleResult {
	error?: Response;
	context?: PaymentContext;
	paymentResponseHeader?: string;
}

// ============================================================
// Verify and settle payment (core logic, returns result)
// ============================================================
async function verifyAndSettlePayment(
	req: Request,
	routeKey: string,
): Promise<VerifyAndSettleResult> {
	const routeConfig = ROUTE_CONFIG[routeKey];
	if (!routeConfig) {
		return {
			error: corsJsonWithHeaders({ error: `Unknown route: ${routeKey}` }, 500),
		};
	}

	// Check for payment header
	const paymentHeader =
		req.headers.get("payment-signature") ?? req.headers.get("x-payment");

	if (!paymentHeader) {
		const { headerBase64, body } = await buildPaymentRequired(
			routeConfig,
			req,
			routeKey,
		);
		return {
			error: corsJsonWithHeaders(
				{
					...body,
					error: "Payment required",
					message: `This endpoint requires ${routeConfig.price} USDC. See accepts array for supported networks.`,
				},
				402,
				{ "PAYMENT-REQUIRED": headerBase64 },
			),
		};
	}

	// Decode payment payload
	let paymentPayload: PaymentPayload;
	try {
		paymentPayload = JSON.parse(
			Buffer.from(paymentHeader, "base64").toString(),
		) as PaymentPayload;
	} catch {
		return {
			error: corsJsonWithHeaders(
				{ error: "Invalid payment payload encoding" },
				400,
			),
		};
	}

	// Idempotency check
	const paymentId = extractPaymentIdentifier(paymentPayload);
	if (paymentId) {
		const cached = await getIdempotencyCache(paymentId);
		if (cached) {
			console.log(`[x402] Idempotency hit: ${paymentId.slice(0, 16)}...`);
			return {
				context: {},
				...(cached.response?.paymentResponseHeader && {
					paymentResponseHeader: cached.response.paymentResponseHeader,
				}),
			};
		}
	}

	// Resolve network
	const network = SUPPORTED_NETWORKS[paymentPayload.network];
	if (!network) {
		return {
			error: corsJsonWithHeaders(
				{
					error: "Unsupported network",
					reason: `Network ${paymentPayload.network} is not supported`,
				},
				402,
			),
		};
	}

	// Determine payment path
	const useSvm = isSvmNetwork(network);
	const useEvmFacilitator = !useSvm && !!network.facilitator;

	const { resource } = getRequestUrl(req);
	const enrichedRouteConfig: RouteConfig = {
		...routeConfig,
		resource,
	};

	// Verify payment
	let verification: VerificationResult;
	if (useSvm) {
		verification = await verifyPaymentSvm(
			paymentPayload,
			enrichedRouteConfig,
			network,
		);
	} else if (useEvmFacilitator) {
		verification = await verifyPaymentViaFacilitator(
			paymentPayload,
			enrichedRouteConfig,
			network,
		);
	} else {
		verification = await verifyPaymentEvm(paymentPayload, routeConfig);
	}

	if (!verification.valid) {
		const pathLabel = useSvm
			? "SVM"
			: useEvmFacilitator
				? "facilitator"
				: "EVM";
		console.warn(
			`[x402] Verification failed (${pathLabel}): ${verification.reason}`,
		);
		const { headerBase64, body } = await buildPaymentRequired(
			routeConfig,
			req,
			routeKey,
		);
		return {
			error: corsJsonWithHeaders(
				{
					...body,
					error: "Payment verification failed",
					reason: verification.reason,
				},
				402,
				{ "PAYMENT-REQUIRED": headerBase64 },
			),
		};
	}

	// Mark nonce as pending
	let nonceKey: string | null = null;
	if (useSvm) {
		const txData = paymentPayload.payload?.transaction;
		if (txData) {
			nonceKey = `svm:${crypto.createHash("sha256").update(txData).digest("hex")}`;
		}
	} else if (!useEvmFacilitator) {
		nonceKey = paymentPayload.payload?.authorization?.nonce ?? null;
	}

	const payer =
		verification.payer ??
		paymentPayload.payload?.authorization?.from ??
		"unknown";

	if (nonceKey) {
		const acquired = await setNoncePending(nonceKey, {
			network: paymentPayload.network,
			payer,
			route: routeKey,
			vm: useSvm ? "svm" : "evm",
		});
		if (!acquired) {
			return {
				error: corsJsonWithHeaders(
					{
						error: "Payment verification failed",
						reason: "Nonce already used or settlement in progress",
					},
					402,
				),
			};
		}
	}

	// Settle payment
	try {
		let settlement: SettlementResult;
		if (useSvm) {
			settlement = await settlePaymentSvm(
				paymentPayload,
				enrichedRouteConfig,
				network,
			);
		} else if (useEvmFacilitator) {
			settlement = await settlePaymentViaFacilitator(
				paymentPayload,
				enrichedRouteConfig,
				network,
			);
		} else {
			settlement = await settlePaymentEvm(paymentPayload);
		}

		// Confirm nonce
		if (nonceKey) {
			await setNonceConfirmed(nonceKey, {
				txHash: settlement.txHash,
				network: settlement.network,
				blockNumber: settlement.blockNumber ?? undefined,
				payer: settlement.payer ?? payer,
				route: routeKey,
				vm: useSvm ? "svm" : "evm",
			});
		}

		const paymentResponseData: PaymentResponseData = {
			success: true,
			txHash: settlement.txHash,
			network: settlement.network,
			blockNumber: settlement.blockNumber,
			...(settlement.facilitator && { facilitator: settlement.facilitator }),
		};

		const paymentResponseHeader = Buffer.from(
			JSON.stringify(paymentResponseData),
		).toString("base64");

		// Cache for idempotency
		if (paymentId) {
			await setIdempotencyCache(paymentId, {
				paymentResponseHeader,
				settlement: paymentResponseData,
			});
		}

		return {
			context: {
				payer: settlement.payer ?? payer,
				txHash: settlement.txHash,
				network: settlement.network,
				blockNumber: settlement.blockNumber,
				...(settlement.facilitator && { facilitator: settlement.facilitator }),
			},
			paymentResponseHeader,
		};
	} catch (err) {
		if (nonceKey) await deleteNonce(nonceKey);
		const error = err as Error;
		console.error(`[x402] Settlement failed:`, error.message);
		return {
			error: corsJsonWithHeaders(
				{ error: "Payment settlement failed", reason: error.message },
				402,
			),
		};
	}
}

// ============================================================
// Handler wrapper for Bun.serve routes
// ============================================================
export function withPayment(
	routeKey: string,
	handler: (req: Request, ctx: PaymentContext) => Promise<Response>,
): (req: Request) => Promise<Response> {
	return async (req: Request): Promise<Response> => {
		// Handle OPTIONS preflight requests directly
		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const result = await verifyAndSettlePayment(req, routeKey);

		if (result.error) {
			return result.error;
		}

		// Add payment response header to the handler's response
		const response = await handler(req, result.context ?? {});

		if (result.paymentResponseHeader) {
			const headers = new Headers(response.headers);
			headers.set("PAYMENT-RESPONSE", result.paymentResponseHeader);
			// Ensure CORS headers are present
			for (const [key, value] of Object.entries(CORS_HEADERS)) {
				if (!headers.has(key)) {
					headers.set(key, value);
				}
			}
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		return response;
	};
}

// Re-export for backward compatibility (deprecated - use withPayment instead)
export { withPayment as x402PaymentMiddleware };
