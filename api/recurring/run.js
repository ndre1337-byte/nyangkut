/* Nyangkut — Recurring Payment generator (cicilan/tagihan berulang).
 *
 * Dijalankan sebagai Vercel Cron 1x sehari (03:00 UTC = 10:00 WIB) via
 * GET /api/recurring/run dengan header Authorization: Bearer <CRON_SECRET>
 * (secret yang sama dengan /api/reminders/run).
 *
 * SERVER-SIDE ONLY. File ini tidak pernah dikirim ke browser.
 * Pakai service_role key (bypass RLS) — JANGAN taruh key ini di frontend,
 * JANGAN commit ke GitHub (via Vercel env vars saja).
 *
 * Konsep:
 *   recurring_rules = TEMPLATE. Setiap periode (YYYY-MM), generator membuat
 *   SATU debt aktual per rule aktif. Debt yang dibuat adalah transaksi biasa
 *   (paid_amount=0, status='unpaid' via trigger) — JANGAN PERNAH membuat
 *   payment otomatis.
 *
 * Idempotency:
 *   UNIQUE partial index debts(recurring_rule_id, period_key) ->
 *   cron yang jalan 2x tidak membuat duplikat. Cek SELECT dulu, lalu
 *   INSERT; race di level DB ditangkap sebagai unique violation.
 *
 * Periode target:
 *   max(periode berjalan, rule.start_period). Tidak ada backfill untuk
 *   periode yang terlewat (mis. cron mati sebulan) — hanya periode aktif.
 *
 * Free limit:
 *   Trigger check_free_note_limit berjalan untuk SEMUA insert termasuk
 *   service_role. Jika limit tercapai -> lewati rule dengan aman
 *   (rule tetap aktif, dicoba lagi besok/periode berikut). Jangan spam error.
 *
 * Premium gate:
 *   Hanya generate untuk user dengan early_access=true ATAU plan='premium'.
 *
 * Timezone: Asia/Jakarta (WIB). Tanggal 31 -> hari terakhir bulan itu.
 *
 * Query param opsional: ?dry_run=1 → jalankan semua logika TANPA insert.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://adpteropqkbbdtpfwkhh.supabase.co").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/* ---------- helpers ---------- */

function wibToday() {
  // YYYY-MM-DD di Asia/Jakarta
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function wibPeriod() {
  return wibToday().slice(0, 7); // "YYYY-MM"
}

function daysInMonth(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dueDateFor(period, dueDay) {
  // Tanggal 31 di Februari -> 28/29. Pakai hari terakhir bulan itu.
  const d = Math.min(dueDay, daysInMonth(period));
  return `${period}-${String(d).padStart(2, "0")}`;
}

function validRule(r) {
  if (!r || typeof r !== "object") return false;
  if (r.direction !== "receivable" && r.direction !== "payable") return false;
  if (!r.person_name || !String(r.person_name).trim()) return false;
  if (!(Number(r.amount) > 0)) return false;
  if (!(Number.isInteger(Number(r.due_day)) && Number(r.due_day) >= 1 && Number(r.due_day) <= 31)) return false;
  if (!PERIOD_RE.test(String(r.start_period || ""))) return false;
  if (!r.user_id) return false;
  return true;
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* abaikan */ }
  if (!r.ok) {
    const err = new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
    err.status = r.status;
    err.body = text;
    throw err;
  }
  return data;
}

/* ---------- handler ---------- */

module.exports = async (req, res) => {
  try {
    if (!CRON_SECRET) {
      return res.status(500).json({ ok: false, error: "CRON_SECRET belum dikonfigurasi" });
    }
    if ((req.headers.authorization || "") !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (!SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi" });
    }

    const dry = req.query.dry_run === "1" || req.query.dry_run === "true";
    const today = wibToday();
    const period = wibPeriod();
    const out = {
      ok: true, date_wib: today, period, dry_run: dry,
      rules_seen: 0, generated: [], skipped: [],
    };

    // 1. Ambil semua rule aktif.
    // Probe kolom reminder_offsets (migration 007); fallback tanpa kolom.
    let rules;
    let advancedReady = true;
    try {
      rules = await sb(
        "recurring_rules?select=id,user_id,direction,person_name,amount,note,due_day,start_period,reminder_offsets" +
        "&is_active=eq.true&order=created_at"
      ) || [];
    } catch (e) {
      advancedReady = false;
      rules = await sb(
        "recurring_rules?select=id,user_id,direction,person_name,amount,note,due_day,start_period" +
        "&is_active=eq.true&order=created_at"
      ) || [];
    }
    out.rules_seen = rules.length;
    out.advanced_ready = advancedReady;

    // Cache status premium per user (hindari N query profil).
    const premiumCache = {};
    async function hasPremium(userId) {
      if (premiumCache[userId] !== undefined) return premiumCache[userId];
      const prof = await sb(`profiles?select=early_access,plan&id=eq.${userId}`);
      const p = (prof || [])[0];
      const okAccess = !!p && (p.early_access === true || p.plan === "premium");
      premiumCache[userId] = okAccess;
      return okAccess;
    }

    for (const r of rules) {
      const ctx = { rule_id: r.id, person_name: r.person_name };
      try {
        if (!validRule(r)) {
          out.skipped.push({ ...ctx, reason: "malformed_rule" });
          continue;
        }
        if (!(await hasPremium(r.user_id))) {
          out.skipped.push({ ...ctx, reason: "no_premium_access" });
          continue;
        }

        // Periode target: tidak lebih tua dari start_period; tidak ada backfill.
        const target = period > r.start_period ? period : r.start_period;

        // 2. Sudah ada debt untuk (rule, periode)? -> skip (idempotent).
        const dup = await sb(
          `debts?select=id&recurring_rule_id=eq.${r.id}&period_key=eq.${target}&limit=1`
        ) || [];
        if (dup.length) {
          out.skipped.push({ ...ctx, reason: "already_generated", period: target });
          continue;
        }

        const dueDate = dueDateFor(target, Number(r.due_day));
        const payload = {
          user_id: r.user_id,
          direction: r.direction,
          person_name: r.person_name,
          amount: r.amount,
          note: r.note || null,
          due_date: dueDate,
          recurring_rule_id: r.id,
          period_key: target,
          // Wariskan config Advanced Reminder dari template ke transaksi.
          // NULL -> debt pakai basic reminder (H-1 + H+1).
          reminder_offsets:
            advancedReady &&
            Array.isArray(r.reminder_offsets) && r.reminder_offsets.length > 0
              ? r.reminder_offsets
              : null,
        };

        // Pre-migration: kolom belum ada -> buang dari payload agar insert tetap jalan.
        if (!advancedReady) delete payload.reminder_offsets;

        if (dry) {
          out.generated.push({ ...ctx, period: target, due_date: dueDate, dry_run: true });
          continue;
        }

        // 3. Insert. Trigger DB yang mengatur paid_amount=0, status='unpaid',
        //    dan free limit. Race antar eksekusi -> unique violation -> skip.
        try {
          const inserted = await sb("debts", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          const debtId = (inserted || [])[0] && (inserted[0].id || null);
          out.generated.push({ ...ctx, period: target, due_date: dueDate, debt_id: debtId });
        } catch (e) {
          const msg = String((e && e.message) || "") + " " + String((e && e.body) || "");
          if (msg.includes("FREE_LIMIT_REACHED")) {
            // Free user penuh: lewati dengan aman, coba lagi besok.
            out.skipped.push({ ...ctx, reason: "free_limit_reached", period: target });
          } else if (msg.includes("debts_recurring_unique") || e.status === 409) {
            // Race: eksekusi lain sudah membuat duluan.
            out.skipped.push({ ...ctx, reason: "already_generated", period: target });
          } else {
            throw e;
          }
        }
      } catch (e) {
        // Satu rule gagal TIDAK boleh menggagalkan rule lain.
        const msg = String((e && e.message) || e).slice(0, 200);
        console.error("[recurring] rule gagal:", r.id, msg);
        out.skipped.push({ ...ctx, reason: "error", error: msg });
      }
    }

    return res.status(200).json(out);
  } catch (err) {
    console.error("[recurring]", err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
};
