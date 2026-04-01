import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { createHmac } from "node:crypto";

const PK      = process.env.POLYMARKET_PRIVATE_KEY;
const API_KEY = process.env.POLYMARKET_API_KEY;
const SECRET  = process.env.POLYMARKET_API_SECRET;
const PASS    = process.env.POLYMARKET_API_PASSPHRASE;
const CLOB    = (process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com").replace(/\/$/,"");

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("balance-allowance")) {
    console.log("=== SDK HEADERS SENT ===");
    for (const [k, v] of Object.entries(opts?.headers ?? {})) {
      if (k.startsWith("POLY_")) console.log(`  ${k}: ${v}`);
    }
    console.log("  URL:", String(url));
  }
  return origFetch(url, opts);
};

const _w     = new ethers.Wallet(PK);
const signer = { getAddress: () => Promise.resolve(_w.address), _signTypedData: (d, t, v) => _w.signTypedData(d, t, v) };
const creds  = { key: API_KEY, secret: SECRET, passphrase: PASS };
const client = new ClobClient(CLOB, 137, signer, creds);
await client.getBalanceAllowance({ asset_type: "COLLATERAL" });

console.log("\n=== OUR HMAC APPROACH ===");
const path      = "/balance-allowance?asset_type=COLLATERAL";
const timestamp = String(Math.floor(Date.now() / 1000));
const message   = timestamp + "GET" + path;
const secretB64 = SECRET.replace(/-/g,"+").replace(/_/g,"/");
const secretBytes = Buffer.from(secretB64, "base64");
const sig = createHmac("sha256", secretBytes).update(message).digest("base64").replace(/\+/g,"-").replace(/\//g,"_");
console.log("  POLY_ADDRESS:", _w.address);
console.log("  POLY_TIMESTAMP:", timestamp);
console.log("  POLY_SIGNATURE:", sig);
console.log("  POLY_API_KEY:", API_KEY);
console.log("  message signed:", message);
