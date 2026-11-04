import { view, VAULT, OWNER, SAVINGS, AGENT_ID } from "./_core.mjs";
const near = (y) => (Number(BigInt(y) / 10n ** 20n) / 1e4) + " NEAR";
export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  try {
    const [p, allow] = await Promise.all([view("get_policy"), view("get_allowlist")]);
    res.json({ ok: true, network: "testnet", vault: VAULT, explorer: `https://testnet.nearblocks.io/address/${VAULT}`, owner: OWNER, savings: SAVINGS, agent_public_key: AGENT_ID,
      policy: { per_tx_cap: near(p[0]), daily_cap: near(p[1]), frozen: p[2] }, allowlist: allow, keys_configured: { agent: !!process.env.AGENT_KEY, guard: !!process.env.GUARD_KEY },
      try: "POST /api/intent {\"text\":\"save 0.1 NEAR to stashway-owner-3238.testnet\"}" });
  } catch (e) { res.status(502).json({ ok: false, error: String(e.message).slice(0, 200) }); }
}
