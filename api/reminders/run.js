/* Nyangkut — Email Reminder MVP (H-1 & H+1).
 *
 * Dijalankan sebagai Vercel Cron 1x sehari (00:00 UTC = 07:00 WIB) via
 * GET /api/reminders/run dengan header Authorization: Bearer <CRON_SECRET>.
 *
 * SERVER-SIDE ONLY. File ini tidak pernah dikirim ke browser.
 * Pakai service_role key (bypass RLS) — JANGAN taruh key ini di frontend,
 * JANGAN commit ke GitHub (via Vercel env vars saja).
 *
 * Timezone: Asia/Jakarta (WIB), konsisten untuk H-1 / H+1 / current_date.
 * Tidak ada sistem timezone per-user di MVP.
 *
 * Anti-duplikat: UNIQUE(debt_id, type) di database + hanya kirim yang
 * sent_at IS NULL. sent_at diisi HANYA setelah Resend 2xx.
 *
 * Query param opsional: ?dry_run=1 → jalankan semua logika TANPA kirim
 * email dan TANPA menandai sent_at (untuk test).
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://adpteropqkbbdtpfwkhh.supabase.co").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.REMINDER_FROM_EMAIL || "Nyangkut <onboarding@resend.dev>";
const CRON_SECRET = process.env.CRON_SECRET;
const APP_URL = "https://nyangkut.vercel.app";

const TYPES = {
  before_due_1d: {
    dayOffset: 1,
    subject: "Besok ada uang yang perlu lo ingat",
    subjectMulti: (n) => `Besok ada ${n} catatan yang perlu lo ingat`,
    intro: "Besok ada catatan yang jatuh tempo.",
  },
  overdue_1d: {
    dayOffset: -1,
    subject: "Eh, ada catatan yang belum lunas",
    subjectMulti: (n) => `Eh, ada ${n} catatan yang belum lunas`,
    intro: "Ada catatan yang sudah lewat jatuh tempo dan masih belum lunas.",
  },
};

/* ---------- helpers ---------- */

function wibToday() {
  // YYYY-MM-DD di Asia/Jakarta
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID", { maximumFractionDigits: 0 });
}

const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function tglPanjang(iso) {
  const p = String(iso).slice(0, 10).split("-");
  return `${parseInt(p[2], 10)} ${BULAN[parseInt(p[1], 10) - 1]} ${p[0]}`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
  return data;
}

async function sbAdmin(path) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Auth admin ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function userEmails() {
  const map = {};
  let page = 1;
  while (page <= 10) {
    const res = await sbAdmin(`users?page=${page}&per_page=100`);
    const arr = Array.isArray(res) ? res : res.users || [];
    arr.forEach((u) => { if (u.id && u.email) map[u.id] = u.email; });
    if (arr.length < 100) break;
    page += 1;
  }
  return map;
}

async function sendEmail(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Resend ${r.status}: ${text.slice(0, 300)}`);
  return text;
}

/* ---------- template email (clean, mobile-friendly) ---------- */

function buildEmail(type, items) {
  const cfg = TYPES[type];
  const subject = items.length > 1 ? cfg.subjectMulti(items.length) : cfg.subject;
  const total = items.reduce((a, d) => a + d.sisa, 0);
  const link = items.length === 1 ? items[0].link : `${APP_URL}/dashboard/`;

  const rows = items.map((d) => `
      <div style="padding:12px 0;border-bottom:1px solid #eef2ff;">
        <div style="font-size:16px;font-weight:700;color:#111827;">${esc(d.person_name)}</div>
        <div style="font-size:20px;font-weight:800;color:#4f46e5;margin:4px 0;">${rupiah(d.sisa)}</div>
        <div style="font-size:13px;color:#64748b;">Jatuh tempo: ${tglPanjang(d.due_date)}</div>
        <div style="font-size:13px;color:#64748b;">Sisa: ${rupiah(d.sisa)}</div>
      </div>`).join("");

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f8fafc;">
  <div style="max-width:480px;margin:0 auto;padding:24px 20px;font-family:-apple-system,'Segoe UI',sans-serif;color:#111827;">
    <div style="font-size:20px;font-weight:800;color:#4f46e5;margin-bottom:12px;">Nyangkut</div>
    <p style="font-size:15px;line-height:1.6;">${cfg.intro}</p>
    ${rows}
    <p style="font-size:15px;margin-top:12px;">Total: <strong>${rupiah(total)}</strong></p>
    <a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:700;border-radius:12px;">Buka Nyangkut</a>
    <p style="font-size:12px;color:#94a3b8;line-height:1.6;border-top:1px solid #e2e8f0;padding-top:12px;">Email ini adalah pengingat pribadi dari Nyangkut. Nyangkut tidak menghubungi orang yang tercatat di transaksi lo.</p>
  </div></body></html>`;

  return { subject, html, link, total };
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
    if (!SERVICE_KEY || !RESEND_KEY) {
      return res.status(500).json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY belum dikonfigurasi" });
    }

    const dry = req.query.dry_run === "1" || req.query.dry_run === "true";
    const today = wibToday();
    const emails = userEmails();
    const out = { ok: true, date_wib: today, dry_run: dry, types: {}, emails: [] };
    const emailOf = await emails;

    for (const [type, cfg] of Object.entries(TYPES)) {
      const target = addDays(today, cfg.dayOffset);
      const stat = { target_date: target, candidates: 0, staged: 0, users_emailed: 0, skipped_no_email: 0 };
      out.types[type] = stat;

      // 1. Kandidat: due_date = target, belum lunas, sisa > 0.
      const debts = await sb(
        `debts?select=id,user_id,person_name,direction,amount,paid_amount,status,due_date` +
        `&due_date=eq.${target}&status=neq.paid&order=user_id`
      ) || [];
      const eligible = debts.filter((d) => Number(d.amount) - Number(d.paid_amount) > 0);
      stat.candidates = eligible.length;

      // 2. Stage reminder per debt. Konflik unique = sudah pernah → abaikan.
      for (const d of eligible) {
        try {
          await sb("reminders", {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates" },
            body: JSON.stringify({ debt_id: d.id, user_id: d.user_id, type, scheduled_for: today }),
          });
          stat.staged += 1;
        } catch (e) {
          // 409/unique violation → sudah ada, lewati
        }
      }

      // 3. Ambil semua yang BELUM terkirim (termasuk retry dari run sebelumnya),
      //    gabung data debt terkini.
      const pending = await sb(
        `reminders?select=id,debt_id,user_id,` +
        `debts(id,person_name,direction,amount,paid_amount,status,due_date)` +
        `&sent_at=is.null&type=eq.${type}`
      ) || [];

      // 4. Filter ulang saat kirim: debt harus masih belum lunas & sisa > 0.
      const sendable = pending.filter((r) => {
        const d = r.debts;
        return d && d.status !== "paid" && Number(d.amount) - Number(d.paid_amount) > 0;
      });

      // 5. Group per user → SATU email per user.
      const byUser = {};
      sendable.forEach((r) => {
        const d = r.debts;
        const sisa = Number(d.amount) - Number(d.paid_amount);
        (byUser[r.user_id] = byUser[r.user_id] || []).push({
          reminder_id: r.id,
          id: d.id, person_name: d.person_name, due_date: d.due_date,
          sisa, link: `${APP_URL}/debt/?id=${d.id}`,
        });
      });

      for (const [userId, items] of Object.entries(byUser)) {
        const to = emailOf[userId];
        if (!to) { stat.skipped_no_email += 1; continue; }
        const { subject, html, link, total } = buildEmail(type, items);
        const preview = {
          type, to, subject, total_rp: rupiah(total), link,
          debts: items.map((i) => ({ person_name: i.person_name, sisa_rp: rupiah(i.sisa), due: i.due_date })),
          sent: false,
        };
        if (!dry) {
          await sendEmail(to, subject, html); // throw kalau gagal → sent_at TETAP null
          const ids = items.map((i) => i.reminder_id).join(",");
          await sb(`reminders?id=in.(${ids})`, {
            method: "PATCH",
            body: JSON.stringify({ sent_at: new Date().toISOString() }),
          });
          preview.sent = true;
          stat.users_emailed += 1;
        }
        out.emails.push(preview);
      }
    }

    return res.status(200).json(out);
  } catch (err) {
    console.error("[reminders]", err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
};
