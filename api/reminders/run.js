/**
 * Nyangkut reminder cron — GET /api/reminders/run
 * Dijalankan Vercel Cron 1x sehari 03:00 UTC (= 10:00 WIB).
 *
 * BASIC (Free): H-1 (before_due_1d) + H+1 (overdue_1d) untuk semua catatan.
 * ADVANCED (Premium/Early Access): preset H-7, H-3, H-1, Hari H, H+1
 *   sesuai debts.reminder_offsets milik user. Config diabaikan untuk
 *   user non-premium (fallback ke basic).
 *
 * Alur per offset: hitung target -> cari debt jatuh tempo di target
 * yang effective-offsets-nya mencakup offset ini -> stage
 * (debt_id, type) -> kirim yang masih pending -> tandai sent_at.
 *
 * Anti-duplikat: UNIQUE(debt_id, type) di DB + insert ignore-duplicates.
 * Debt lunas sebelum kirim -> difilter, tidak dikirim.
 * Email SELALU ke pemilik akun, tidak pernah ke person_name.
 */

// Cron: "0 3 * * *" (03:00 UTC = 10:00 WIB).
// NOTE: tipe due_today yang tadinya sementara kini permanen sebagai
// preset "Hari H" untuk Advanced Reminder (Premium).

var SUPABASE_URL = (process.env.SUPABASE_URL || "https://adpteropqkbbdtpfwkhh.supabase.co").replace(/\/$/, "");
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
var CRON_SECRET = process.env.CRON_SECRET;
var RESEND_API_KEY = process.env.RESEND_API_KEY;
var FROM_EMAIL =
  process.env.REMINDER_FROM_EMAIL || "Nyangkut.id <nyangkut@cvmudah.id>";
var APP_URL = "https://www.nyangkut.id";

/** offset: hari relatif ke due_date. target = today - offset. */
var OFFSETS = [
  {
    offset: -7,
    type: "before_due_7d",
    label: "H-7",
    subject: "7 hari lagi ada yang jatuh tempo",
    subjectMulti: function (n) {
      return "7 hari lagi ada " + n + " catatan yang jatuh tempo";
    },
    intro: "7 hari lagi ada catatan yang jatuh tempo.",
  },
  {
    offset: -3,
    type: "before_due_3d",
    label: "H-3",
    subject: "3 hari lagi ada yang jatuh tempo",
    subjectMulti: function (n) {
      return "3 hari lagi ada " + n + " catatan yang jatuh tempo";
    },
    intro: "3 hari lagi ada catatan yang jatuh tempo.",
  },
  {
    offset: -1,
    type: "before_due_1d",
    label: "H-1",
    subject: "Besok ada uang yang perlu kamu ingat",
    subjectMulti: function (n) {
      return "Besok ada " + n + " catatan yang perlu kamu ingat";
    },
    intro: "Besok ada catatan yang jatuh tempo.",
  },
  {
    offset: 0,
    type: "due_today",
    label: "Hari H",
    subject: "Hari ini ada yang jatuh tempo",
    subjectMulti: function (n) {
      return "Hari ini ada " + n + " catatan yang jatuh tempo";
    },
    intro: "Hari ini ada catatan yang jatuh tempo.",
  },
  {
    offset: 1,
    type: "overdue_1d",
    label: "H+1",
    subject: "Eh, ada catatan yang belum lunas",
    subjectMulti: function (n) {
      return "Eh, ada " + n + " catatan yang belum lunas";
    },
    intro: "Kemarin ada catatan yang jatuh tempo dan belum lunas.",
  },
];

/** Offset dasar untuk Free / tanpa config. */
var BASIC_OFFSETS = [-1, 1];

function wibToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(dateStr, n) {
  var d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function rupiah(n) {
  return (
    "Rp" + Number(n || 0).toLocaleString("id-ID", { maximumFractionDigits: 0 })
  );
}

function fmtDate(iso) {
  if (!iso) return "-";
  var months = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
  ];
  var p = iso.split("-");
  return Number(p[2]) + " " + months[Number(p[1]) - 1] + " " + p[0];
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sb(path, params, init) {
  var url =
    SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path +
    (params ? "?" + params : "");
  return fetch(url, Object.assign(
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
      },
    },
    init || {}
  ));
}

function buildEmail(cfg, items) {
  var rows = items
    .map(function (it) {
      var dirTxt =
        it.direction === "receivable"
          ? "Uang yang harus balik ke kamu"
          : "Uang yang harus kamu bayar";
      return (
        '<tr><td style="padding:12px 0;border-bottom:1px solid #eef2ff;">' +
        '<div style="font-weight:700;color:#111827;">' + escapeHtml(it.person_name) + "</div>" +
        '<div style="font-size:13px;color:#6b7280;margin-top:2px;">' + dirTxt + "</div>" +
        '<div style="font-size:13px;color:#6b7280;">Jatuh tempo: ' + fmtDate(it.due_date) + "</div>" +
        '<div style="font-size:15px;font-weight:700;color:#4f46e5;margin-top:4px;">Sisa: ' + rupiah(it.sisa) + "</div>" +
        "</td></tr>"
      );
    })
    .join("");
  var subject = items.length === 1 ? cfg.subject : cfg.subjectMulti(items.length);
  var html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">' +
    '<div style="font-size:20px;font-weight:800;color:#4f46e5;margin-bottom:8px;">Nyangkut.id</div>' +
    "<p>" + escapeHtml(cfg.intro) + "</p>" +
    '<table style="width:100%;border-collapse:collapse;">' + rows + "</table>" +
    '<p style="margin-top:20px;"><a href="' + APP_URL + '/dashboard/" ' +
    'style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700;">' +
    "Lihat di Nyangkut.id</a></p>" +
    '<p style="font-size:12px;color:#9ca3af;">Biar nggak lupa uang kamu masih nyangkut di mana.</p>' +
    "</div>";
  return { subject: subject, html: html };
}

async function sendEmail(to, subject, html) {
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: to, subject: subject, html: html }),
  });
  if (!res.ok) {
    var t = await res.text().catch(function () { return ""; });
    throw new Error("Resend " + res.status + ": " + t.slice(0, 200));
  }
}

async function getUserEmails(userIds) {
  var map = {};
  await Promise.all(
    userIds.map(async function (uid) {
      try {
        var r = await fetch(
          SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/admin/users/" + uid,
          {
            headers: {
              apikey: SERVICE_KEY,
              Authorization: "Bearer " + SERVICE_KEY,
            },
          }
        );
        if (r.ok) {
          var u = await r.json();
          if (u.email) map[uid] = u.email;
        }
      } catch (e) { /* user gagal -> skip, user lain tetap jalan */ }
    })
  );
  return map;
}

/** Set user_id yang berhak atas Advanced Reminder. */
async function getPremiumUserIds() {
  var set = {};
  try {
    var r = await sb("profiles", "select=id,early_access,plan");
    if (!r.ok) return set;
    var rows = await r.json();
    rows.forEach(function (p) {
      if (p.early_access === true || p.plan === "premium") set[p.id] = true;
    });
  } catch (e) { /* gagal -> semua dianggap basic (fail closed) */ }
  return set;
}

/**
 * Effective offsets untuk satu debt.
 * - Premium + config terisi -> pakai config.
 * - Selain itu -> BASIC_OFFSETS (H-1 + H+1).
 */
function effectiveOffsets(debt, premiumSet) {
  if (
    premiumSet[debt.user_id] &&
    Array.isArray(debt.reminder_offsets) &&
    debt.reminder_offsets.length > 0
  ) {
    return debt.reminder_offsets;
  }
  return BASIC_OFFSETS;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }
  var auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== "Bearer " + CRON_SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_API_KEY) {
    res.status(500).json({ ok: false, error: "missing_env" });
    return;
  }

  var dryRun = req.query && (req.query.dry_run === "1" || req.query.dry_run === "true");
  var today = wibToday();
  var report = { ok: true, date: today, dry_run: dryRun, offsets: [] };

  try {
    // Probe: apakah kolom reminder_offsets sudah ada (migration 007)?
    // Kalau belum, cron tetap jalan dengan basic reminder (H-1 + H+1).
    var advancedReady = false;
    try {
      var probe = await sb("debts", "select=reminder_offsets&limit=1");
      advancedReady = probe.ok;
    } catch (e) { advancedReady = false; }
    report.advanced_ready = advancedReady;

    var activeOffsets = advancedReady
      ? OFFSETS
      : OFFSETS.filter(function (c) { return BASIC_OFFSETS.indexOf(c.offset) !== -1; });

    var premiumSet = await getPremiumUserIds();

    for (var i = 0; i < activeOffsets.length; i++) {
      var cfg = activeOffsets[i];
      var target = addDays(today, -cfg.offset);
      var offReport = {
        offset: cfg.offset,
        type: cfg.type,
        target: target,
        staged: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
      };

      // 1. Cari debt yang jatuh tempo tepat di target.
      var debtSel = advancedReady
        ? "select=id,user_id,direction,person_name,amount,paid_amount,status,due_date,reminder_offsets"
        : "select=id,user_id,direction,person_name,amount,paid_amount,status,due_date";
      var dr = await sb(
        "debts",
        debtSel + "&due_date=eq." + target + "&status=neq.paid"
      );
      if (!dr.ok) throw new Error("fetch debts " + dr.status);
      var debts = (await dr.json()).filter(function (d) {
        // Hanya stage jika offset ini termasuk effective offsets debt.
        return effectiveOffsets(d, premiumSet).indexOf(cfg.offset) !== -1;
      });

      // 2. Stage (debt_id, type) — duplikat diabaikan DB.
      if (debts.length > 0) {
        var rows = debts.map(function (d) {
          return {
            debt_id: d.id,
            user_id: d.user_id,
            type: cfg.type,
            scheduled_for: today,
          };
        });
        var sr = await sb("reminders", "", {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: "Bearer " + SERVICE_KEY,
            "Content-Type": "application/json",
            Prefer: "resolution=ignore-duplicates",
          },
          body: JSON.stringify(rows),
        });
        if (!sr.ok && sr.status !== 409) {
          throw new Error("stage " + cfg.type + " " + sr.status);
        }
        offReport.staged = debts.length;
      }

      // 3. Ambil semua pending untuk tipe ini (termasuk sisa kemarin yg gagal).
      var pr = await sb(
        "reminders",
        "select=id,debt_id,user_id" +
          "&type=eq." + cfg.type +
          "&sent_at=is.null"
      );
      if (!pr.ok) throw new Error("fetch pending " + pr.status);
      var pending = await pr.json();

      // 4. Filter yang masih relevan (belum lunas, sisa > 0).
      var sendable = [];
      if (pending.length > 0) {
        var ids = pending.map(function (p) { return p.debt_id; });
        var qr = await sb(
          "debts",
          "select=id,user_id,direction,person_name,amount,paid_amount,status,due_date" +
            "&id=in.(" + ids.join(",") + ")" +
            "&status=neq.paid"
        );
        if (!qr.ok) throw new Error("fetch debts detail " + qr.status);
        var debtMap = {};
        (await qr.json()).forEach(function (d) { debtMap[d.id] = d; });
        pending.forEach(function (p) {
          var d = debtMap[p.debt_id];
          if (!d) { offReport.skipped++; return; }
          var sisa = Number(d.amount) - Number(d.paid_amount);
          if (sisa <= 0) { offReport.skipped++; return; }
          sendable.push({
            reminder_id: p.id,
            user_id: p.user_id,
            person_name: d.person_name,
            direction: d.direction,
            due_date: d.due_date,
            sisa: sisa,
          });
        });
      }

      // 5. Group 1 email per user.
      var byUser = {};
      sendable.forEach(function (s) {
        (byUser[s.user_id] = byUser[s.user_id] || []).push(s);
      });
      var userIds = Object.keys(byUser);

      if (dryRun) {
        offReport.would_send = userIds.map(function (uid) {
          return { user_id: uid, items: byUser[uid].length };
        });
        report.offsets.push(offReport);
        continue;
      }

      var emails = await getUserEmails(userIds);
      var okIds = [];
      var failCount = 0;

      for (var u = 0; u < userIds.length; u++) {
        var uid = userIds[u];
        var items = byUser[uid];
        var to = emails[uid];
        if (!to) { failCount += items.length; continue; }
        try {
          var email = buildEmail(cfg, items);
          await sendEmail(to, email.subject, email.html);
          items.forEach(function (it) { okIds.push(it.reminder_id); });
          offReport.sent += items.length;
        } catch (e) {
          failCount += items.length;
        }
      }
      offReport.failed = failCount;

      // 6. Tandai terkirim (hanya yang sukses).
      if (okIds.length > 0) {
        await sb(
          "reminders",
          "id=in.(" + okIds.join(",") + ")",
          {
            method: "PATCH",
            body: JSON.stringify({ sent_at: new Date().toISOString() }),
          }
        );
      }

      report.offsets.push(offReport);
    }

    res.status(200).json(report);
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
