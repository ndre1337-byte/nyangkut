/**
 * Nyangkut Share Link — POST /api/share/get
 *
 * Public read-only lookup untuk participant share link. TIDAK butuh login.
 * Dipakai oleh halaman statis /s/<token>.
 *
 * Keamanan (sesuai approved architecture):
 * - service_role HANYA server-side (env), tidak pernah ke browser.
 * - Input: opaque token saja (body JSON). Tidak terima debt_id/user_id.
 * - Token di-hash (SHA-256) sebelum query; raw token tidak disimpan/di-log.
 * - Response: tepat 6 field sanitized. Tidak ada internal IDs.
 * - Invalid / revoked / deleted debt -> respons 404 GENERIK yang identik.
 * - Cache-Control: no-store. X-Robots-Tag: noindex.
 * - Tidak ada public SELECT ke debts; tidak ada anon EXECUTE grant baru.
 *
 * Rate limit: lightweight in-memory sliding window per instance.
 * Ini BUKAN proteksi serius (Vercel function ephemeral) — hanya menumpulkan
 * burst naive pada satu warm instance. Proteksi sebenarnya adalah entropy
 * token 256-bit. Tidak ada infrastructure baru.
 */

var crypto = require("crypto");

var SUPABASE_URL = (process.env.SUPABASE_URL || "https://adpteropqkbbdtpfwkhh.supabase.co").replace(/\/$/, "");
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Raw token: 32 bytes -> base64url tanpa padding = 43 char.
var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// --- Lightweight abuse guard (per-instance, best-effort) ---
var hits = [];
var WINDOW_MS = 60 * 1000;
var MAX_HITS_PER_MIN = 120;

function rateLimited() {
  var now = Date.now();
  while (hits.length > 0 && hits[0] <= now - WINDOW_MS) hits.shift();
  if (hits.length >= MAX_HITS_PER_MIN) return true;
  hits.push(now);
  return false;
}
// --- end guard ---

function sb(path) {
  return fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    },
  });
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Share URL adalah credential: jangan cache di mana pun.
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.end(JSON.stringify(obj));
}

// Satu respons generik untuk SEMUA kasus invalid (tidak ada oracle).
var NOT_FOUND = { error: "not_found" };

module.exports = async function (req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, { error: "method_not_allowed" });
    }
    if (rateLimited()) return send(res, 429, { error: "rate_limited" });
    if (!SERVICE_KEY) return send(res, 500, { error: "internal" });

    var token = req.body && req.body.token;
    if (typeof token !== "string" || !TOKEN_RE.test(token)) {
      return send(res, 404, NOT_FOUND);
    }

    var tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");

    // Query 1: share -> debt (harus ada; INNER JOIN). revoked_at harus NULL.
    // Tidak ada data lain yang diambil.
    var q1 =
      "split_bill_shares" +
      "?token_hash=eq." + encodeURIComponent(tokenHash) +
      "&revoked_at=is.null" +
      "&select=bill_name,participant_name,debts!inner(amount,status,due_date,user_id)" +
      "&limit=1";
    var r1 = await sb(q1);
    if (!r1.ok) return send(res, 500, { error: "internal" });
    var rows = await r1.json();
    if (!rows || rows.length === 0) return send(res, 404, NOT_FOUND);

    var s = rows[0];
    var d = s.debts || {};

    // Query 2: nama owner dari profiles (debts.user_id = profiles.id).
    // Hanya kolom name.
    var ownerName = "Teman";
    if (d.user_id) {
      var q2 =
        "profiles?id=eq." + encodeURIComponent(d.user_id) + "&select=name&limit=1";
      var r2 = await sb(q2);
      if (r2.ok) {
        var pr = await r2.json();
        if (pr && pr.length > 0 && pr[0].name) ownerName = pr[0].name;
      }
    }

    // Tepat 6 field. Tidak ada user_id, debt_id, internal IDs, token.
    return send(res, 200, {
      bill_name: s.bill_name,
      owner_name: ownerName,
      participant_name: s.participant_name,
      amount: d.amount,
      status: d.status,
      due_date: d.due_date || null,
    });
  } catch (e) {
    // Jangan bocorkan detail error database.
    return send(res, 500, { error: "internal" });
  }
};
