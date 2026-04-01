import { createHash, createHmac, randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import type { LeaderEvent, QuoteEstimate, TradeSide } from "@copybot/core";

export type LeaderFeedOptions = {
  leaderWallet: string;
  mode?: "SIMULATED" | "DATA_API_POLL";
  dataApiBaseUrl?: string;
  pollIntervalSeconds?: number;
  eventIntervalMs?: number;
};

export type LeaderFeedStats = {
  connected: boolean;
  mode: "SIMULATED" | "DATA_API_POLL";
  lastEventTs: number | null;
  eventsSeen: number;
  subscribers: number;
  lastPollTs: number | null;
  lastError: string | null;
};

type LeaderEventHandler = (event: LeaderEvent) => void;

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

function pseudoRandom(tokenId: string, seed: number): number {
  const hash = stableHash(`${tokenId}:${seed}`);
  const numeric = Number.parseInt(hash.slice(0, 8), 16);
  return (numeric % 10000) / 10000;
}

type DataApiActivityRecord = {
  id?: string;
  txHash?: string;
  transactionHash?: string;
  timestamp?: string | number;
  ts?: string | number;
  time?: string | number;
  conditionId?: string;
  condition_id?: string;
  tokenId?: string;
  token_id?: string;
  asset?: string;
  type?: string;
  side?: string;
  price?: number | string;
  size?: number | string;
  usdcSize?: number | string;
  usdc_size?: number | string;
  [key: string]: unknown;
};

function buildEvent(leaderWallet: string): LeaderEvent {
  const now = Date.now();
  const tokenId = `token-${(now / 1000) % 7 | 0}`;
  const side: TradeSide = now % 2 === 0 ? "BUY" : "SELL";
  const priceBase = 0.4 + pseudoRandom(tokenId, now) * 0.2;
  const price = Math.max(0.01, Math.min(0.99, Number(priceBase.toFixed(3))));
  const usdcSize = Number((0.75 + pseudoRandom(tokenId, now + 1) * 1.25).toFixed(3));
  const size = Number((usdcSize / price).toFixed(4));
  const eventId = randomUUID();
  const dedupeKey = stableHash(`${leaderWallet}:${tokenId}:${side}:${price}:${size}:${Math.floor(now / 1000)}`);

  return {
    eventId,
    dedupeKey,
    ts: now,
    leaderWallet,
    conditionId: `cond-${tokenId}`,
    tokenId,
    side,
    price,
    size,
    usdcSize,
    source: "PUBLIC_WS",
    raw: {
      eventId,
      generatedAt: now
    }
  };
}

function toMillis(value: unknown): number {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function normalizeActivityRecord(leaderWallet: string, record: DataApiActivityRecord): LeaderEvent | null {
  const activityType = String(record.type ?? "TRADE").toUpperCase();
  if (activityType !== "TRADE") {
    return null;
  }

  const tokenId = String(record.tokenId ?? record.token_id ?? record.asset ?? "").trim();
  if (!tokenId) {
    return null;
  }

  const conditionId = String(record.conditionId ?? record.condition_id ?? `cond-${tokenId}`);
  const rawSide = String(record.side ?? "BUY").toUpperCase();
  const side: TradeSide = rawSide === "SELL" ? "SELL" : "BUY";
  const price = Number(record.price ?? 0.5);
  const size = Number(record.size ?? 1);
  const usdcSize = Number(record.usdcSize ?? record.usdc_size ?? price * size);
  // Use the original trade timestamp only for deduplication / audit in raw.
  // For the staleness check (event.ts vs Date.now()), we use the time the bot
  // polled and received this record — the leader's trade-to-API indexing lag is
  // uncontrollable and should not count against the freshness window.
  const receivedTs = Date.now();
  const originalTs = toMillis(record.timestamp ?? record.ts ?? record.time);
  const idBase = String(record.id ?? record.transactionHash ?? record.txHash ?? randomUUID());
  const dedupeKey = stableHash(`${leaderWallet}:${idBase}:${tokenId}:${side}:${price}:${size}`);

  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
    return null;
  }

  return {
    eventId: idBase,
    dedupeKey,
    ts: receivedTs,
    leaderWallet,
    conditionId,
    tokenId,
    side,
    price,
    size,
    usdcSize: Number.isFinite(usdcSize) ? usdcSize : Number((price * size).toFixed(4)),
    source: "PUBLIC_WS",
    raw: { ...record, originalTs }
  };
}

async function fetchLeaderActivity(dataApiBaseUrl: string, leaderWallet: string, limit = 40): Promise<LeaderEvent[]> {
  const url = `${dataApiBaseUrl.replace(/\/$/, "")}/activity?user=${encodeURIComponent(leaderWallet)}&limit=${limit}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "content-type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Data API responded with ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown[] }).data)
      ? ((payload as { data: unknown[] }).data ?? [])
      : [];

  const events: LeaderEvent[] = [];
  for (const record of records) {
    const event = normalizeActivityRecord(leaderWallet, record as DataApiActivityRecord);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export function estimateExecutableQuote(tokenId: string, side: TradeSide, desiredSize: number): QuoteEstimate {
  const now = Date.now();
  const mid = 0.35 + pseudoRandom(tokenId, now) * 0.3;
  const spread = 0.002 + pseudoRandom(tokenId, now + 11) * 0.012;
  const bestBid = Number(Math.max(0.01, (mid - spread / 2)).toFixed(4));
  const bestAsk = Number(Math.min(0.99, (mid + spread / 2)).toFixed(4));
  const midP = (bestAsk + bestBid) / 2;
  const spreadBps = Number((((bestAsk - bestBid) / Math.max(midP, 0.0001)) * 10000).toFixed(2));
  const topOfBookDepth = Number((1 + pseudoRandom(tokenId, now + 17) * 8).toFixed(4));
  const depthPressure = desiredSize / Math.max(topOfBookDepth, 0.0001);
  const slippageBps = Number(Math.max(2, depthPressure * 20).toFixed(2));
  const direction = side === "BUY" ? 1 : -1;
  const executablePrice = Number(
    Math.max(0.01, Math.min(0.99, (side === "BUY" ? bestAsk : bestBid) * (1 + (direction * slippageBps) / 10000))).toFixed(4)
  );

  return {
    tokenId,
    side,
    bestBid,
    bestAsk,
    executablePrice,
    spreadBps,
    slippageBps,
    topOfBookDepth,
    filledSize: desiredSize,   // paper-mode: assume full fill
  };
}

/**
 * Fetch live CLOB mid-market prices for a batch of token IDs.
 * Calls /midpoint for each token in parallel (max 10 concurrent).
 * Tokens that fail or have no orderbook are silently omitted.
 */
export async function fetchMidPrices(
  clobBaseUrl: string,
  tokenIds: string[]
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  if (tokenIds.length === 0) return results;

  const base = clobBaseUrl.replace(/\/$/, "");
  const CONCURRENCY = 10;
  const chunks: string[][] = [];
  for (let i = 0; i < tokenIds.length; i += CONCURRENCY) {
    chunks.push(tokenIds.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    await Promise.allSettled(
      chunk.map(async (tokenId) => {
        try {
          const res = await fetch(`${base}/midpoint?token_id=${encodeURIComponent(tokenId)}`, {
            signal: AbortSignal.timeout(4000)
          });
          if (!res.ok) return;
          const json = (await res.json()) as { mid?: string | number };
          const mid = Number(json.mid);
          if (Number.isFinite(mid) && mid >= 0) {
            results.set(tokenId, mid);
          }
        } catch {
          // silently skip — stale fill price will remain
        }
      })
    );
  }

  return results;
}

export type TokenMarketStatus = {
  /** true once the market orderbook has closed */
  closed: boolean;
  /**
   * UMA optimistic oracle resolution state:
   *   "proposed"  — resolution has been submitted, still in challenge window
   *   "resolved"  — challenge window passed, market fully settled
   *    null       — no UMA resolution started yet (market still live)
   */
  umaResolutionStatus: string | null;
  /**
   * The settlement price of THIS specific token from outcomePrices[idx].
   * 1.0 = this outcome won, 0.0 = lost, values in between = current probability.
   * null = could not determine.
   */
  outcomePriceForToken: number | null;
};

/**
 * Batch-fetches Gamma market metadata for the given token IDs.
 * Useful for detecting markets that are "proposed" or "resolved" via the
 * UMA optimistic oracle (CLOB may still be open with a near-1.0 mid price).
 */
export async function fetchTokenMarketStatuses(
  tokenIds: string[]
): Promise<Map<string, TokenMarketStatus>> {
  const results = new Map<string, TokenMarketStatus>();
  if (tokenIds.length === 0) return results;

  const GAMMA_BASE = "https://gamma-api.polymarket.com";

  await Promise.allSettled(
    tokenIds.map(async (tokenId) => {
      try {
        const url = `${GAMMA_BASE}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        const data = (await res.json()) as Array<{
          closed?: boolean;
          umaResolutionStatus?: string;
          clobTokenIds?: string;
          outcomePrices?: string;
        }>;
        if (!data?.length) return;
        const market = data[0];
        const tokenIdsArr = JSON.parse(market.clobTokenIds ?? "[]") as string[];
        const pricesArr = JSON.parse(market.outcomePrices ?? "[]") as string[];
        const idx = tokenIdsArr.indexOf(tokenId);
        const outcomePriceForToken =
          idx !== -1 && idx < pricesArr.length ? Number(pricesArr[idx]) : null;
        results.set(tokenId, {
          closed: market.closed ?? false,
          umaResolutionStatus: market.umaResolutionStatus ?? null,
          outcomePriceForToken: outcomePriceForToken !== null && Number.isFinite(outcomePriceForToken)
            ? outcomePriceForToken
            : null,
        });
      } catch {
        // Gamma API unavailable for this token — omit
      }
    })
  );

  return results;
}

/**
 * For each token ID that lacks a CLOB midpoint (market closed/resolved),
 * queries the Gamma API to determine each token's settlement value.
 *
 * Returns a Map of tokenId → settlement price (1.0 = YES won, 0.0 = NO lost,
 * 0.5 = void/split). Tokens whose markets cannot be determined are omitted.
 */
export async function fetchTokenResolutionValues(
  tokenIds: string[]
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  if (tokenIds.length === 0) return results;

  const GAMMA_BASE = "https://gamma-api.polymarket.com";

  await Promise.allSettled(
    tokenIds.map(async (tokenId) => {
      try {
        const url = `${GAMMA_BASE}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        const data = (await res.json()) as Array<{
          clobTokenIds?: string;
          outcomePrices?: string;
          closed?: boolean;
        }>;
        if (!data?.length) return;
        const market = data[0];
        // clobTokenIds and outcomePrices are stringified JSON arrays
        const tokenIdsArr = JSON.parse(market.clobTokenIds ?? "[]") as string[];
        const pricesArr = JSON.parse(market.outcomePrices ?? "[]") as string[];
        const idx = tokenIdsArr.indexOf(tokenId);
        if (idx === -1 || idx >= pricesArr.length) return;
        const price = Number(pricesArr[idx]);
        if (Number.isFinite(price)) {
          results.set(tokenId, price);
        }
      } catch {
        // Gamma API unavailable for this token — omit, no credit
      }
    })
  );

  return results;
}

// ─── LIVE EXECUTION ──────────────────────────────────────────────────────────

export type ClobCredentials = {
  address: string;
  proxyWallet?: string;   // Polymarket Gnosis Safe proxy (signature_type 2)
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
};

export type LiveQuoteEstimate = QuoteEstimate & { negRisk: boolean };

// EIP-712 verifying contracts on Polygon (chain 137).
// Both exchanges share the same domain name; only the verifyingContract differs.
const POLY_EXCHANGE_STANDARD = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const POLY_EXCHANGE_NEG_RISK  = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const POLY_CHAIN_ID = 137;

const ORDER_EIP712_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   }
  ]
};

// Per-session cache: conditionId → negRisk flag (avoids repeated /markets calls).
const negRiskCache = new Map<string, boolean>();

/**
 * Build Polymarket L2 auth headers.
 * POLY_SIGNATURE = HMAC-SHA256(base64-decoded apiSecret, "${timestamp}${method}${path}${body}"),
 * returned as URL-safe base64. This is the correct L2 signing format per the
 * official @polymarket/clob-client SDK.
 */
function buildClobAuthHeaders(
  method: string,
  path: string,
  body: string,
  creds: ClobCredentials
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message   = timestamp + method + path + (body || "");

  // Decode the base64(-url) secret key.
  const secretBase64 = creds.apiSecret
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const secretBytes = Buffer.from(secretBase64, "base64");

  const sig = createHmac("sha256", secretBytes)
    .update(message)
    .digest("base64")
    .replace(/\+/g, "-")   // base64 → URL-safe base64
    .replace(/\//g, "_");

  return {
    "POLY_ADDRESS":    creds.address,
    "POLY_SIGNATURE":  sig,
    "POLY_TIMESTAMP":  timestamp,
    "POLY_API_KEY":    creds.apiKey,
    "POLY_PASSPHRASE": creds.apiPassphrase,
  };
}

/** Resolve negRisk flag for a conditionId, caching the result.
 * Throws on network/API failure so the caller can skip the trade rather than
 * guess the wrong exchange contract and submit an invalid order.
 */
async function resolveNegRisk(clobBaseUrl: string, conditionId: string): Promise<boolean> {
  const cached = negRiskCache.get(conditionId);
  if (cached !== undefined) return cached;
  const res = await fetch(
    `${clobBaseUrl.replace(/\/$/, "")}/markets/${encodeURIComponent(conditionId)}`,
    { signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) {
    throw new Error(`CLOB /markets responded ${res.status} for condition ${conditionId}`);
  }
  const m = (await res.json()) as { neg_risk?: boolean };
  // Default to false (standard exchange) when the field is absent — simple binary
  // markets do not set neg_risk and use POLY_EXCHANGE_STANDARD.
  const result = m.neg_risk ?? false;
  negRiskCache.set(conditionId, result);
  return result;
}

/**
 * Fetch the real CLOB orderbook and compute an executable quote.
 * Replaces estimateExecutableQuote() in LIVE mode.
 */
export async function fetchLiveQuote(
  clobBaseUrl: string,
  conditionId: string,
  tokenId: string,
  side: TradeSide,
  desiredSize: number
): Promise<LiveQuoteEstimate> {
  const base = clobBaseUrl.replace(/\/$/, "");

  const [bookRes, negRisk] = await Promise.all([
    fetch(`${base}/book?token_id=${encodeURIComponent(tokenId)}`, {
      signal: AbortSignal.timeout(5000)
    }),
    resolveNegRisk(base, conditionId)
  ]);

  if (!bookRes.ok) {
    throw new Error(`CLOB /book responded ${bookRes.status} for token ${tokenId}`);
  }

  const book = (await bookRes.json()) as {
    bids?: { price: string; size: string }[];
    asks?: { price: string; size: string }[];
  };

  const bids = (book.bids ?? [])
    .map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((a, b) => b.price - a.price);
  const asks = (book.asks ?? [])
    .map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? 0.01;
  const bestAsk = asks[0]?.price ?? 0.99;
  const mid = (bestAsk + bestBid) / 2;
  const spreadBps = Number(
    (((bestAsk - bestBid) / Math.max(mid, 0.0001)) * 10000).toFixed(2)
  );

  // Walk the book to get executable price and depth.
  const levels = side === "BUY" ? asks : bids;
  let remaining = desiredSize;
  let totalCost = 0;
  let depthAccum = 0;
  for (const level of levels) {
    const fill = Math.min(remaining, level.size);
    totalCost += fill * level.price;
    remaining -= fill;
    depthAccum += level.size;
    if (remaining <= 0) break;
  }

  const filledSize = desiredSize - remaining;
  const executablePrice = filledSize > 0.0001
    ? Number((totalCost / filledSize).toFixed(4))
    : side === "BUY" ? bestAsk : bestBid;
  const refPrice = side === "BUY" ? bestAsk : bestBid;
  // When the book-walk couldn't fill anything, slippage is effectively infinite.
  // Use a sentinel value of 10000 bps (100%) so slippage-based guards can also catch it.
  const slippageBps = filledSize < 0.0001
    ? 10000
    : Number(
        ((Math.abs(executablePrice - refPrice) / Math.max(refPrice, 0.0001)) * 10000).toFixed(2)
      );

  return {
    tokenId, side, bestBid, bestAsk, executablePrice,
    spreadBps, slippageBps,
    topOfBookDepth: Number(depthAccum.toFixed(4)),
    filledSize: Number(filledSize.toFixed(4)),
    negRisk
  };
}

/**
 * EIP-712 sign and POST a FOK taker order to the Polymarket CLOB.
 * Returns the CLOB order ID and its initial status.
 *
 * Amount scaling: Polymarket uses 1e6 for both USDC and conditional tokens.
 * BUY:  makerAmount = USDC * 1e6,  takerAmount = shares * 1e6
 * SELL: makerAmount = shares * 1e6, takerAmount = USDC * 1e6
 */
export async function placeOrder(
  clobBaseUrl: string,
  creds: ClobCredentials,
  tokenId: string,
  conditionId: string,
  side: TradeSide,
  size: number,
  limitPrice: number,
  negRisk: boolean,
  orderType: "FOK" | "GTC" | "GTD" | "FAK" = "FOK"
): Promise<{ orderId: string; initialStatus: string }> {
  const roundedPrice = Number(limitPrice.toFixed(4));
  const SCALE = 1_000_000;

  // The CLOB enforces the same precision constraints for both BUY and SELL:
  //   makerAmount (÷1e6): max 2 decimal places
  //   takerAmount (÷1e6): max 4 decimal places
  // BUY:  makerAmount = USDC spent,   takerAmount = shares received
  // SELL: makerAmount = shares sold,  takerAmount = USDC received
  // Round makerAmount UP (ceiling) so we never short-change the counterparty.
  const rawMaker = side === "BUY" ? roundedPrice * size : size;
  const rawTaker = side === "BUY" ? size : roundedPrice * size;
  const makerAmt = Math.ceil(rawMaker * 100) / 100;   // 2dp, ceiling
  const takerAmt = Number(rawTaker.toFixed(4));         // 4dp

  const makerAmount = BigInt(Math.round(makerAmt * SCALE));
  const takerAmount = BigInt(Math.round(takerAmt * SCALE));

  // Fetch the market's required taker fee rate before building the order.
  const feeRes = await fetch(
    `${clobBaseUrl.replace(/\/$/, "")}/fee-rate?token_id=${encodeURIComponent(tokenId)}`,
    { signal: AbortSignal.timeout(5000) }
  );
  const feeData = feeRes.ok ? (await feeRes.json()) as { base_fee?: number } : {};
  const feeRateBps = feeData.base_fee ?? 0;

  // Salt must be a small integer (JS Number-safe) — API does parseInt(salt) before storing.
  // Using the same approach as the official @polymarket/clob-client SDK.
  const saltNum = Math.round(Math.random() * Date.now());
  const salt = BigInt(saltNum);
  const sideValue = side === "BUY" ? 0 : 1;
  const exchangeContract = negRisk ? POLY_EXCHANGE_NEG_RISK : POLY_EXCHANGE_STANDARD;

  const domain = {
    name: "Polymarket CTF Exchange",
    version: "1",
    chainId: POLY_CHAIN_ID,
    verifyingContract: exchangeContract
  };

  // Use proxy wallet (Gnosis Safe, signatureType=2) when configured — funds live there.
  // Fallback to EOA direct (signatureType=0) if no proxy wallet is set.
  const makerAddress    = creds.proxyWallet ?? creds.address;
  const signerAddress   = creds.address;
  const sigType         = creds.proxyWallet ? 2 : 0;

  const orderValues = {
    salt,
    maker:         makerAddress,
    signer:        signerAddress,
    taker:         "0x0000000000000000000000000000000000000000",
    tokenId:       BigInt(tokenId),
    makerAmount,
    takerAmount,
    expiration:    0n,
    nonce:         0n,
    feeRateBps:    BigInt(feeRateBps),
    side:          sideValue,
    signatureType: sigType
  };

  const wallet = new Wallet(creds.privateKey);
  const orderSignature = await wallet.signTypedData(domain, ORDER_EIP712_TYPES, orderValues);

  const orderPayload = {
    order: {
      salt:          saltNum,
      maker:         makerAddress,
      signer:        signerAddress,
      taker:         "0x0000000000000000000000000000000000000000",
      tokenId,
      makerAmount:   makerAmount.toString(),
      takerAmount:   takerAmount.toString(),
      expiration:    "0",
      nonce:         "0",
      feeRateBps:    feeRateBps.toString(),
      side:          side === "BUY" ? "BUY" : "SELL",
      signatureType: sigType,
      signature:     orderSignature
    },
    owner:     creds.apiKey,
    orderType
  };

  const body = JSON.stringify(orderPayload);
  const path = "/order";
  const headers = buildClobAuthHeaders("POST", path, body, creds);
  const base = clobBaseUrl.replace(/\/$/, "");


  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`CLOB /order responded ${res.status}: ${errText}`);
  }

  const result = (await res.json()) as {
    success?: boolean;
    errorMsg?: string;
    orderID?: string;
    status?: string;
  };

  if (!result.success) {
    throw new Error(`Order rejected by CLOB: ${result.errorMsg ?? "unknown"}`);
  }

  return {
    orderId:       result.orderID ?? "",
    initialStatus: (result.status ?? "unknown").toLowerCase()
  };
}

/**
 * Poll a CLOB order until it reaches a terminal state or the timeout elapses.
 * Used for orders that come back with "delayed" status.
 */
export async function pollOrderStatus(
  clobBaseUrl: string,
  creds: ClobCredentials,
  orderId: string,
  timeoutMs: number
): Promise<{ matched: boolean; sizeMatched: number; fillPrice: number }> {
  const base = clobBaseUrl.replace(/\/$/, "");
  const deadline = Date.now() + timeoutMs;
  const INTERVAL_MS = 1000;

  while (Date.now() < deadline) {
    const path = `/data/order/${encodeURIComponent(orderId)}`;
    const headers = buildClobAuthHeaders("GET", path, "", creds);
    try {
      const res = await fetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const order = (await res.json()) as {
          status?: string;
          size_matched?: string;
          price?: string;
        };
        const status = (order.status ?? "").toUpperCase();
        if (status === "MATCHED") {
          return {
            matched: true,
            sizeMatched: Number(order.size_matched ?? "0"),
            fillPrice:   Number(order.price ?? "0")
          };
        }
        if (status === "CANCELED" || status === "UNMATCHED") {
          return { matched: false, sizeMatched: 0, fillPrice: 0 };
        }
        // LIVE / DELAYED / pending — keep polling
      }
    } catch {
      // transient network error during poll — keep trying
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  return { matched: false, sizeMatched: 0, fillPrice: 0 };
}

/**
 * Fetch the wallet's live USDC balance from Polymarket CLOB.
 * Returns the balance in whole USDC (e.g. 50.0 for $50).
 */
export async function fetchUsdcBalance(
  clobBaseUrl: string,
  creds: ClobCredentials
): Promise<number> {
  const base = clobBaseUrl.replace(/\/$/, "");
  // HMAC is signed over the path WITHOUT query params (Polymarket convention).
  // signature_type=2 = POLY_GNOSIS_SAFE proxy wallet (where funds actually live).
  const sigType    = creds.proxyWallet ? 2 : 0;
  const signedPath = "/balance-allowance";
  const fetchUrl   = `${base}${signedPath}?asset_type=COLLATERAL&signature_type=${sigType}`;
  const headers = buildClobAuthHeaders("GET", signedPath, "", creds);
  const res = await fetch(fetchUrl, {
    headers,
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    throw new Error(`CLOB /balance-allowance responded ${res.status}`);
  }
  const data = (await res.json()) as { balance?: string | number };
  return Number(data.balance ?? "0") / 1_000_000;
}

/**
 * Fetch the wallet's current on-chain token positions from the Polymarket Data API.
 * Returns a Map of tokenId → share size for positions in **active** (unresolved) markets only.
 * Positions where `redeemable: true` are for markets that have already resolved — those are
 * treated as closed since they can no longer be traded.
 *
 * Used to reconcile the local DB against actual on-chain state so that positions
 * from expired/resolved markets get zeroed rather than staying "open" forever.
 *
 * @param walletAddress  The proxy wallet (Gnosis Safe) address, or EOA if no proxy.
 * @param dataApiBaseUrl  Defaults to https://data-api.polymarket.com
 */
export async function fetchOnChainPositions(
  walletAddress: string,
  dataApiBaseUrl = "https://data-api.polymarket.com"
): Promise<Map<string, number>> {
  const base = dataApiBaseUrl.replace(/\/$/, "");
  const url = `${base}/positions?user=${encodeURIComponent(walletAddress)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`Data API /positions responded ${res.status}`);
  }
  const data = (await res.json()) as Array<{
    asset?: string;
    size?: string | number;
    redeemable?: boolean;
  }>;
  const result = new Map<string, number>();
  for (const item of data) {
    // Skip resolved markets — they can't be traded and should be treated as closed.
    if (item.redeemable) continue;
    const tokenId = String(item.asset ?? "").trim();
    const size = Number(item.size ?? 0);
    if (tokenId && size > 0.0001) {
      result.set(tokenId, size);
    }
  }
  return result;
}

/**
 * Validates that the private key in credentials derives to the configured wallet address.
 * Returns null if valid, or an error message string describing the mismatch.
 * Call this before making any authenticated API requests.
 */
export function validateClobCredentials(creds: ClobCredentials): string | null {
  try {
    const derived = new Wallet(creds.privateKey).address;
    if (derived.toLowerCase() !== creds.address.toLowerCase()) {
      return (
        `POLYMARKET_PRIVATE_KEY derives to wallet ${derived} but ` +
        `POLYMARKET_WALLET_ADDRESS is set to ${creds.address}. ` +
        `Export the private key for wallet ${creds.address} from your wallet app (MetaMask → Account Details → Show Private Key).`
      );
    }
    return null;
  } catch {
    return "POLYMARKET_PRIVATE_KEY is not a valid Ethereum private key (must be 0x + 64 hex chars).";
  }
}

export function createLeaderFeed(options: LeaderFeedOptions) {
  let eventsSeen = 0;
  let lastEventTs: number | null = null;
  let lastPollTs: number | null = null;
  let lastError: string | null = null;
  const subscribers = new Set<LeaderEventHandler>();
  const mode = options.mode ?? "SIMULATED";
  const eventIntervalMs = options.eventIntervalMs ?? 1500;
  const pollIntervalMs = (options.pollIntervalSeconds ?? 2) * 1000;
  const dataApiBaseUrl = options.dataApiBaseUrl ?? process.env.POLYMARKET_DATA_API_URL ?? "https://data-api.polymarket.com";
  const seenKeys = new Set<string>();
  let latestEventTs = 0;

  const emit = (event: LeaderEvent) => {
    if (seenKeys.has(event.dedupeKey)) {
      return;
    }
    seenKeys.add(event.dedupeKey);
    if (seenKeys.size > 5000) {
      const first = seenKeys.values().next().value;
      if (first) {
        seenKeys.delete(first);
      }
    }
    eventsSeen += 1;
    lastEventTs = event.ts;
    latestEventTs = Math.max(latestEventTs, event.ts);
    for (const handler of subscribers) {
      handler(event);
    }
  };

  const timer = setInterval(() => {
    if (mode !== "SIMULATED") {
      return;
    }
    const event = buildEvent(options.leaderWallet);
    emit(event);
  }, eventIntervalMs);

  const poller = setInterval(() => {
    if (mode !== "DATA_API_POLL") {
      return;
    }

    void (async () => {
      lastPollTs = Date.now();
      try {
        const events = await fetchLeaderActivity(dataApiBaseUrl, options.leaderWallet);
        lastError = null;
        const sorted = events.sort((a, b) => a.ts - b.ts);
        for (const event of sorted) {
          if (event.ts < latestEventTs - 5_000) {
            continue;
          }
          emit(event);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    })();
  }, pollIntervalMs);

  return {
    onEvent(handler: LeaderEventHandler): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    stop(): void {
      clearInterval(timer);
      clearInterval(poller);
      subscribers.clear();
    },
    getStats(): LeaderFeedStats {
      return {
        connected: true,
        mode,
        lastEventTs,
        eventsSeen,
        subscribers: subscribers.size,
        lastPollTs,
        lastError
      };
    }
  };
}
