import { brain, check, agentTransfer, yocto, VAULT, AGENT_ID, SAVINGS, OWNER } from "./_core.mjs";
const hits = new Map(); // rough per-instance rate limit: 6 sends / minute / IP
const limited = (ip) => { const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 60e3); a.push(now); hits.set(ip, a); return a.length > 6; };
const cors = (res) => { res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type"); };

export default async function handler(req, res) {
  cors(res); if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST {text?, receiver?, near?, skipGuard?, attack?: 'swap'|'replay', send?}" });
  const ip = String(req.headers["x-forwarded-for"] || "?").split(",")[0];
  if (limited(ip)) return res.status(429).json({ error: "rate limited (6/min) — testnet sandbox" });
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const t = b.text ? brain(b.text) : {};
  const receiver = String(b.receiver || t.receiver || "").trim().toLowerCase(), near = String(b.near || t.near || "0.1");
  if (!/^[a-z0-9_.-]{2,64}$/.test(receiver) || !/^\d+(\.\d{1,24})?$/.test(near)) return res.status(400).json({ error: "need receiver (account id) and near (decimal), or text" });
  const send = b.send !== false, attack = b.attack || null, amount = yocto(near);
  const out = { network: "testnet", vault: VAULT, agent: AGENT_ID, brain: b.text ? { text: String(b.text).slice(0, 300), proposed: t } : "none (structured intent)", intent: { receiver, near }, steps: [] };
  const step = (s) => { out.steps.push(s); return s; };
  if (b.skipGuard) {
    step({ label: "jailbroken agent skips Guard, submits with no permit", decision: "SKIPPED", ...(send ? await agentTransfer({ receiver, amount, nonce: String(Date.now() * 1000), expiry: String((Date.now() + 6e5) * 1e6), permit_sig: null }) : { result: "DRY_RUN" }) });
    return res.json(fin(out));
  }
  const g = await check({ vault: VAULT, agent: AGENT_ID, receiver, amount });
  const s = step({ label: "Guard check", decision: g.decision, reasons: g.reasons, evidence: g.evidence, permit: g.permit ? "signed" : "none" });
  if (g.decision === "BLOCK") { s.result = "OFFCHAIN_REFUSAL"; return res.json(fin(out)); }
  if (g.decision === "WARN") { s.result = "WAITING_OWNER_CONFIRM"; s.note = "owner must call owner_confirm for this exact intent; the sandbox owner key is not online"; return res.json(fin(out)); }
  const p = g.permit, args = { receiver: p.receiver, amount: p.amount, nonce: p.nonce, expiry: p.expiry, permit_sig: p.sig };
  if (!send) { s.result = "DRY_RUN"; out.permit = p; return res.json(fin(out)); }
  if (attack === "swap") {
    s.result = "PERMIT_SIGNED";
    const to = receiver === SAVINGS ? OWNER : SAVINGS;
    step({ label: `agent swaps receiver to ${to} after Guard signed`, ...(await agentTransfer({ ...args, receiver: to })) });
    return res.json(fin(out));
  }
  Object.assign(s, await agentTransfer(args)); s.label = "Guard ALLOW → agent_transfer with permit";
  if (attack === "replay") step({ label: "agent replays the same permit", ...(await agentTransfer(args)) });
  res.json(fin(out));
}
const fin = (o) => { o.final = o.steps.at(-1).result; o.error = o.steps.at(-1).error; return o; };
