const jwt = require("jsonwebtoken");

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token requerido" });
  }
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

module.exports = { verifyToken };
