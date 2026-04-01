/**
 * Derive fresh Polymarket L2 API credentials using the official SDK.
 * Run from workspace root: node scripts/derive-polymarket-creds.mjs
 */
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const CLOB_URL    = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";

if (!PRIVATE_KEY) {
  console.error("Set POLYMARKET_PRIVATE_KEY env var");
  process.exit(1);
}

const _signer = new ethers.Wallet(PRIVATE_KEY);
console.log(`Deriving credentials for EOA: ${_signer.address}`);

// The @polymarket/clob-client v5 expects an ethers v5-style signer with
// _signTypedData and getAddress. Ethers v6 uses signTypedData instead.
// Wrap to provide the v5 interface.
const signer = {
  getAddress: () => Promise.resolve(_signer.address),
  _signTypedData: (domain, types, value) => _signer.signTypedData(domain, types, value),
};

// Chain 137 = Polygon mainnet (where Polymarket lives)
const client = new ClobClient(CLOB_URL, 137, signer);

try {
  const creds = await client.deriveApiKey(0);
  console.log("\n✅ Paste these into .env:\n");
  console.log(`POLYMARKET_API_KEY=${creds.key}`);
  console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
  console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
  console.log("\nFull response:", JSON.stringify(creds, null, 2));
} catch (e) {
  console.error("Failed:", e.message);
  // Try with nonce=1
  try {
    console.log("\nRetrying with nonce=1...");
    const creds = await client.deriveApiKey(1);
    console.log(`POLYMARKET_API_KEY=${creds.key}`);
    console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
    console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
  } catch (e2) {
    console.error("nonce=1 also failed:", e2.message);
  }
}
