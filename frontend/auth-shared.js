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

  function getToken()   { return TOKEN; }
  function getRole()    { return PAYLOAD?.role || null; }
  function getEmail()   { return PAYLOAD?.email || ""; }
  function can(module) {
    const perms = {
      admin:  ["audit", "merge", "upload", "admin"],
      dedup:  ["audit", "merge"],
      upload: ["upload"],
    };
    return (perms[getRole()] || []).includes(module);
  }

  return { init, logout, getToken, getRole, getEmail, can };
})();