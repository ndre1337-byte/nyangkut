/**
 * Nyangkut Mingguan — weekly digest email.
 * GET /api/weekly-digest/run
 *
 * Dijalankan Vercel Cron 1x seminggu: Senin 01:00 UTC (= 08:00 WIB).
 * Auth: Authorization: Bearer <CRON_SECRET> (sama seperti /api/reminders/run).
 *
 * V1 rules:
 * - Hanya untuk user dengan >= 1 catatan AKTIF (status != 'paid').
 * - Free untuk semua (bukan Premium-gated).
 * - Email: ringkasan receivable/payable + maksimal 3 catatan prioritas.
 *
 * Idempotency (mengikuti pola tabel reminders):
 * - UNIQUE(user_id, week_key) di public.weekly_digests.
 * - sent_at diisi HANYA setelah Resend 2xx. Gagal -> tetap NULL -> retry
 *   di invocation berikutnya.
 * - Tambahan defense-in-depth: header Idempotency-Key deterministic
 *   "weekly-digest/<user_id>/<week_key>" ke Resend.
 *
 * SERVER-SIDE ONLY. service_role tidak pernah ke browser.
 * Per-user isolation: satu user gagal tidak menghentikan yang lain.
 *
 * Query param opsional: ?dry_run=1 -> hitung tanpa insert/kirim.
 */

var SUPABASE_URL = (process.env.SUPABASE_URL || "https://adpteropqkbbdtpfwkhh.supabase.co").replace(/\/$/, "");
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
var CRON_SECRET = process.env.CRON_SECRET;
var RESEND_API_KEY = process.env.RESEND_API_KEY;
var FROM_EMAIL =
  process.env.REMINDER_FROM_EMAIL || "Nyangkut.id <nyangkut@cvmudah.id>";
var APP_URL = "https://www.nyangkut.id";

/* ---------- timezone helpers (Asia/Jakarta, tanpa DST) ---------- */

function wibToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Senin--Minggu minggu berjalan (Asia/Jakarta). */
function wibWeek() {
  var shifted = new Date(Date.now() + 7 * 3600 * 1000);
  var dow = shifted.getUTCDay(); // 0=Min..6=Sab (dalam WIB)
  var back = (dow + 6) % 7; // hari sejak Senin
  var monday = new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() - back
    )
  );
  var sunday = new Date(monday.getTime() + 6 * 86400000);
  function fmt(d) {
    return d.toISOString().slice(0, 10);
  }
  return {
    today: shifted.toISOString().slice(0, 10),
    weekKey: fmt(monday),
    weekStart: fmt(monday),
    weekEnd: fmt(sunday),
  };
}

function addDays(dateStr, n) {
  var d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  // a - b dalam hari (keduanya YYYY-MM-DD)
  var da = new Date(a + "T00:00:00Z");
  var db = new Date(b + "T00:00:00Z");
  return Math.round((da - db) / 86400000);
}

/* ---------- formatting ---------- */

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

function weekdayId(iso) {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      weekday: "long",
      timeZone: "Asia/Jakarta",
    }).format(new Date(iso + "T12:00:00+07:00"));
  } catch (e) {
    return "";
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- supabase helpers ---------- */

function sb(path, params, init) {
  var url =
    SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path +
    (params ? "?" + params : "");
  return fetch(
    url,
    Object.assign(
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: "Bearer " + SERVICE_KEY,
          "Content-Type": "application/json",
        },
      },
      init || {}
    )
  );
}

async function sendEmail(to, subject, html, idemKey) {
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json",
      "Idempotency-Key": idemKey,
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: to,
      subject: subject,
      html: html,
    }),
  });
  if (!res.ok) {
    var t = await res.text().catch(function () {
      return "";
    });
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
      } catch (e) {
        /* user gagal -> skip, user lain tetap jalan */
      }
    })
  );
  return map;
}

/* ---------- digest logic ---------- */

function remaining(d) {
  return Number(d.amount) - Number(d.paid_amount);
}

/**
 * Kategori prioritas (deterministic):
 * 0 overdue, 1 hari ini, 2 minggu ini, 3 partial, 4 lainnya.
 */
function priorityCat(d, week) {
  if (d.due_date && d.due_date < week.today) return 0;
  if (d.due_date === week.today) return 1;
  if (
    d.due_date &&
    d.due_date >= week.weekStart &&
    d.due_date <= week.weekEnd
  )
    return 2;
  if (d.status === "partial") return 3;
  return 4;
}

function sortAttention(items, week) {
  return items.slice().sort(function (a, b) {
    var ca = priorityCat(a, week);
    var cb = priorityCat(b, week);
    if (ca !== cb) return ca - cb;
    // due_date terdekat dulu (null di belakang)
    var da = a.due_date || "9999-12-31";
    var db = b.due_date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    // sisa terbesar dulu
    var ra = remaining(a);
    var rb = remaining(b);
    if (ra !== rb) return rb - ra;
    // tiebreaker deterministik
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function itemLabel(d, week) {
  var sisa = rupiah(remaining(d));
  if (d.due_date && d.due_date < week.today) {
    var n = diffDays(week.today, d.due_date);
    return "Terlambat " + n + " hari · Sisa " + sisa;
  }
  if (d.due_date === week.today) return "Jatuh tempo hari ini · Sisa " + sisa;
  if (
    d.due_date &&
    d.due_date >= week.weekStart &&
    d.due_date <= week.weekEnd
  ) {
    var wd = weekdayId(d.due_date);
    return "Jatuh tempo " + wd + " · Sisa " + sisa;
  }
  if (d.status === "partial") return "Sebagian dibayar · Sisa " + sisa;
  if (d.due_date) return "Jatuh tempo " + fmtDate(d.due_date) + " · Sisa " + sisa;
  return "Sisa " + sisa;
}

function buildEmail(name, totals, attention, week) {
  var subject = "Nyangkut Mingguan — yang perlu kamu urus minggu ini";

  var sectionStyle =
    "background:#f8fafc;border:1px solid #eef2ff;border-radius:14px;padding:14px 16px;margin:12px 0;";
  var labelStyle =
    "font-size:13px;color:#6b7280;margin:0 0 4px;";
  var valueStyle =
    "font-size:22px;font-weight:800;color:#111827;margin:0;";

  var totalsHtml =
    '<div style="' + sectionStyle + '">' +
    '<p style="' + labelStyle + '">💰 Masih harus kamu terima</p>' +
    '<p style="' + valueStyle + '">' + rupiah(totals.receivable) + "</p>" +
    "</div>" +
    '<div style="' + sectionStyle + '">' +
    '<p style="' + labelStyle + '">💸 Masih harus kamu bayar</p>' +
    '<p style="' + valueStyle + '">' + rupiah(totals.payable) + "</p>" +
    "</div>";

  var attentionHtml;
  if (attention.items.length > 0) {
    var rows = attention.items
      .map(function (it) {
        var link = APP_URL + "/debt/?id=" + encodeURIComponent(it.d.id);
        return (
          '<tr><td style="padding:12px 0;border-bottom:1px solid #eef2ff;">' +
          '<a href="' + link + '" style="font-weight:700;color:#111827;text-decoration:none;">' +
          escapeHtml(it.d.person_name) +
          "</a>" +
          '<div style="font-size:13px;color:#6b7280;margin-top:2px;">' +
          escapeHtml(it.label) +
          "</div>" +
          "</td></tr>"
        );
      })
      .join("");
    attentionHtml =
      '<h2 style="font-size:16px;margin:20px 0 4px;">🔴 Perlu diperhatikan</h2>' +
      '<table style="width:100%;border-collapse:collapse;">' + rows + "</table>";
    if (attention.hasMore) {
      attentionHtml +=
        '<p style="margin:12px 0 0;"><a href="' + APP_URL + '/dashboard/#catatan" ' +
        'style="color:#4f46e5;font-weight:700;text-decoration:none;">Lihat semua catatan →</a></p>';
    }
  } else {
    attentionHtml =
      '<h2 style="font-size:16px;margin:20px 0 4px;">✨ Minggu ini cukup aman</h2>' +
      '<p style="color:#6b7280;font-size:14px;margin:0;">Tidak ada pembayaran yang terlambat atau jatuh tempo minggu ini.</p>';
  }

  var html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827;">' +
    '<div style="font-size:20px;font-weight:800;color:#4f46e5;margin-bottom:8px;">Nyangkut.id</div>' +
    '<h1 style="font-size:19px;margin:0 0 8px;">Nyangkut Mingguan 👋</h1>' +
    "<p>Hai, " + escapeHtml(name) + ".</p>" +
    "<p>Ini ringkasan singkat catatan yang masih perlu kamu urus minggu ini.</p>" +
    totalsHtml +
    attentionHtml +
    '<p style="margin-top:24px;"><a href="' + APP_URL + '/dashboard/" ' +
    'style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700;">' +
    "Buka Nyangkut →</a></p>" +
    '<p style="font-size:12px;color:#9ca3af;">Biar nggak lupa uang kamu masih nyangkut di mana.</p>' +
    "</div>";
  return { subject: subject, html: html };
}

/* ---------- handler ---------- */

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

  var dryRun =
    req.query && (req.query.dry_run === "1" || req.query.dry_run === "true");
  var week = wibWeek();
  var report = {
    ok: true,
    week_key: week.weekKey,
    date: week.today,
    dry_run: dryRun,
    users_eligible: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    // 1. Semua catatan aktif (satu query, group di JS — tanpa N+1).
    var dr = await sb(
      "debts",
      "select=id,user_id,direction,person_name,amount,paid_amount,status,due_date" +
        "&status=neq.paid&limit=10000"
    );
    if (!dr.ok) throw new Error("fetch debts " + dr.status);
    var allDebts = await dr.json();

    var byUser = {};
    allDebts.forEach(function (d) {
      if (remaining(d) <= 0) return; // defensive: hanya sisa > 0
      (byUser[d.user_id] = byUser[d.user_id] || []).push(d);
    });
    var userIds = Object.keys(byUser);
    report.users_eligible = userIds.length;

    if (userIds.length === 0) {
      res.status(200).json(report);
      return;
    }

    // 2. Nama user dari profiles.
    var nameMap = {};
    try {
      var pr = await sb("profiles", "select=id,name");
      if (pr.ok) {
        (await pr.json()).forEach(function (p) {
          nameMap[p.id] = p.name || "Teman";
        });
      }
    } catch (e) {
      /* nama fallback "Teman" */
    }

    // 3. Hitung digest per user.
    var digests = {};
    userIds.forEach(function (uid) {
      var debts = byUser[uid];
      var totals = { receivable: 0, payable: 0 };
      debts.forEach(function (d) {
        var r = remaining(d);
        if (d.direction === "receivable") totals.receivable += r;
        else totals.payable += r;
      });
      var ranked = sortAttention(debts, week);
      var top3 = ranked.slice(0, 3).map(function (d) {
        return { d: d, label: itemLabel(d, week) };
      });
      digests[uid] = {
        totals: totals,
        items: top3,
        hasMore: ranked.length > 3,
      };
    });

    if (dryRun) {
      report.would_send = userIds.map(function (uid) {
        return {
          user_id: uid,
          items: digests[uid].items.length,
          has_more: digests[uid].hasMore,
        };
      });
      res.status(200).json(report);
      return;
    }

    // 4. Stage (user_id, week_key) — duplikat diabaikan DB.
    var rows = userIds.map(function (uid) {
      return { user_id: uid, week_key: week.weekKey };
    });
    var sr = await sb("weekly_digests", "", {
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
      throw new Error("stage weekly_digests " + sr.status);
    }

    // 5. Ambil yang belum terkirim minggu ini.
    var ur = await sb(
      "weekly_digests",
      "select=id,user_id&week_key=eq." + week.weekKey + "&sent_at=is.null"
    );
    if (!ur.ok) throw new Error("fetch unsent " + ur.status);
    var unsent = await ur.json();

    // 6. Kirim per user (isolated: satu gagal tidak hentikan lainnya).
    var emails = await getUserEmails(unsent.map(function (u) { return u.user_id; }));

    for (var i = 0; i < unsent.length; i++) {
      var u = unsent[i];
      var dg = digests[u.user_id];
      if (!dg) {
        report.skipped++;
        continue;
      }
      var to = emails[u.user_id];
      if (!to) {
        report.failed++;
        continue;
      }
      try {
        var email = buildEmail(nameMap[u.user_id] || "Teman", dg.totals, dg, week);
        await sendEmail(
          to,
          email.subject,
          email.html,
          "weekly-digest/" + u.user_id + "/" + week.weekKey
        );
        // Tandai terkirim HANYA setelah Resend 2xx.
        await sb("weekly_digests", "id=eq." + u.id, {
          method: "PATCH",
          body: JSON.stringify({ sent_at: new Date().toISOString() }),
        });
        report.sent++;
      } catch (e) {
        report.failed++;
      }
    }

    res.status(200).json(report);
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
