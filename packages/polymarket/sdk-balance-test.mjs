import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
const PK = process.env.POLYMARKET_PRIVATE_KEY;
const API_KEY = process.env.POLYMARKET_API_KEY;
const SECRET = process.env.POLYMARKET_API_SECRET;
const PASS = process.env.POLYMARKET_API_PASSPHRASE;
const CLOB = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
const _w = new ethers.Wallet(PK);
const signer = { getAddress: () => Promise.resolve(_w.address), _signTypedData: (d,t,v) => _w.signTypedData(d,t,v) };
const creds = { key: API_KEY, secret: SECRET, passphrase: PASS };
const client = new ClobClient(CLOB, 137, signer, creds);
try {
  const bal = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
  console.log("OK:", JSON.stringify(bal));
} catch(e) {
  console.error("FAIL:", e.message);
}
