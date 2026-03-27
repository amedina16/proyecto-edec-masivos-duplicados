const express    = require("express");
const jwt        = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto     = require("crypto");

const router = express.Router();

// In-memory store para magic tokens (TTL 15 min)
// En producción puedes usar Redis o una tabla en SQLite
const pendingTokens = new Map();

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "").split(",").map(e => e.trim().toLowerCase());

function getTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// POST /api/auth/request  { email }
router.post("/request", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();

  if (!email) return res.status(400).json({ error: "Email requerido" });
  if (!ALLOWED_EMAILS.includes(email)) {
    // Respuesta ambigua por seguridad
    return res.json({ ok: true, message: "Si el email está registrado, recibirás el enlace." });
  }

  // Generar token de 32 bytes
  const magicToken = crypto.randomBytes(32).toString("hex");
  const expiresAt  = Date.now() + 15 * 60 * 1000; // 15 min

  pendingTokens.set(magicToken, { email, expiresAt });

  // Limpiar tokens expirados
  for (const [k, v] of pendingTokens.entries()) {
    if (v.expiresAt < Date.now()) pendingTokens.delete(k);
  }

  const link = `${process.env.APP_URL}/api/auth/verify?token=${magicToken}`;

  try {
    const transport = getTransport();
    await transport.sendMail({
      from: `"HubSpot Dedup" <${process.env.SMTP_USER}>`,
      to:   email,
      subject: "Tu enlace de acceso — HubSpot Dedup",
      html: `
        <div style="font-family:monospace;max-width:480px;margin:40px auto;padding:32px;border:1px solid #e2e8f0;border-radius:8px;">
          <h2 style="margin:0 0 16px;font-size:18px;letter-spacing:-0.5px;">Acceso solicitado</h2>
          <p style="color:#64748b;margin:0 0 24px;font-size:14px;">Este enlace expira en <strong>15 minutos</strong>.</p>
          <a href="${link}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;letter-spacing:0.5px;">
            Iniciar sesión →
          </a>
          <p style="color:#94a3b8;margin:24px 0 0;font-size:12px;">Si no solicitaste este acceso, ignora este correo.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error("SMTP error:", err.message);
    return res.status(500).json({ error: "No se pudo enviar el email. Verifica la config SMTP." });
  }

  res.json({ ok: true, message: "Enlace enviado. Revisa tu correo." });
});

// GET /api/auth/verify?token=xxx
router.get("/verify", (req, res) => {
  const { token } = req.query;
  const record = pendingTokens.get(token);

  if (!record || record.expiresAt < Date.now()) {
    pendingTokens.delete(token);
    return res.redirect(`${process.env.APP_URL}/login.html?error=expired`);
  }

  pendingTokens.delete(token);

  const jwt_token = jwt.sign(
    { email: record.email },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );

  // Redirige al dashboard con el JWT en el hash (no en query string para seguridad)
  res.redirect(`${process.env.APP_URL}/dashboard.html#token=${jwt_token}`);
});

module.exports = router;
