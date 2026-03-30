const express  = require("express");
const crypto   = require("crypto");
const nodemailer = require("nodemailer");
const { query, logActivity } = require("../db");

const router = express.Router();
// Todas las rutas ya vienen protegidas con requireAdmin desde server.js

function getTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get("/users", async (req, res) => {
  const users = await query(
    "SELECT id, email, name, role, status, invited_by, created_at, last_login FROM users ORDER BY created_at DESC"
  );
  res.json(users);
});

// ── POST /api/admin/users/invite { email, role, name } ───────────────────────
router.post("/users/invite", async (req, res) => {
  const { email, role = "dedup", name = "" } = req.body;
  if (!email) return res.status(400).json({ error: "Email requerido" });
  if (!["admin","dedup","upload"].includes(role))
    return res.status(400).json({ error: "Rol inválido" });

  const emailClean = email.trim().toLowerCase();

  // Verificar si ya existe
  const [existing] = await query("SELECT id, status FROM users WHERE email=?", [emailClean]);
  if (existing && existing.status === "active")
    return res.status(409).json({ error: "El usuario ya existe y está activo" });

  // Crear o actualizar usuario
  if (existing) {
    await query("UPDATE users SET role=?, status='active', name=? WHERE email=?", [role, name, emailClean]);
  } else {
    await query(
      "INSERT INTO users (email, name, role, status, invited_by) VALUES (?, ?, ?, 'active', ?)",
      [emailClean, name, role, req.user.email]
    );
  }

  // Crear invitation token (válido 72h)
  const token     = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await query(
    "INSERT INTO invitations (email, role, token, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)",
    [emailClean, role, token, req.user.email, expiresAt]
  );

  const link = `${process.env.APP_URL}/api/auth/invite?token=${token}`;
  const roleLabels = { admin: "Administrador", dedup: "Deduplicación", upload: "Carga masiva" };

  try {
    await getTransport().sendMail({
      from: `"HubSpot Dedup" <${process.env.SMTP_USER}>`,
      to:   emailClean,
      subject: "Invitación a HubSpot Dedup",
      html: `
        <div style="font-family:monospace;max-width:480px;margin:40px auto;padding:32px;border:1px solid #e2e8f0;border-radius:8px;">
          <h2 style="margin:0 0 8px;font-size:18px;">Has sido invitado</h2>
          <p style="color:#64748b;margin:0 0 6px;font-size:13px;">
            <strong>${req.user.email}</strong> te invita a HubSpot Dedup.
          </p>
          <p style="color:#64748b;margin:0 0 6px;font-size:13px;">
            Tu rol: <strong>${roleLabels[role]}</strong>
          </p>
          <p style="color:#64748b;margin:0 0 24px;font-size:13px;">Este enlace expira en <strong>72 horas</strong>.</p>
          <a href="${link}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;">
            Aceptar invitación →
          </a>
        </div>
      `,
    });
  } catch (err) {
    console.error("SMTP error:", err.message);
    return res.status(500).json({ error: "Usuario creado pero no se pudo enviar el email." });
  }

  await logActivity(req.user.email, "invite_user", `${emailClean} (${role})`);
  res.json({ ok: true, message: `Invitación enviada a ${emailClean}` });
});

// ── PATCH /api/admin/users/:id { role?, status? } ────────────────────────────
router.patch("/users/:id", async (req, res) => {
  const { role, status } = req.body;
  const updates = [];
  const params  = [];

  if (role   && ["admin","dedup","upload"].includes(role))   { updates.push("role=?");   params.push(role); }
  if (status && ["active","inactive"].includes(status))       { updates.push("status=?"); params.push(status); }
  if (!updates.length) return res.status(400).json({ error: "Nada que actualizar" });

  params.push(req.params.id);
  const [target] = await query("SELECT email FROM users WHERE id=?", [req.params.id]);
  if (!target) return res.status(404).json({ error: "Usuario no encontrado" });

  await query(`UPDATE users SET ${updates.join(",")} WHERE id=?`, params);
  await logActivity(req.user.email, "update_user", `id=${req.params.id} ${JSON.stringify(req.body)}`);
  res.json({ ok: true });
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
router.delete("/users/:id", async (req, res) => {
  const [target] = await query("SELECT email FROM users WHERE id=?", [req.params.id]);
  if (!target) return res.status(404).json({ error: "Usuario no encontrado" });

  // No permitir que un admin se borre a sí mismo
  if (target.email === req.user.email)
    return res.status(400).json({ error: "No puedes desactivarte a ti mismo" });

  await query("UPDATE users SET status='inactive' WHERE id=?", [req.params.id]);
  await logActivity(req.user.email, "deactivate_user", target.email);
  res.json({ ok: true });
});

// ── GET /api/admin/activity ───────────────────────────────────────────────────
router.get("/activity", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100"), 500);
  const logs  = await query(
    "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?",
    [limit]
  );
  res.json(logs);
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const [userCount]  = await query("SELECT COUNT(*) as n FROM users WHERE status='active'");
  const [batchCount] = await query("SELECT COUNT(*) as n FROM upload_batches");
  const [logCount]   = await query("SELECT COUNT(*) as n FROM activity_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)");
  res.json({
    active_users:   userCount.n,
    total_batches:  batchCount.n,
    actions_7d:     logCount.n,
  });
});

module.exports = router;
