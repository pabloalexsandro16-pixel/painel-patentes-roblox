import express from "express";
import rateLimit from "express-rate-limit";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 10000;
const GROUP_ID = process.env.ROBLOX_GROUP_ID || "1029517697";
const API_KEY = process.env.ROBLOX_API_KEY;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const MAX_PROMOTION_RANK = Number(process.env.MAX_PROMOTION_RANK || 100);
const INSTRUCTORS = parseJsonEnv("INSTRUCTORS_JSON", {});
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

function parseJsonEnv(name, fallback) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch { console.error(`Variável ${name} precisa ser JSON válido.`); return fallback; }
}
function requiredEnv() {
  const missing = [];
  for (const [key, value] of Object.entries({
    ADMIN_USERNAME, ADMIN_PASSWORD, COOKIE_SECRET, DATABASE_URL, API_KEY
  })) if (!value) missing.push(key);
  if (missing.length) {
    console.error("Faltam variáveis obrigatórias:", missing.join(", "));
    process.exit(1);
  }
}
requiredEnv();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

await pool.query(`
  CREATE TABLE IF NOT EXISTS training_log (
    id BIGSERIAL PRIMARY KEY,
    roblox_username TEXT NOT NULL,
    roblox_user_id TEXT NOT NULL,
    training TEXT NOT NULL,
    instructor TEXT NOT NULL,
    old_role TEXT NOT NULL,
    new_role TEXT NOT NULL,
    status TEXT NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(body).digest();
  let actual;
  try { actual = Buffer.from(sig, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function auth(req, res, next) {
  const token = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("panel_session="))?.slice("panel_session=".length);
  const user = verify(token);
  if (!user) return res.status(401).json({ error: "Faça login novamente." });
  req.user = user;
  next();
}
function sameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
    return res.status(403).json({ error: "Origem não autorizada." });
  }
  next();
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.post("/api/login", sameOrigin, loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") return res.status(400).json({ error: "Informe usuário e senha." });
  let role = null;
  let expectedPassword = null;
  if (username === ADMIN_USERNAME) { role = "admin"; expectedPassword = ADMIN_PASSWORD; }
  else if (Object.hasOwn(INSTRUCTORS, username)) { role = "instrutor"; expectedPassword = INSTRUCTORS[username]; }
  const a = Buffer.from(password);
  const b = Buffer.from(String(expectedPassword ?? crypto.randomBytes(16).toString("hex")));
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!role || !valid) return res.status(401).json({ error: "Usuário ou senha incorretos." });
  const token = sign({ username, role, exp: Date.now() + 8 * 60 * 60 * 1000 });
  res.setHeader("Set-Cookie", `panel_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  res.json({ username, role });
});
app.post("/api/logout", sameOrigin, (_req, res) => {
  res.setHeader("Set-Cookie", "panel_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => res.json({ username: req.user.username, role: req.user.role }));

async function roblox(pathname, options = {}) {
  const response = await fetch(`https://apis.roblox.com${pathname}`, {
    ...options,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const err = new Error(data.message || data.error || `Roblox API respondeu ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}
async function getRoles() {
  const all = [];
  let pageToken = "";
  for (let i = 0; i < 10; i++) {
    const query = new URLSearchParams({ maxPageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const data = await roblox(`/cloud/v2/groups/${GROUP_ID}/roles?${query}`);
    all.push(...(data.groupRoles || data.roles || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return all.map(r => ({
    id: String(r.id || r.roleId || ""),
    name: String(r.displayName || r.name || ""),
    rank: Number(r.rank ?? 0)
  })).filter(r => r.id && r.name).sort((a,b) => b.rank - a.rank);
}
async function usernameToId(username) {
  const response = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
  });
  const data = await response.json();
  if (!response.ok || !data.data?.length) throw new Error("Nome de usuário Roblox não encontrado.");
  return { id: String(data.data[0].id), username: data.data[0].name };
}
async function findMembership(userId) {
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const query = new URLSearchParams({ maxPageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const data = await roblox(`/cloud/v2/groups/${GROUP_ID}/memberships?${query}`);
    const memberships = data.groupMemberships || data.memberships || [];
    const found = memberships.find(m => String(m.user?.userId ?? m.userId ?? "") === String(userId));
    if (found) return found;
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  throw new Error("Jogador não encontrado entre os membros do grupo. Confirme se ele entrou no grupo.");
}
app.get("/api/roles", auth, async (_req, res) => {
  try {
    const roles = await getRoles();
    res.json({ groupId: GROUP_ID, roles: roles.map(r => ({ ...r, eligible: r.rank <= MAX_PROMOTION_RANK })) });
  } catch (e) {
    console.error("roles:", e.message);
    res.status(502).json({ error: "Não consegui carregar as patentes. Verifique a chave e as permissões da API Roblox." });
  }
});
app.get("/api/history", auth, async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, roblox_username, training, instructor, old_role, new_role, status, details, created_at FROM training_log ORDER BY id DESC LIMIT 50");
    res.json({ rows: result.rows });
  } catch (e) {
    console.error("history:", e.message);
    res.status(500).json({ error: "Erro ao carregar histórico." });
  }
});
app.post("/api/approve", auth, sameOrigin, async (req, res) => {
  const { robloxUsername, training, targetRoleId } = req.body || {};
  if (typeof robloxUsername !== "string" || robloxUsername.trim().length < 3 || robloxUsername.length > 20 ||
      typeof training !== "string" || training.trim().length < 3 || training.length > 100 ||
      typeof targetRoleId !== "string") {
    return res.status(400).json({ error: "Preencha usuário, treinamento e patente de destino." });
  }
  let user, membership, roles, target, currentRole;
  try {
    user = await usernameToId(robloxUsername.trim());
    membership = await findMembership(user.id);
    roles = await getRoles();
    const currentRoleId = String(membership.role?.id ?? membership.roleId ?? "");
    currentRole = roles.find(r => r.id === currentRoleId);
    target = roles.find(r => r.id === targetRoleId);
    if (!target) return res.status(400).json({ error: "Patente de destino inválida." });
    if (target.rank > MAX_PROMOTION_RANK) return res.status(403).json({ error: "Essa patente está bloqueada para promoção automática. Ajuste MAX_PROMOTION_RANK apenas se necessário." });
    if (!currentRole) return res.status(400).json({ error: "Não consegui identificar a patente atual do jogador." });
    if (target.rank <= currentRole.rank) return res.status(400).json({ error: "A patente escolhida não é superior à patente atual." });
    if (target.rank > 100) return res.status(403).json({ error: "Promoções acima do limite seguro estão bloqueadas." });

    const log = await pool.query(
      `INSERT INTO training_log (roblox_username, roblox_user_id, training, instructor, old_role, new_role, status)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDENTE') RETURNING id`,
      [user.username, user.id, training.trim(), req.user.username, currentRole.name, target.name]
    );
    const membershipId = String(membership.path?.split("/").pop() || membership.id || membership.membershipId || "");
    if (!membershipId) throw new Error("A API não retornou o ID da associação do jogador.");
    await roblox(`/cloud/v2/groups/${GROUP_ID}/memberships/${encodeURIComponent(membershipId)}:assignRole`, {
      method: "POST",
      body: JSON.stringify({ roleId: target.id })
    });
    await pool.query("UPDATE training_log SET status='CONCLUÍDO', details=$1 WHERE id=$2", ["Promoção aplicada pela API Roblox.", log.rows[0].id]);
    res.json({ ok: true, message: `${user.username} foi promovido de ${currentRole.name} para ${target.name}.` });
  } catch (e) {
    console.error("approve:", e.message);
    try {
      if (user) await pool.query(
        `INSERT INTO training_log (roblox_username, roblox_user_id, training, instructor, old_role, new_role, status, details)
         VALUES ($1,$2,$3,$4,$5,$6,'ERRO',$7)`,
        [user.username, user.id, String(training || "Não informado").slice(0,100), req.user.username, currentRole?.name || "Desconhecida", target?.name || "Desconhecida", e.message.slice(0,300)]
      );
    } catch (logError) { console.error("log error:", logError.message); }
    res.status(400).json({ error: e.message || "Não foi possível concluir a promoção." });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Painel iniciado na porta ${PORT}; grupo ${GROUP_ID}`));
