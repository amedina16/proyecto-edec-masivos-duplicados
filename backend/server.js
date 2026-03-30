require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");

const authRoutes   = require("./routes/auth");
const auditRoutes  = require("./routes/audit");
const mergeRoutes  = require("./routes/merge");
const uploadRoutes = require("./routes/upload");
const adminRoutes  = require("./routes/admin");

const { requirePermission, requireAdmin } = require("./middleware/auth");
const { initSchema } = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;

initSchema().catch(err => console.error("DB init error:", err));

app.use(cors({ origin: process.env.APP_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// Verificar invitation token (flujo primer acceso)
const jwt    = require("jsonwebtoken");
const { query, logActivity } = require("./db");
app.get("/api/auth/invite", async (req, res) => {
  const { token } = req.query;
  const [inv] = await query(
    "SELECT * FROM invitations WHERE token=? AND used_at IS NULL AND expires_at > NOW()",
    [token]
  );
  if (!inv) return res.redirect(`${process.env.APP_URL}/login.html?error=expired`);

  await query("UPDATE invitations SET used_at=NOW() WHERE id=?", [inv.id]);
  await query("UPDATE users SET last_login=NOW() WHERE email=?", [inv.email]);
  await logActivity(inv.email, "first_login", "invitation accepted");

  const jwtToken = jwt.sign(
    { email: inv.email, role: inv.role },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );

  const dest = inv.role === "upload" ? "/upload.html" : "/dashboard.html";
  res.redirect(`${process.env.APP_URL}${dest}#token=${jwtToken}`);
});

// Public
app.use("/api/auth", authRoutes);

// Protected by role
app.use("/api/audit",  requirePermission("audit"),  auditRoutes);
app.use("/api/merge",  requirePermission("merge"),  mergeRoutes);
app.use("/api/upload", requirePermission("upload"), uploadRoutes);
app.use("/api/admin",  requireAdmin,                adminRoutes);

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
