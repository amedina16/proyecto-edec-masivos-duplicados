const express    = require("express");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto     = require("crypto");
const { query, logActivity } = require("../db");

const router = express.Router();

// Magic tokens de sesión (login recurrente, TTL 15 min)
const pendingTokens = new Map();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "contacto@th3roots.com,a.medina@th3roots.com")
  .split(",").map(e => e.trim().toLowerCase());

function getTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── POST /api/auth/request { email } ─────────────────────────────────────────
router.post("/request", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email requerido" });

  // Verificar que existe en DB (admins están en DB por seed)
  const [user] = await query(
    "SELECT email, role, status FROM users WHERE email=?",
    [email]
  );

  // Respuesta ambigua por seguridad
  if (!user || user.status !== "active") {
    return res.json({ ok: true, message: "Si el email está registrado, recibirás el enlace." });
  }

  const magicToken = crypto.randomBytes(32).toString("hex");
  const expiresAt  = Date.now() + 15 * 60 * 1000;
  pendingTokens.set(magicToken, { email, role: user.role, expiresAt });

  // Limpiar expirados
  for (const [k, v] of pendingTokens.entries()) {
    if (v.expiresAt < Date.now()) pendingTokens.delete(k);
  }

  const link = `${process.env.APP_URL}/api/auth/verify?token=${magicToken}`;

  try {
    await getTransport().sendMail({
      from: `"HubSpot Dedup" <${process.env.SMTP_USER}>`,
      to:   email,
      subject: "Tu enlace de acceso — HubSpot Dedup",
      html: `
        <div style="font-family:monospace;max-width:480px;margin:40px auto;padding:32px;border:1px solid #e2e8f0;border-radius:8px;">
          <h2 style="margin:0 0 8px;font-size:18px;">Acceso solicitado</h2>
          <p style="color:#64748b;margin:0 0 6px;font-size:13px;">Rol: <strong>${user.role}</strong></p>
          <p style="color:#64748b;margin:0 0 24px;font-size:14px;">Este enlace expira en <strong>15 minutos</strong>.</p>
          <a href="${link}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;">
            Iniciar sesión →
          </a>
          <p style="color:#94a3b8;margin:24px 0 0;font-size:12px;">Si no solicitaste este acceso, ignora este correo.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error("SMTP error:", err.message);
    return res.status(500).json({ error: "No se pudo enviar el email." });
  }

  res.json({ ok: true, message: "Enlace enviado. Revisa tu correo." });
});

// ── GET /api/auth/verify?token=xxx ───────────────────────────────────────────
router.get("/verify", async (req, res) => {
  const record = pendingTokens.get(req.query.token);

  if (!record || record.expiresAt < Date.now()) {
    pendingTokens.delete(req.query.token);
    return res.redirect(`${process.env.APP_URL}/login.html?error=expired`);
  }

  pendingTokens.delete(req.query.token);

  // Actualizar last_login
  await query("UPDATE users SET last_login=NOW() WHERE email=?", [record.email]);
  await logActivity(record.email, "login", "magic link");

  const jwtToken = jwt.sign(
    { email: record.email, role: record.role },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );

  // Redirigir según rol
  const dest = record.role === "upload" ? "/upload.html" : "/dashboard.html";
  res.redirect(`${process.env.APP_URL}${dest}#token=${jwtToken}`);
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Token requerido" });
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    const [user]  = await query("SELECT email, name, role, status FROM users WHERE email=?", [payload.email]);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado" });
    res.json(user);
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
});

module.exports = router;
