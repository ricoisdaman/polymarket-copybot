/**
 * Diagnostic: test Polymarket CLOB auth with two signing strategies
 * Run: node --env-file=.env scripts/test-clob-auth.mjs
 */
import { Wallet } from "ethers";

const address     = process.env.POLYMARKET_WALLET_ADDRESS;
const privateKey  = process.env.POLYMARKET_PRIVATE_KEY;
const apiKey      = process.env.POLYMARKET_API_KEY;
const apiSecret   = process.env.POLYMARKET_API_SECRET;
const passphrase  = process.env.POLYMARKET_API_PASSPHRASE;
const clobBase    = (process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com").replace(/\/$/, "");

// 1. Verify wallet address matches private key
const walletFromKey = new Wallet(privateKey);
console.log("=== KEY/ADDRESS CHECK ===");
console.log(`  privateKey address: ${walletFromKey.address}`);
console.log(`  env WALLET_ADDRESS: ${address}`);
console.log(`  match: ${walletFromKey.address.toLowerCase() === address.toLowerCase()}`);

// 2. Decode API secret to see if it's a valid 32-byte key
const secretBytes = Buffer.from(apiSecret, "base64");
console.log(`\n=== API SECRET ===`);
console.log(`  apiSecret decoded bytes: ${secretBytes.length} (expect 32 for a private key)`);
const secretHex = secretBytes.toString("hex");
let apiWallet;
try {
  apiWallet = new Wallet("0x" + secretHex);
  console.log(`  apiSecret as wallet: ${apiWallet.address}`);
} catch (e) {
  console.log(`  apiSecret is NOT a valid EC private key: ${e.message}`);
}

// 3. Try L1 auth (sign with wallet / privateKey) — no API key headers
async function tryAuth(label, signerWallet, includeApiKey) {
  const path = "/balance-allowance?asset_type=COLLATERAL";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const msg = timestamp + "GET" + path + "";
  const sig = await signerWallet.signMessage(msg);
  const headers = {
    "POLY_ADDRESS":   address,
    "POLY_SIGNATURE": sig,
    "POLY_TIMESTAMP": timestamp,
    "POLY_NONCE":     "0",
  };
  if (includeApiKey) {
    headers["POLY_API_KEY"]    = apiKey;
    headers["POLY_PASSPHRASE"] = passphrase;
  }
  try {
    const res = await fetch(`${clobBase}${path}`, {
      headers,
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.text();
    console.log(`\n=== ${label} ===`);
    console.log(`  status: ${res.status}`);
    console.log(`  body:   ${body.slice(0, 300)}`);
    return res.status === 200;
  } catch (e) {
    console.log(`\n=== ${label} ===`);
    console.log(`  ERROR: ${e.message}`);
    return false;
  }
}

// Strategy A: wallet key, no API key headers (pure L1)
await tryAuth("Strategy A — L1 (wallet key, no api-key headers)", walletFromKey, false);

// Strategy B: wallet key + API key headers (current bot implementation)
await tryAuth("Strategy B — wallet key + api-key headers (current impl)", walletFromKey, true);

// Strategy C: api secret key + API key headers (true L2)
if (apiWallet) {
  await tryAuth("Strategy C — api secret key + api-key headers (L2)", apiWallet, true);
}
