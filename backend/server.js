require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const fs         = require("fs");

const authRoutes   = require("./routes/auth");
const auditRoutes  = require("./routes/audit");
const mergeRoutes  = require("./routes/merge");
const uploadRoutes = require("./routes/upload");
const { verifyToken } = require("./middleware/auth");
const { initSchema } = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;

// Inicializar schema MySQL al arrancar
initSchema().catch(err => console.error("DB init error:", err));

app.use(cors({ origin: process.env.APP_URL, credentials: true }));
app.use(express.json());

// Static frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// Public routes
app.use("/api/auth", authRoutes);

// Protected routes
app.use("/api/audit", verifyToken, auditRoutes);
app.use("/api/merge", verifyToken, mergeRoutes);
app.use("/api/upload", verifyToken, uploadRoutes);

// Health check
app.get("/health", (_, res) => res.json({ ok: true }));

// SPA fallback
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
