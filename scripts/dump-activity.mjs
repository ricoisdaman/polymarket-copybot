const wallet = process.argv[2];
const hours = Number(process.argv[3] ?? 48);
const limit = Number(process.argv[4] ?? 120);
if (!wallet) {
  console.error("Usage: node scripts/dump-activity.mjs <wallet> [hours] [limit]");
  process.exit(1);
}
const since = Date.now() - hours * 60 * 60 * 1000;
const url = `https://data-api.polymarket.com/activity?user=${encodeURIComponent(wallet)}&limit=${limit}`;
const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}
const payload = await res.json();
const rows = (Array.isArray(payload) ? payload : payload?.data ?? [])
  .map((r) => {
    const rawTs = r.timestamp ?? r.ts ?? r.time;
    const ts = typeof rawTs === "number" ? (rawTs > 1e10 ? rawTs : rawTs * 1000) : Date.parse(String(rawTs ?? ""));
    return {
      ts,
      side: String(r.side ?? "").toUpperCase(),
      price: Number(r.price ?? 0),
      size: Number(r.size ?? 0),
      usdc: Number(r.usdcSize ?? r.usdc_size ?? Number(r.price ?? 0) * Number(r.size ?? 0)),
      tokenId: String(r.tokenId ?? r.token_id ?? r.asset ?? ""),
      title: String(r.title ?? r.slug ?? "")
    };
  })
  .filter((r) => Number.isFinite(r.ts) && r.ts >= since)
  .sort((a, b) => a.ts - b.ts);

console.log(`wallet=${wallet}`);
console.log(`rows=${rows.length}`);
for (const r of rows) {
  console.log(`${new Date(r.ts).toISOString()} ${r.side.padEnd(4)} px=${r.price.toFixed(4)} usdc=${r.usdc.toFixed(2).padStart(6)} token=${r.tokenId.slice(0, 18)}... ${r.title.slice(0, 70)}`);
}
