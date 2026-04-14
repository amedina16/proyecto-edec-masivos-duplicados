require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.APP_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// Health check — siempre responde aunque DB falle
app.get("/health", (_, res) => res.json({ ok: true }));

// Iniciar servidor PRIMERO, luego conectar DB
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  initDB();
});

async function initDB() {
  const { initSchema } = require("./db");
  let attempts = 0;
  while (attempts < 10) {
    try {
      await initSchema();
      loadRoutes();
      return;
    } catch (err) {
      attempts++;
      console.error(`DB init error (intento ${attempts}/10):`, err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.error("❌ No se pudo conectar a MySQL después de 10 intentos. Rutas de DB no disponibles.");
  loadRoutes(); // carga rutas de todas formas para que auth funcione sin DB
}

function loadRoutes() {
  const authRoutes   = require("./routes/auth");
  const auditRoutes  = require("./routes/audit");
  const mergeRoutes  = require("./routes/merge");
  const uploadRoutes = require("./routes/upload");
  const adminRoutes  = require("./routes/admin");
  const jwt          = require("jsonwebtoken");
  const { query, logActivity } = require("./db");
  const { requirePermission, requireAdmin } = require("./middleware/auth");

  // Invitation verify
  app.get("/api/auth/invite", async (req, res) => {
    try {
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
      res.redirect(`${process.env.APP_URL}/index.html#token=${jwtToken}`);
    } catch (e) {
      res.redirect(`${process.env.APP_URL}/login.html?error=expired`);
    }
  });

  app.use("/api/auth",   authRoutes);
  app.use("/api/audit",  requirePermission("audit"),  auditRoutes);
  app.use("/api/merge",  requirePermission("merge"),  mergeRoutes);
  app.use("/api/upload", requirePermission("upload"), uploadRoutes);
  app.use("/api/admin",  requireAdmin,                adminRoutes);

  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.join(__dirname, "../frontend/login.html"));
  });

  console.log("✅ Rutas cargadas");
}
