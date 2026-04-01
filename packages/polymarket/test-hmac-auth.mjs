import { createHmac } from "node:crypto";

const address    = process.env.POLYMARKET_WALLET_ADDRESS;
const apiKey     = process.env.POLYMARKET_API_KEY;
const apiSecret  = process.env.POLYMARKET_API_SECRET;
const passphrase = process.env.POLYMARKET_API_PASSPHRASE;
const clobBase   = (process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com").replace(/\/$/, "");

const path      = "/balance-allowance?asset_type=COLLATERAL";
const timestamp = String(Math.floor(Date.now() / 1000));
const message   = timestamp + "GET" + path;

const secretBase64 = apiSecret.replace(/-/g, "+").replace(/_/g, "/");
const secretBytes  = Buffer.from(secretBase64, "base64");
const sig = createHmac("sha256", secretBytes)
  .update(message)
  .digest("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");

const res = await fetch(`${clobBase}${path}`, {
  headers: {
    "POLY_ADDRESS":    address,
    "POLY_SIGNATURE":  sig,
    "POLY_TIMESTAMP":  timestamp,
    "POLY_API_KEY":    apiKey,
    "POLY_PASSPHRASE": passphrase,
  },
  signal: AbortSignal.timeout(8000)
});

const body = await res.text();
console.log(`status: ${res.status}`);
console.log(`body: ${body}`);
if (res.ok) {
  const d = JSON.parse(body);
  console.log(`\n✅ USDC balance: $${(Number(d.balance ?? 0) / 1_000_000).toFixed(2)}`);
}
