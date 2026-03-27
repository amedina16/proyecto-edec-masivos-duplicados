const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");
const router  = express.Router();

const PHONE_PROPS = ["phone", "hs_whatsapp_phone", "telefono"];
const EXTRA_PROPS = ["firstname", "lastname", "email", "hubspot_owner_id", "createdate", "lastmodifieddate", "hs_object_id"];
const ALL_PROPS   = [...new Set([...PHONE_PROPS, ...EXTRA_PROPS])];
const BASE_URL    = "https://api.hubapi.com";

// ── Job store en memoria ──────────────────────────────────────────────────────
const jobs = new Map();

function normalize(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("521") && digits.length === 13) digits = "52" + digits.slice(3);
  if (digits.startsWith("52") && digits.length === 12) return "+" + digits;
  if (digits.length === 10) return "+52" + digits;
  if (digits.length > 10) return "+" + digits;
  return null;
}

async function fetchAllContacts(token, onProgress) {
  const contacts = [];
  let after = undefined;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  do {
    const params = { limit: 100, properties: ALL_PROPS.join(","), ...(after && { after }) };
    const { data } = await axios.get(`${BASE_URL}/crm/v3/objects/contacts`, { headers, params });
    contacts.push(...data.results);
    after = data.paging?.next?.after;
    onProgress(contacts.length);
    await new Promise(r => setTimeout(r, 50));
  } while (after);

  return contacts;
}

function groupByPhone(contacts) {
  const map = new Map();
  for (const c of contacts) {
    const props = c.properties;
    const phones = PHONE_PROPS.map(p => props[p]).filter(Boolean);
    const normalized = phones.map(normalize).find(Boolean);
    if (!normalized) continue;
    if (!map.has(normalized)) map.set(normalized, []);
    map.get(normalized).push({ ...props, id: c.id });
  }
  return [...map.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([normalized, group]) => {
      group.sort((a, b) => new Date(b.createdate) - new Date(a.createdate));
      return {
        normalized,
        count: group.length,
        contacts: group.map((c, i) => ({
          id:            c.id,
          firstname:     c.firstname || "",
          lastname:      c.lastname  || "",
          email:         c.email     || "",
          phone:         c.phone     || "",
          whatsapp:      c.hs_whatsapp_phone || "",
          telefono:      c.telefono  || "",
          owner_id:      c.hubspot_owner_id  || "",
          createdate:    c.createdate?.split("T")[0] || "",
          modified:      c.lastmodifieddate?.split("T")[0] || "",
          suggested_primary: i === 0,
        })),
      };
    })
    .sort((a, b) => b.count - a.count);
}

// POST /api/audit/start → inicia job en background, devuelve jobId inmediatamente
router.post("/start", (req, res) => {
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!hsToken) return res.status(500).json({ error: "HUBSPOT_TOKEN no configurado." });

  const jobId = crypto.randomBytes(8).toString("hex");
  jobs.set(jobId, { status: "running", progress: 0, result: null, error: null, startedAt: Date.now() });

  // Corre en background — sin await
  (async () => {
    try {
      const contacts = await fetchAllContacts(hsToken, (n) => {
        const job = jobs.get(jobId);
        if (job) job.progress = n;
      });
      const groups = groupByPhone(contacts);
      jobs.set(jobId, {
        status: "done",
        progress: contacts.length,
        result: { total_contacts: contacts.length, total_groups: groups.length, groups },
        error: null,
        startedAt: jobs.get(jobId)?.startedAt,
      });
    } catch (err) {
      const msg = err.response ? JSON.stringify(err.response.data) : err.message;
      jobs.set(jobId, { status: "error", progress: 0, result: null, error: msg, startedAt: Date.now() });
    }
    // Limpiar jobs viejos (más de 2 horas)
    for (const [id, job] of jobs.entries()) {
      if (Date.now() - job.startedAt > 2 * 60 * 60 * 1000) jobs.delete(id);
    }
  })();

  res.json({ jobId });
});

// GET /api/audit/status/:jobId → polling del frontend cada 3s
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job no encontrado" });

  if (job.status === "running") return res.json({ status: "running", progress: job.progress });
  if (job.status === "error")   return res.json({ status: "error", error: job.error });

  // done — devuelve resultado y limpia memoria
  const result = job.result;
  jobs.delete(req.params.jobId);
  res.json({ status: "done", ...result });
});

module.exports = router;
