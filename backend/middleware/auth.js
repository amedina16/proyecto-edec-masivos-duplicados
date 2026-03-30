const jwt   = require("jsonwebtoken");
const { query } = require("../db");

// Roles que tienen acceso a cada módulo
const ROLE_PERMISSIONS = {
  admin: ["audit", "merge", "upload", "admin"],
  dedup: ["audit", "merge"],
  upload: ["upload"],
};

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer "))
    return res.status(401).json({ error: "Token requerido" });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// Middleware de permiso por módulo
function requirePermission(module) {
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer "))
      return res.status(401).json({ error: "Token requerido" });
    try {
      const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
      req.user = payload;

      const allowed = ROLE_PERMISSIONS[payload.role] || [];
      if (!allowed.includes(module))
        return res.status(403).json({ error: "Sin permiso para esta acción" });

      // Verificar que el usuario sigue activo en DB
      const [user] = await query(
        "SELECT id, status FROM users WHERE email=?",
        [payload.email]
      );
      if (!user || user.status !== "active")
        return res.status(403).json({ error: "Cuenta inactiva" });

      next();
    } catch {
      res.status(401).json({ error: "Token inválido o expirado" });
    }
  };
}

function requireAdmin(req, res, next) {
  return requirePermission("admin")(req, res, next);
}

module.exports = { verifyToken, requirePermission, requireAdmin };
