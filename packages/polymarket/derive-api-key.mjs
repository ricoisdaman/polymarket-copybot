/**
 * Derive fresh Polymarket CLOB API credentials using L1 wallet auth.
 * Run: node packages/polymarket/derive-api-key.mjs
 * (Must be run from the polymarket package directory — needs ethers)
 */
import { Wallet } from "ethers";

const address      = process.env.POLYMARKET_WALLET_ADDRESS;   // proxy wallet
const privateKey   = process.env.POLYMARKET_PRIVATE_KEY;
const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS ?? address; // if set separately
const clobBase     = (process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com").replace(/\/$/, "");

if (!address || !privateKey) {
  console.error("Set POLYMARKET_WALLET_ADDRESS and POLYMARKET_PRIVATE_KEY env vars");
  process.exit(1);
}

const wallet = new Wallet(privateKey);
const eoaAddress = wallet.address;
console.log(`EOA (signer):    ${eoaAddress}`);
console.log(`POLY_ADDRESS:    ${address}`);
console.log(`key/addr match:  ${eoaAddress.toLowerCase() === address.toLowerCase()}`);
console.log();

const path = "/auth/derive-api-key";

async function tryDerive(label, polyAddr, msgBuilder, nonce = 0) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const msg       = msgBuilder(timestamp);
  const signature = await wallet.signMessage(msg);
  const res = await fetch(`${clobBase}${path}`, {
    method: "GET",
    headers: {
      "POLY_ADDRESS":   polyAddr,
      "POLY_SIGNATURE": signature,
      "POLY_TIMESTAMP": timestamp,
      "POLY_NONCE":     String(nonce),
    },
    signal: AbortSignal.timeout(10000)
  });
  const body = await res.text();
  console.log(`[${label}] POLY_ADDRESS=${polyAddr.slice(0,10)}… status=${res.status} body=${body.slice(0, 200)}`);
  if (res.ok) return JSON.parse(body);
  return null;
}

const EOA   = eoaAddress;      // 0xf204Db816... — the actual signer
const PROXY = "0x7C5f701e115aAca132c533F6F078d0AF90e77c46"; // Polymarket proxy wallet

// Strategy 1: EOA as POLY_ADDRESS (our previous attempts)
let creds = await tryDerive("EOA addr",          EOA,   ts => `${ts}GET${path}`);
// Strategy 2: Proxy wallet as POLY_ADDRESS, signed by EOA key (correct for proxy setup)
if (!creds) creds = await tryDerive("Proxy addr",       PROXY, ts => `${ts}GET${path}`);
// Strategy 3: Proxy addr, nonce=1
if (!creds) creds = await tryDerive("Proxy addr nonce=1", PROXY, ts => `${ts}GET${path}`, 1);

if (!creds) {
  console.error("\n❌ All derivation strategies failed. The wallet may not be registered with Polymarket CLOB.");
  console.error("→ Log into polymarket.com with MetaMask (0xf204Db816...), then try again.");
  process.exit(1);
}

console.log("\n✅ Fresh API credentials — paste these into .env:\n");
console.log(`POLYMARKET_API_KEY=${creds.apiKey ?? creds.api_key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret ?? creds.apiSecret ?? creds.api_secret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase ?? creds.apiPassphrase ?? creds.api_passphrase}`);
console.log("\nFull response:", JSON.stringify(creds, null, 2));
