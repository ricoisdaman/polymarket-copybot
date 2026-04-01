import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("./prisma/dev.db");
const fills = db.prepare(`
  SELECT f.price, f.size, f.size*f.price as notional, i.side
  FROM Fill f
  JOIN "Order" o ON o.id = f.orderId
  JOIN CopyIntent i ON i.id = o.intentId
  WHERE f.profileId = 'leader2'
  ORDER BY i.side, f.size*f.price
`).all();
console.log("Individual fills (sorted by notional):");
for (const r of fills) {
  const flag = (Number(r.size) < 5 || Number(r.notional) < 1) ? " *** UNDER MINIMUM" : "";
  console.log(`  ${r.side} size=${Number(r.size).toFixed(4).padStart(9)} price=${Number(r.price).toFixed(4)} notional=${Number(r.notional).toFixed(4).padStart(8)}${flag}`);
}
db.close();
