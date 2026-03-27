const express = require("express");
const axios   = require("express");
const axiosLib = require("axios");
const router  = express.Router();

const BASE_URL = "https://api.hubapi.com";
const DELAY_MS = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// POST /api/merge/execute
// Body: { groups: [{ normalized, primary_id, secondary_ids: [] }] }
router.post("/execute", async (req, res) => {
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!hsToken) return res.status(500).json({ error: "HUBSPOT_TOKEN no configurado." });

  const { groups } = req.body;
  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: "Payload inválido. Se esperaba { groups: [...] }" });
  }

  const headers = { Authorization: `Bearer ${hsToken}`, "Content-Type": "application/json" };
  const results = { success: [], failed: [] };

  for (const group of groups) {
    const { primary_id, secondary_ids = [], normalized } = group;
    if (!primary_id || secondary_ids.length === 0) continue;

    for (const secId of secondary_ids) {
      try {
        await axiosLib.post(
          `${BASE_URL}/crm/v3/objects/contacts/merge`,
          { primaryObjectId: String(primary_id), objectIdToMerge: String(secId) },
          { headers }
        );
        results.success.push({ normalized, primary_id, merged: secId });
      } catch (err) {
        const msg = err.response ? JSON.stringify(err.response.data) : err.message;
        results.failed.push({ normalized, primary_id, merged: secId, error: msg });
      }
      await sleep(DELAY_MS);
    }
  }

  res.json({
    total_success: results.success.length,
    total_failed:  results.failed.length,
    results,
  });
});

module.exports = router;
