const express  = require("express");
const multer   = require("multer");
const xlsx     = require("xlsx");
const axios    = require("axios");
const { query } = require("../db");
const { normalizePhone } = require("../utils/phone");

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const HS_BASE        = "https://api.hubapi.com";
const HS_PHONE_PROPS = ["phone", "mobilephone", "hs_whatsapp_phone"];

// ── GET /api/upload/hs-properties ─────────────────────────────────────────────
router.get("/hs-properties", async (req, res) => {
  const hsToken = process.env.HUBSPOT_TOKEN;
  try {
    const { data } = await axios.get(
      `${HS_BASE}/properties/v2/contacts/properties`,
      { headers: { Authorization: `Bearer ${hsToken}` } }
    );
    const excluded = new Set([
      "hs_object_id","hs_created_by_user_id","hs_updated_by_user_id",
      "hs_is_unworked","hs_sequences_actively_enrolled_count",
      "hs_all_contact_vids","hs_calculated_merged_vids","hs_merged_object_ids",
      "hs_prev_calculated_merged_vids","hs_calculated_phone_number",
      "hs_email_quarantined",
    ]);
    const props = data
      .filter(p => !p.readOnlyValue && !p.calculated && !excluded.has(p.name) && p.fieldType !== "calculation_equation")
      .map(p => ({ value: p.name, label: p.label, group: p.groupName, type: p.fieldType }))
      .sort((a, b) => {
        const priority = ["firstname","lastname","Número de teléfono","mobilephone","hs_whatsapp_phone","email"];
        const ai = priority.indexOf(a.value), bi = priority.indexOf(b.value);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.label.localeCompare(b.label);
      });
    res.json(props);
  } catch {
    res.json([
      { value: "firstname",         label: "Nombre",   group: "contactinformation" },
      { value: "lastname",          label: "Apellido",  group: "contactinformation" },
      { value: "phone",             label: "Número de teléfono",  group: "contactinformation" },
      { value: "mobilephone",       label: "Móvil",     group: "contactinformation" },
      { value: "hs_whatsapp_phone", label: "WhatsApp",  group: "contactinformation" },
      { value: "email",             label: "Email",     group: "contactinformation" },
    ]);
  }
});

// ── GET /api/upload/hs-owners ─────────────────────────────────────────────────
// Devuelve usuarios de HubSpot con id y email para el selector de propietario
router.get("/hs-owners", async (req, res) => {
  const hsToken = process.env.HUBSPOT_TOKEN;
  try {
    let owners = [];
    let after  = undefined;
    do {
      const params = { limit: 100, ...(after && { after }) };
      const { data } = await axios.get(`${HS_BASE}/settings/v3/users/`, {
        headers: { Authorization: `Bearer ${hsToken}` },
        params,
      });
      owners.push(...data.results);
      after = data.paging?.next?.after;
    } while (after);

    const list = owners
      .filter(u => u.email)
      .map(u => ({
        id:    u.id,
        email: u.email,
        name:  [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "No se pudo obtener usuarios de HubSpot: " + err.message });
  }
});

// ── GET /api/upload/my-owner-id ───────────────────────────────────────────────
// Devuelve el hubspot owner id del usuario autenticado (por email)
router.get("/my-owner-id", async (req, res) => {
  const hsToken  = process.env.HUBSPOT_TOKEN;
  const myEmail  = req.user.email;
  try {
    let after = undefined;
    do {
      const params = { limit: 100, ...(after && { after }) };
      const { data } = await axios.get(`${HS_BASE}/settings/v3/users/`, {
        headers: { Authorization: `Bearer ${hsToken}` },
        params,
      });
      const found = data.results.find(u => u.email?.toLowerCase() === myEmail.toLowerCase());
      if (found) return res.json({ id: found.id, email: found.email, name: [found.firstName, found.lastName].filter(Boolean).join(" ") });
      after = data.paging?.next?.after;
    } while (after);
    res.status(404).json({ error: "Usuario no encontrado en HubSpot" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/upload/parse ────────────────────────────────────────────────────
router.post("/parse", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
  try {
    const wb    = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = xlsx.utils.sheet_to_json(sheet, { defval: "" });
    if (rows.length === 0) return res.status(400).json({ error: "El archivo está vacío." });

    const columns = Object.keys(rows[0]);
    const preview = rows.slice(0, 5).map(r =>
      Object.fromEntries(columns.map(c => [c, String(r[c] ?? "")]))
    );

    const autoMap = {};
    const lower = s => s.toLowerCase().replace(/[\s_\-()]/g, "");
    for (const col of columns) {
      const l = lower(col);
      if      (l.includes("nombre") && !l.includes("apellido")) autoMap[col] = "firstname";
      else if (l.includes("apellido") || l.includes("lastname"))autoMap[col] = "lastname";
      else if (l.includes("telef") || l.includes("phone") || l.includes("cel") || l.includes("numero")) autoMap[col] = "phone";
      else if (l.includes("email") || l.includes("correo"))     autoMap[col] = "email";
      else if (l.includes("campus"))                             autoMap[col] = "campus";
      else if (l.includes("ciclo"))                              autoMap[col] = "ciclo";
      else if (l.includes("año") || l.includes("anio") || l.includes("year")) autoMap[col] = "ano";
      else if (l.includes("whatsapp"))                           autoMap[col] = "hs_whatsapp_phone";
    }

    res.json({ columns, preview, autoMap, total_rows: rows.length });
  } catch (e) {
    res.status(400).json({ error: "No se pudo leer el archivo: " + e.message });
  }
});

// ── POST /api/upload/submit ───────────────────────────────────────────────────
router.post("/submit", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });

  let mappings, ownerId;
  try {
    mappings = JSON.parse(req.body.mappings || "{}");
    ownerId  = req.body.owner_id || null;
  } catch {
    return res.status(400).json({ error: "Datos inválidos." });
  }

  const phoneMapping = Object.entries(mappings).find(([, hs]) =>
    ["phone","mobilephone","hs_whatsapp_phone"].includes(hs)
  );
  if (!phoneMapping) return res.status(400).json({ error: "Debes mapear al menos una columna a un campo de teléfono." });

  const nameMapping = Object.entries(mappings).find(([, hs]) =>
    ["firstname","lastname"].includes(hs)
  );
  if (!nameMapping) return res.status(400).json({ error: "Debes mapear al menos una columna al nombre." });

  try {
    const wb    = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const batchName  = req.body.batch_name || req.file.originalname;
    const batchResult = await query(
      "INSERT INTO upload_batches (name, filename, total_rows, status, created_by) VALUES (?, ?, ?, 'pending', ?)",
      [batchName, req.file.originalname, rows.length, req.user.email]
    );
    const batchId = batchResult.insertId;

    // Guardar owner_id en el lote
    if (ownerId) {
      await query("UPDATE upload_batches SET created_by=? WHERE id=?",
        [`${req.user.email}|owner:${ownerId}`, batchId]);
    }

    for (const [csvCol, hsProp] of Object.entries(mappings)) {
      await query(
        "INSERT INTO field_mappings (batch_id, csv_column, hs_property) VALUES (?, ?, ?)",
        [batchId, csvCol, hsProp]
      );
    }

    const [phoneCol] = phoneMapping;
    const firstNameCol  = Object.entries(mappings).find(([, hs]) => hs === "firstname")?.[0];
    const lastNameCol   = Object.entries(mappings).find(([, hs]) => hs === "lastname")?.[0];
    const emailCol      = Object.entries(mappings).find(([, hs]) => hs === "email")?.[0];
    const campusCol     = Object.entries(mappings).find(([, hs]) => hs === "campus")?.[0];
    const anioCol       = Object.entries(mappings).find(([, hs]) => hs === "ano")?.[0];
    const cicloCol      = Object.entries(mappings).find(([, hs]) => hs === "ciclo")?.[0];

    const knownProps = new Set(["firstname","lastname","phone","mobilephone","hs_whatsapp_phone",
      "email","campus","ano","ciclo"]);
    const extraCols = Object.keys(mappings).filter(col => !knownProps.has(mappings[col]));

    for (let i = 0; i < rows.length; i++) {
      const r    = rows[i];
      const tel  = String(r[phoneCol] || "").trim();
      const norm = normalizePhone(tel);
      const nombre = [
        firstNameCol ? String(r[firstNameCol] || "") : "",
        lastNameCol  ? String(r[lastNameCol]  || "") : "",
      ].filter(Boolean).join(" ").trim();

      const extra = {};
      for (const col of extraCols) {
        if (r[col] !== undefined && r[col] !== "") extra[mappings[col]] = String(r[col]);
      }
      // Guardar owner_id en extra para el push
      if (ownerId) extra["hubspot_owner_id"] = ownerId;

      await query(
        `INSERT INTO upload_rows
          (batch_id, row_index, nombre, telefono, telefono_norm, email, origen, campus, anio, ciclo, extra_data, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          batchId, i + 1, nombre, tel, norm,
          emailCol  ? String(r[emailCol]  || "") : null,
          null,
          campusCol ? String(r[campusCol] || "") : null,
          anioCol   ? String(r[anioCol]   || "") : null,
          cicloCol  ? String(r[cicloCol]  || "") : null,
          Object.keys(extra).length ? JSON.stringify(extra) : null,
        ]
      );
    }

    await query("UPDATE upload_batches SET status='validating' WHERE id=?", [batchId]);
    validateBatch(batchId).catch(console.error);
    res.json({ batchId, total_rows: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Validación dedup ──────────────────────────────────────────────────────────
async function validateBatch(batchId) {
  const hsToken = process.env.HUBSPOT_TOKEN;
  const headers = { Authorization: `Bearer ${hsToken}` };
  const rows = await query(
    "SELECT id, telefono, telefono_norm FROM upload_rows WHERE batch_id=? AND telefono_norm IS NOT NULL",
    [batchId]
  );

  let clean = 0, dupes = 0;

  for (const row of rows) {
    const norm = row.telefono_norm;
    const variants = new Set([
      norm, norm.replace("+", ""), norm.replace("+52", ""),
      norm.replace("+521", ""), row.telefono,
    ].filter(Boolean));

    let foundId = null, foundField = null;

    outer:
    for (const prop of HS_PHONE_PROPS) {
      for (const variant of variants) {
        try {
          const { data } = await axios.post(
            `${HS_BASE}/crm/v3/objects/contacts/search`,
            { filterGroups: [{ filters: [{ propertyName: prop, operator: "EQ", value: variant }] }], properties: ["hs_object_id"], limit: 1 },
            { headers }
          );
          if (data.total > 0) { foundId = data.results[0].id; foundField = prop; break outer; }
        } catch {}
        await new Promise(r => setTimeout(r, 60));
      }
    }

    if (foundId) {
      await query("UPDATE upload_rows SET status='duplicate', duplicate_of_hs=?, duplicate_field=? WHERE id=?", [foundId, foundField, row.id]);
      dupes++;
    } else {
      await query("UPDATE upload_rows SET status='clean' WHERE id=?", [row.id]);
      clean++;
    }
  }

  await query("UPDATE upload_rows SET status='error', error_msg='Teléfono inválido o vacío' WHERE batch_id=? AND telefono_norm IS NULL", [batchId]);
  await query("UPDATE upload_batches SET status='ready', clean_rows=?, duplicate_rows=? WHERE id=?", [clean, dupes, batchId]);
}

// ── GET /api/upload/batches ───────────────────────────────────────────────────
router.get("/batches", async (req, res) => {
  const batches = await query("SELECT * FROM upload_batches ORDER BY created_at DESC LIMIT 50");
  res.json(batches);
});

// ── GET /api/upload/batch/:id ─────────────────────────────────────────────────
router.get("/batch/:id", async (req, res) => {
  const [batch] = await query("SELECT * FROM upload_batches WHERE id=?", [req.params.id]);
  if (!batch) return res.status(404).json({ error: "Lote no encontrado" });
  const rows     = await query("SELECT * FROM upload_rows WHERE batch_id=? ORDER BY row_index", [req.params.id]);
  const mappings = await query("SELECT csv_column, hs_property FROM field_mappings WHERE batch_id=?", [req.params.id]);
  res.json({ batch, rows, mappings });
});

// ── POST /api/upload/batch/:id/push ──────────────────────────────────────────
router.post("/batch/:id/push", async (req, res) => {
  const hsToken  = process.env.HUBSPOT_TOKEN;
  const headers  = { Authorization: `Bearer ${hsToken}`, "Content-Type": "application/json" };
  const batchId  = req.params.id;
  const { force_row_ids = [] } = req.body;

  const rows = await query(
    `SELECT * FROM upload_rows WHERE batch_id=? AND (
       status='clean' OR
       (status='duplicate' AND id IN (${force_row_ids.length ? force_row_ids.map(() => "?").join(",") : "NULL"}))
     )`,
    [batchId, ...force_row_ids]
  );

  let pushed = 0, failed = 0;

  for (const row of rows) {
    const phoneNorm = row.telefono_norm || row.telefono;
    const props = {
      firstname: row.nombre   || undefined,
      phone:     phoneNorm    || undefined,
      email:     row.email    || undefined,
      campus:    row.campus   || undefined,
      ano:       row.anio     || undefined,
      ciclo:     row.ciclo    || undefined,
    };

    if (row.extra_data) {
      try { Object.assign(props, JSON.parse(row.extra_data)); } catch {}
    }

    Object.keys(props).forEach(k => (props[k] === undefined || props[k] === "") && delete props[k]);

    try {
      const { data } = await axios.post(
        `${HS_BASE}/crm/v3/objects/contacts`,
        { properties: props },
        { headers }
      );
      await query("UPDATE upload_rows SET status='pushed', hs_contact_id=? WHERE id=?", [data.id, row.id]);
      pushed++;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      await query("UPDATE upload_rows SET status='error', error_msg=? WHERE id=?", [msg.slice(0, 490), row.id]);
      failed++;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  await query("UPDATE upload_batches SET status='pushed', pushed_at=NOW() WHERE id=?", [batchId]);
  res.json({ pushed, failed });
});

module.exports = router;
