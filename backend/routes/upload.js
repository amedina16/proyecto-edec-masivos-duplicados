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
      "hs_prev_calculated_merged_vids","hs_calculated_phone_number","hs_email_quarantined",
    ]);
    const props = data
      .filter(p => !p.readOnlyValue && !p.calculated && !excluded.has(p.name) && p.fieldType !== "calculation_equation")
      .map(p => ({ value: p.name, label: p.label, group: p.groupName, type: p.fieldType }))
      .sort((a, b) => {
        const priority = ["firstname","lastname","phone","mobilephone","hs_whatsapp_phone","email"];
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
      { value: "phone",             label: "Teléfono",  group: "contactinformation" },
      { value: "mobilephone",       label: "Móvil",     group: "contactinformation" },
      { value: "hs_whatsapp_phone", label: "WhatsApp",  group: "contactinformation" },
      { value: "email",             label: "Email",     group: "contactinformation" },
    ]);
  }
});

// ── GET /api/upload/hs-owners ─────────────────────────────────────────────────
// Lee desde la tabla hs_owners en DB (sincronizada con sync_hs_owners.js)
router.get("/hs-owners", async (req, res) => {
  try {
    const owners = await query(
      "SELECT owner_id as id, email, nombre as name FROM hs_owners ORDER BY nombre ASC"
    );
    if (owners.length === 0) {
      return res.status(404).json({ error: "Tabla hs_owners vacía. Ejecuta el script sync_hs_owners.js primero." });
    }
    res.json(owners);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/upload/my-owner-id ───────────────────────────────────────────────
// Busca el owner id del usuario autenticado consultando la tabla hs_owners
router.get("/my-owner-id", async (req, res) => {
  const myEmail = req.user.email;
  try {
    const [owner] = await query(
      "SELECT owner_id, email, nombre FROM hs_owners WHERE LOWER(email) = LOWER(?) LIMIT 1",
      [myEmail]
    );
    if (owner) return res.json({ id: owner.owner_id, email: owner.email, name: owner.nombre });
    res.status(404).json({ error: "Tu usuario no está en la tabla hs_owners. Ejecuta el script de sincronización." });
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
    const EXACT_MAP = {
      "nombre":                   "firstname",
      "apellidos":                "lastname",
      "apellido":                 "lastname",
      "correo":                   "email",
      "email":                    "email",
      "numerodetelfono":          "phone",
      "numerodetelefono":         "phone",
      "nmerodetelfono":           "phone",
      "telefono":                 "phone",
      "celular":                  "phone",
      "phone":                    "phone",
      "campus":                   "campus",
      "contactowner":             "hubspot_owner_id",
      "owner":                    "hubspot_owner_id",
      "propietario":              "hubspot_owner_id",
      "ciclo":                    "ciclo",
      "ao":                       "ano",
      "ano":                      "ano",
      "anio":                     "ano",
      "year":                     "ano",
      "estatus":                  "estatus",
      "status":                   "estatus",
      "origenbuildingblocks":     "origen__building_blocks___original_",
      "origen":                   "origen__building_blocks___original_",
      "detalledeorigen":          "detalle_de_origen__atn_esc_",
      "detalleorigen":            "detalle_de_origen__atn_esc_",
      "estadodelead2023":         "estado_de_lead_2023_b",
      "estadolead":               "estado_de_lead_2023_b",
      "estadodelead":             "estado_de_lead_2023_b",
      "nivel":                    "nivel",
      "programadeinteres":        "programa_de_inter_s",
      "programadeinteres":        "programa_de_inter_s",
      "programainteres":          "programa_de_inter_s",
      "escueladeprocedencia":     "escuela_de_procedencia__2022_",
      "escuelaprocedencia":       "escuela_de_procedencia__2022_",
      "escuela":                  "escuela_de_procedencia__2022_",
      "whatsapp":                 "hs_whatsapp_phone",
    };
    const normalizeCol = s => s.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[\s_\-()[\]]/g, "");
    for (const col of columns) {
      const key = normalizeCol(col);
      if (EXACT_MAP[key]) autoMap[col] = EXACT_MAP[key];
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

    const batchName   = req.body.batch_name || req.file.originalname;
    const batchResult = await query(
      "INSERT INTO upload_batches (name, filename, total_rows, status, created_by) VALUES (?, ?, ?, 'pending', ?)",
      [batchName, req.file.originalname, rows.length, req.user.email]
    );
    const batchId = batchResult.insertId;

    for (const [csvCol, hsProp] of Object.entries(mappings)) {
      await query(
        "INSERT INTO field_mappings (batch_id, csv_column, hs_property) VALUES (?, ?, ?)",
        [batchId, csvCol, hsProp]
      );
    }

    const [phoneCol]   = phoneMapping;
    const firstNameCol = Object.entries(mappings).find(([, hs]) => hs === "firstname")?.[0];
    const lastNameCol  = Object.entries(mappings).find(([, hs]) => hs === "lastname")?.[0];
    const emailCol     = Object.entries(mappings).find(([, hs]) => hs === "email")?.[0];
    const campusCol    = Object.entries(mappings).find(([, hs]) => hs === "campus")?.[0];
    const anioCol      = Object.entries(mappings).find(([, hs]) => hs === "ano")?.[0];
    const cicloCol     = Object.entries(mappings).find(([, hs]) => hs === "ciclo")?.[0];

    const knownProps = new Set(["firstname","lastname","phone","mobilephone","hs_whatsapp_phone",
      "email","campus","ano","ciclo","hubspot_owner_id"]);
    const extraCols = Object.keys(mappings).filter(col => !knownProps.has(mappings[col]));

    // Columna de Contact owner en el CSV (mapeada a hubspot_owner_id)
    const ownerCol = Object.entries(mappings).find(([, hs]) => hs === "hubspot_owner_id")?.[0];

    // Resolver Contact owner consultando la tabla hs_owners en DB
    async function resolveOwnerValue(rawValue) {
      if (!rawValue) return null;
      const val = String(rawValue).trim();

      // Si ya es numérico, es un ID directo
      if (/^\d+$/.test(val)) return val;

      // Buscar por email exacto
      const [byEmail] = await query(
        "SELECT owner_id FROM hs_owners WHERE email = ? LIMIT 1",
        [val.toLowerCase()]
      );
      if (byEmail) { console.log(`[owners] Resuelto por email: ${val} → ${byEmail.owner_id}`); return byEmail.owner_id; }

      // Buscar por nombre completo exacto (case insensitive)
      const [byName] = await query(
        "SELECT owner_id FROM hs_owners WHERE LOWER(nombre) = LOWER(?) LIMIT 1",
        [val]
      );
      if (byName) { console.log(`[owners] Resuelto por nombre: ${val} → ${byName.owner_id}`); return byName.owner_id; }

      // Buscar por nombre parcial (LIKE)
      const [byPartial] = await query(
        "SELECT owner_id, nombre FROM hs_owners WHERE LOWER(nombre) LIKE LOWER(?) LIMIT 1",
        [`%${val}%`]
      );
      if (byPartial) { console.log(`[owners] Resuelto por parcial: ${val} → ${byPartial.owner_id} (${byPartial.nombre})`); return byPartial.owner_id; }

      console.warn(`[owners] No resuelto en DB: "${val}"`);
      return null;
    }

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

      // Resolver Contact owner del CSV → owner ID de HubSpot
      let contactOwnerId = null;
      if (ownerCol && r[ownerCol]) {
        contactOwnerId = await resolveOwnerValue(r[ownerCol]);
        if (contactOwnerId) extra["hubspot_owner_id"] = contactOwnerId;
      }

      // creado_por_carga_masiva = owner ID del usuario que sube (ownerId del selector)
      // hubspot_owner_id        = owner del contacto (Contact owner del CSV)
      if (ownerId) {
        extra["creado_por_carga_masiva"] = String(ownerId);
        // Solo sobreescribe hubspot_owner_id si no vino del CSV
        if (!contactOwnerId) extra["hubspot_owner_id"] = String(ownerId);
      }

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
  const rows    = await query(
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
  const batches = await query(
    "SELECT * FROM upload_batches ORDER BY created_at DESC LIMIT 200"
  );
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
  const hsToken = process.env.HUBSPOT_TOKEN;
  const headers = { Authorization: `Bearer ${hsToken}`, "Content-Type": "application/json" };
  const batchId = req.params.id;

  // Solo se envían contactos limpios — los duplicados nunca se fuerzan
  const rows = await query(
    "SELECT * FROM upload_rows WHERE batch_id=? AND status='clean'",
    [batchId]
  );

  let pushed = 0, failed = 0;

  for (const row of rows) {
    const phoneNorm = row.telefono_norm || row.telefono;
    const props = {
      firstname: row.nombre  || undefined,
      phone:     phoneNorm   || undefined,
      email:     row.email   || undefined,
      campus:    row.campus  || undefined,
      ano:       row.anio    || undefined,
      ciclo:     row.ciclo   || undefined,
    };

    // Mezclar extra_data (contiene propiedades custom + hubspot_owner_id)
    // MySQL devuelve columnas JSON ya parseadas como objeto, no como string
    if (row.extra_data) {
      try {
        const extra = typeof row.extra_data === "string"
          ? JSON.parse(row.extra_data)
          : row.extra_data;
        Object.assign(props, extra);
      } catch (e) {
        console.error("[push] Error parseando extra_data:", e.message, row.extra_data);
      }
    }

    // Normalizar campos enum — HubSpot es case-sensitive en las opciones
    // 1. Capitalizar campos simples: ACTIVO → Activo
    const CAPITALIZE_FIELDS = ["estatus", "nivel"];
    for (const field of CAPITALIZE_FIELDS) {
      if (props[field]) {
        props[field] = props[field].charAt(0).toUpperCase() + props[field].slice(1).toLowerCase();
      }
    }

    // 2. Correcciones de typos en campos enum
    const VALUE_CORRECTIONS = {
      "origen__building_blocks___original_": {
        "atencion a empresa":     "Atención a empresas",
        "atención a empresa":    "Atención a empresas",
        "atencion a empresas":    "Atención a empresas",
        "atención a empresas":   "Atención a empresas",
        "atencion a escuelas":    "Atención a escuelas",
        "atención a escuelas":   "Atención a escuelas",
        "sitio web":              "Sitio web",
        "eventos":                "Eventos",
        "referido por":           "Referido por",
        "fachada / piso":         "Fachada / Piso",
        "prospeccion en campo":   "Prospección en campo",
        "prospección en campo":   "Prospección en campo",
        "medios de comunicacion": "Medios de comunicación",
        "medios de comunicación": "Medios de comunicación",
        "recuperados":            "Recuperados",
        "mineria":                "Mineria",
        "paso automatico":        "Paso automático",
        "paso automático":        "Paso automático",
        "bd edec":                "BD EDEC",
        "uvm":                    "UVM",
        "uanl":                   "UANL",
      },
    };
    for (const [field, corrections] of Object.entries(VALUE_CORRECTIONS)) {
      if (props[field]) {
        const key = props[field].toLowerCase()
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .trim();
        const corrected = Object.entries(corrections).find(([k]) =>
          k.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim() === key
        );
        if (corrected) props[field] = corrected[1];
      }
    }

    // Limpiar valores vacíos/undefined
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
