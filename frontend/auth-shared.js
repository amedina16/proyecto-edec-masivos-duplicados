// auth-shared.js — incluir en todas las páginas con <script src="/auth-shared.js">

window.Auth = (function () {
  let TOKEN = null;
  let PAYLOAD = null;

  function init() {
    // Leer token del hash (magic link) o localStorage
    const hash   = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const t      = params.get("token");

    if (t) {
      localStorage.setItem("hs_dedup_token", t);
      history.replaceState(null, "", location.pathname);
    }

    TOKEN = localStorage.getItem("hs_dedup_token");

    if (!TOKEN) {
      location.href = "/login.html";
      return null;
    }

    try {
      PAYLOAD = JSON.parse(atob(TOKEN.split(".")[1]));

      // Solo invalidar si el token está expirado — nunca por rol
      if (PAYLOAD.exp * 1000 < Date.now()) {
        localStorage.removeItem("hs_dedup_token");
        location.href = "/login.html";
        return null;
      }

      return PAYLOAD;
    } catch {
      localStorage.removeItem("hs_dedup_token");
      location.href = "/login.html";
      return null;
    }
  }

  function logout() {
    localStorage.removeItem("hs_dedup_token");
    location.href = "/login.html";
  }

  // Verifica si el token está expirado sin redirigir
  function isExpired() {
    if (!PAYLOAD) return true;
    return PAYLOAD.exp * 1000 < Date.now();
  }

  function getToken()  { return TOKEN; }
  function getRole()   { return PAYLOAD?.role || null; }
  function getEmail()  { return PAYLOAD?.email || ""; }

  function can(module) {
    const perms = {
      admin:  ["audit", "merge", "upload", "admin"],
      dedup:  ["audit", "merge"],
      upload: ["upload"],
    };
    return (perms[getRole()] || []).includes(module);
  }

  // Función api centralizada — úsala en cualquier página
  async function api(method, path, body, isFormData = false) {
    const opts = {
      method,
      headers: { Authorization: `Bearer ${TOKEN}` },
    };
    if (body && !isFormData) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    } else if (body) {
      opts.body = body;
    }

    const res = await fetch(path, opts);

    if (res.status === 401 || res.status === 403) {
      // Solo cerrar sesión si el token expiró de verdad
      if (isExpired()) { logout(); return; }
      // Token vigente pero sin permiso — lanzar error sin cerrar sesión
      const msg = res.status === 403 ? "Sin permiso para esta acción" : "Error de autenticación";
      throw new Error(msg);
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error del servidor");
    return data;
  }

  return { init, logout, isExpired, getToken, getRole, getEmail, can, api };
})();