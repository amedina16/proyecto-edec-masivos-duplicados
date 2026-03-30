const express  = require("express");
const multer   = require("multer");
const xlsx     = require("xlsx");
const axios    = require("axios");
const { query } = require("../db");
const { normalizePhone } = require("../utils/phone");

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const HS_BASE = "https://api.hubapi.com";
const HS_PHONE_PROPS = ["phone", "mobilephone", "hs_whatsapp_phone"];

// ── GET /api/upload/hs-properties ─────────────────────────────────────────────
router.get("/hs-properties", async (req, res) => {
  const hsToken = process.env.HUBSPOT_TOKEN;
  try {
    const { data } = await axios.get(
      "https://api.hubapi.com/properties/v2/contacts/properties",
      { headers: { Authorization: `Bearer ${hsToken}` } }
    );

    // Filtrar solo propiedades escribibles y útiles
    const excluded = new Set([
      "hs_object_id","hs_created_by_user_id","hs_updated_by_user_id",
      "hs_is_unworked","hs_sequences_actively_enrolled_count",
      "hs_all_contact_vids","hs_calculated_merged_vids","hs_merged_object_ids",
      "hs_prev_calculated_merged_vids","hs_calculated_phone_number",
      "hs_calculated_phone_number_country_code","hs_calculated_phone_number_region_code",
      "hs_calculated_phone_number_area_code","hs_email_quarantined",
    ]);

    const props = data
      .filter(p =>
        !p.readOnlyValue &&
        !p.calculated &&
        !p.externalOptions &&
        !excluded.has(p.name) &&
        p.fieldType !== "calculation_equation"
      )
      .map(p => ({
        value:    p.name,
        label:    p.label,
        group:    p.groupName,
        type:     p.fieldType,
        required: ["firstname","phone"].includes(p.name),
      }))
      .sort((a, b) => {
        // Poner campos importantes primero
        const priority = ["firstname","lastname","phone","mobilephone","hs_whatsapp_phone","email"];
        const ai = priority.indexOf(a.value);
        const bi = priority.indexOf(b.value);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.label.localeCompare(b.label);
      });

    res.json(props);
  } catch (err) {
    // Fallback a lista básica si falla la API
    res.json([
      { value: "firstname",         label: "Nombre",           group: "contactinformation", type: "text" },
      { value: "lastname",          label: "Apellido",          group: "contactinformation", type: "text" },
      { value: "phone",             label: "Teléfono",          group: "contactinformation", type: "phonenumber" },
      { value: "mobilephone",       label: "Móvil",             group: "contactinformation", type: "phonenumber" },
      { value: "hs_whatsapp_phone", label: "WhatsApp",          group: "contactinformation", type: "phonenumber" },
      { value: "email",             label: "Email",             group: "contactinformation", type: "text" },
      { value: "company",           label: "Empresa",           group: "contactinformation", type: "text" },
      { value: "hs_lead_status",    label: "Estado del lead",   group: "contactinformation", type: "enumeration" },
      { value: "lifecyclestage",    label: "Etapa ciclo vida",  group: "contactinformation", type: "enumeration" },
    ]);
  }
});

// ── POST /api/upload/parse ────────────────────────────────────────────────────
// Recibe el archivo, devuelve columnas detectadas + preview de filas
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

    // Auto-detectar mapeos obvios
    const autoMap = {};
    const lower = (s) => s.toLowerCase().replace(/[\s_-]/g, "");
    for (const col of columns) {
      const l = lower(col);
      if (l.includes("nombre") || l.includes("name"))      autoMap[col] = "firstname";
      else if (l.includes("apellido") || l.includes("last")) autoMap[col] = "lastname";
      else if (l.includes("telef") || l.includes("phone") || l.includes("cel")) autoMap[col] = "phone";
      else if (l.includes("email") || l.includes("correo")) autoMap[col] = "email";
      else if (l.includes("origen") || l.includes("source")) autoMap[col] = "origen__c";
      else if (l.includes("campus"))  autoMap[col] = "campus__c";
      else if (l.includes("año") || l.includes("anio") || l.includes("year")) autoMap[col] = "anio__c";
      else if (l.includes("ciclo") || l.includes("cycle")) autoMap[col] = "ciclo__c";
      else if (l.includes("whatsapp")) autoMap[col] = "hs_whatsapp_phone";
    }

    res.json({ columns, preview, autoMap, total_rows: rows.length });
  } catch (e) {
    res.status(400).json({ error: "No se pudo leer el archivo: " + e.message });
  }
});

// ── POST /api/upload/submit ───────────────────────────────────────────────────
// Guarda el lote completo en staging y lanza validación dedup en background
router.post("/submit", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });

  let mappings;
  try {
    mappings = JSON.parse(req.body.mappings || "{}");
  } catch {
    return res.status(400).json({ error: "Mappings inválidos." });
  }

  // Validar que hay columna mapeada a un campo de teléfono
  const phoneMapping = Object.entries(mappings).find(([, hs]) =>
    ["phone", "mobilephone", "hs_whatsapp_phone"].includes(hs)
  );
  if (!phoneMapping) {
    return res.status(400).json({ error: "Debes mapear al menos una columna a un campo de teléfono." });
  }

  // Validar que hay columna de nombre
  const nameMapping = Object.entries(mappings).find(([, hs]) =>
    ["firstname", "lastname"].includes(hs)
  );
  if (!nameMapping) {
    return res.status(400).json({ error: "Debes mapear al menos una columna al nombre del contacto." });
  }

  try {
    const wb    = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    // Crear lote
    const batchName  = req.body.batch_name || req.file.originalname;
    const batchResult = await query(
      "INSERT INTO upload_batches (name, filename, total_rows, status, created_by) VALUES (?, ?, ?, 'pending', ?)",
      [batchName, req.file.originalname, rows.length, req.user.email]
    );
    const batchId = batchResult.insertId;

    // Guardar mapeos
    for (const [csvCol, hsProp] of Object.entries(mappings)) {
      await query(
        "INSERT INTO field_mappings (batch_id, csv_column, hs_property) VALUES (?, ?, ?)",
        [batchId, csvCol, hsProp]
      );
    }

    // Insertar filas en staging
    const [phoneCol] = phoneMapping;
    const nameCol    = Object.entries(mappings).find(([, hs]) => hs === "firstname")?.[0]
                    || Object.entries(mappings).find(([, hs]) => hs === "lastname")?.[0];
    const emailCol   = Object.entries(mappings).find(([, hs]) => hs === "email")?.[0];
    const origenCol  = Object.entries(mappings).find(([, hs]) => hs === "origen__c")?.[0];
    const campusCol  = Object.entries(mappings).find(([, hs]) => hs === "campus__c")?.[0];
    const anioCol    = Object.entries(mappings).find(([, hs]) => hs === "anio__c")?.[0];
    const cicloCol   = Object.entries(mappings).find(([, hs]) => hs === "ciclo__c")?.[0];

    // Columnas extra (no mapeadas a campos conocidos)
    const knownHsProps = new Set(Object.values(mappings));
    const extraCols = Object.keys(mappings).filter(col => {
      const hs = mappings[col];
      return !["firstname","lastname","phone","mobilephone","hs_whatsapp_phone",
               "email","origen__c","campus__c","anio__c","ciclo__c"].includes(hs);
    });

    for (let i = 0; i < rows.length; i++) {
      const r    = rows[i];
      const tel  = String(r[phoneCol] || "").trim();
      const norm = normalizePhone(tel);
      const extra = {};
      for (const col of extraCols) {
        extra[mappings[col]] = String(r[col] || "");
      }

      await query(
        `INSERT INTO upload_rows
          (batch_id, row_index, nombre, telefono, telefono_norm, email, origen, campus, anio, ciclo, extra_data, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          batchId, i + 1,
          String(r[nameCol] || "").trim(),
          tel, norm,
          emailCol  ? String(r[emailCol]  || "") : null,
          origenCol ? String(r[origenCol] || "") : null,
          campusCol ? String(r[campusCol] || "") : null,
          anioCol   ? String(r[anioCol]   || "") : null,
          cicloCol  ? String(r[cicloCol]  || "") : null,
          Object.keys(extra).length ? JSON.stringify(extra) : null,
        ]
      );
    }

    // Actualizar estado
    await query("UPDATE upload_batches SET status='validating' WHERE id=?", [batchId]);

    // Lanzar validación en background
    validateBatch(batchId).catch(console.error);

    res.json({ batchId, total_rows: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Validación dedup en background ───────────────────────────────────────────
async function validateBatch(batchId) {
  const hsToken = process.env.HUBSPOT_TOKEN;
  const headers = { Authorization: `Bearer ${hsToken}` };

  // Obtener todas las filas con teléfono normalizado
  const rows = await query(
    "SELECT id, telefono_norm FROM upload_rows WHERE batch_id=? AND telefono_norm IS NOT NULL",
    [batchId]
  );

  let clean = 0, dupes = 0;

  for (const row of rows) {
    // Buscar en HubSpot por los 3 campos de teléfono
    let foundId = null, foundField = null;

    for (const prop of HS_PHONE_PROPS) {
      try {
        const { data } = await axios.post(
          `${HS_BASE}/crm/v3/objects/contacts/search`,
          {
            filterGroups: [{ filters: [{ propertyName: prop, operator: "EQ", value: row.telefono_norm }] }],
            properties: ["hs_object_id"],
            limit: 1,
          },
          { headers }
        );
        if (data.total > 0) {
          foundId    = data.results[0].id;
          foundField = prop;
          break;
        }
      } catch { /* continúa con el siguiente campo */ }

      await new Promise(r => setTimeout(r, 80)); // rate limit
    }

    if (foundId) {
      await query(
        "UPDATE upload_rows SET status='duplicate', duplicate_of_hs=?, duplicate_field=? WHERE id=?",
        [foundId, foundField, row.id]
      );
      dupes++;
    } else {
      await query("UPDATE upload_rows SET status='clean' WHERE id=?", [row.id]);
      clean++;
    }
  }

  // Filas sin teléfono válido → error
  await query(
    "UPDATE upload_rows SET status='error', error_msg='Teléfono inválido o vacío' WHERE batch_id=? AND telefono_norm IS NULL",
    [batchId]
  );

  await query(
    "UPDATE upload_batches SET status='ready', clean_rows=?, duplicate_rows=? WHERE id=?",
    [clean, dupes, batchId]
  );
}

// ── GET /api/upload/batches ───────────────────────────────────────────────────
router.get("/batches", async (req, res) => {
  const batches = await query(
    "SELECT * FROM upload_batches ORDER BY created_at DESC LIMIT 50"
  );
  res.json(batches);
});

// ── GET /api/upload/batch/:id ─────────────────────────────────────────────────
router.get("/batch/:id", async (req, res) => {
  const [batch] = await query("SELECT * FROM upload_batches WHERE id=?", [req.params.id]);
  if (!batch) return res.status(404).json({ error: "Lote no encontrado" });

  const rows = await query(
    "SELECT * FROM upload_rows WHERE batch_id=? ORDER BY row_index",
    [req.params.id]
  );
  const mappings = await query(
    "SELECT csv_column, hs_property FROM field_mappings WHERE batch_id=?",
    [req.params.id]
  );

  res.json({ batch, rows, mappings });
});

// ── POST /api/upload/batch/:id/push ──────────────────────────────────────────
// Envía a HubSpot solo las filas aprobadas (clean + las que el usuario forzó)
router.post("/batch/:id/push", async (req, res) => {
  const hsToken = process.env.HUBSPOT_TOKEN;
  const headers = { Authorization: `Bearer ${hsToken}`, "Content-Type": "application/json" };
  const batchId = req.params.id;

  // row_ids opcionales para forzar duplicados específicos
  const { force_row_ids = [] } = req.body;

  const rows = await query(
    `SELECT r.*, b.id as bid FROM upload_rows r
     JOIN upload_batches b ON b.id=r.batch_id
     WHERE r.batch_id=? AND (r.status='clean' OR (r.status='duplicate' AND r.id IN (${force_row_ids.length ? force_row_ids.map(() => "?").join(",") : "NULL"})))`,
    [batchId, ...force_row_ids]
  );

  const mappings = await query(
    "SELECT csv_column, hs_property FROM field_mappings WHERE batch_id=?",
    [batchId]
  );
  const propMap = Object.fromEntries(mappings.map(m => [m.csv_column, m.hs_property]));

  let pushed = 0, failed = 0;

  for (const row of rows) {
    const props = {
      firstname: row.nombre,
      phone:     row.telefono,
      email:     row.email     || undefined,
      origen__c: row.origen    || undefined,
      campus__c: row.campus    || undefined,
      anio__c:   row.anio      || undefined,
      ciclo__c:  row.ciclo     || undefined,
    };

    // Agregar extra_data
    if (row.extra_data) {
      try { Object.assign(props, JSON.parse(row.extra_data)); } catch {}
    }

    // Limpiar undefined
    Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);

    try {
      const { data } = await axios.post(
        `${HS_BASE}/crm/v3/objects/contacts`,
        { properties: props },
        { headers }
      );
      await query(
        "UPDATE upload_rows SET status='pushed', hs_contact_id=? WHERE id=?",
        [data.id, row.id]
      );
      pushed++;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      await query(
        "UPDATE upload_rows SET status='error', error_msg=? WHERE id=?",
        [msg.slice(0, 490), row.id]
      );
      failed++;
    }

    await new Promise(r => setTimeout(r, 150));
  }

  await query(
    "UPDATE upload_batches SET status='pushed', pushed_at=NOW() WHERE id=?",
    [batchId]
  );

  res.json({ pushed, failed });
});

module.exports = router;
