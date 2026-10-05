/* Nyangkut — Dashboard MVP.
 * Alur: AUTH (session supabase-js) -> SUPABASE (RLS) -> DATA -> DASHBOARD.
 * Semua query memakai client Supabase yang sudah terautentikasi; RLS di
 * database yang membatasi data hanya milik user yang login. Tidak ada
 * filter data user lain di sisi klien — server sudah memangkasnya.
 */
(() => {
  "use strict";

  var auth = window.NyangkutAuth;

  var stateEls = {};
  document.querySelectorAll("[data-state]").forEach(function (el) {
    stateEls[el.getAttribute("data-state")] = el;
  });
  var txList = document.querySelector("[data-tx-list]");
  var cards = {};
  document.querySelectorAll("[data-card]").forEach(function (el) {
    cards[el.getAttribute("data-card")] = el;
  });

  // Profile user untuk premium access check (diisi saat load).
  var userProfile = null;

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

  function rupiah(n) {
    var v = Number(n) || 0;
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    })
      .format(v)
      .replace(/\s/g, "");
  }

  function fmtDue(iso) {
    if (!iso) return "Tanpa tempo";
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return String(iso);
    return parseInt(p[2], 10) + " " + MONTHS[parseInt(p[1], 10) - 1];
  }

  function dayStr(d) {
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function showState(name) {
    Object.keys(stateEls).forEach(function (k) {
      stateEls[k].hidden = k !== name;
    });
    if (txList) txList.hidden = name !== "list";
    // Search/filter hanya relevan saat ada daftar (list penuh atau hasil kosong).
    if (typeof sfBar !== "undefined" && sfBar) {
      sfBar.hidden = !(name === "list" || name === "search-empty");
    }
  }

  function statusLabel(s) {
    if (s === "paid") return "Lunas";
    if (s === "partial") return "Partial";
    return "Belum bayar";
  }

  // ---------- Premium Foundation: access helper ----------
  // SATU-SATUNYA tempat logic premium access. Jangan sebar
  // `early_access || plan === 'premium'` ke file lain.
  // Nanti saat subscription system masuk, cukup ubah di sini.
  var FREE_ACTIVE_LIMIT = 10;
  function hasPremiumAccess(profile) {
    if (!profile) return false;
    if (profile.early_access === true) return true;
    if (profile.plan === "premium") return true;
    return false;
  }

  // ---- Advanced Reminder (Premium) ----
  // Flag true jika migration 007 sudah jalan (kolom reminder_offsets ada).
  // Diprobe sekali saat load; semua tulis/baca kolom ini dijaga flag ini
  // agar deploy aman walau migration belum dijalankan.
  var hasReminderCols = false;

  // Ambil offset yang dicentang di dalam satu scope modal/form.
  // Return array[int] atau null (null = basic reminder).
  function collectReminderOffsets(scopeEl) {
    if (!hasReminderCols || !hasPremiumAccess(userProfile) || !scopeEl) return null;
    var arr = [];
    scopeEl.querySelectorAll(".remind-pick input[type=checkbox]:checked").forEach(function (b) {
      var v = Number(b.value);
      if (!isNaN(v)) arr.push(v);
    });
    return arr.length > 0 ? arr : null;
  }

  function setReminderChecks(scopeEl, offsets) {
    if (!scopeEl) return;
    scopeEl.querySelectorAll(".remind-pick input[type=checkbox]").forEach(function (b) {
      b.checked = !!(offsets && offsets.indexOf(Number(b.value)) !== -1);
    });
  }

  function setupReminderUI() {
    var premium = hasPremiumAccess(userProfile);
    var eaBadge = premium && userProfile && userProfile.early_access === true
      ? "Termasuk akses awal 🎉 " : "";
    // Modal tambah catatan.
    var field = document.querySelector("[data-reminder-field]");
    if (field) {
      field.hidden = !hasReminderCols;
      if (hasReminderCols) {
        var freeView = field.querySelector("[data-reminder-free]");
        var premView = field.querySelector("[data-reminder-premium]");
        if (freeView) freeView.hidden = premium;
        if (premView) premView.hidden = !premium;
        var ea = field.querySelector("[data-reminder-ea]");
        if (ea) ea.textContent = eaBadge;
      }
    }
    // Modal catatan setiap bulan (sudah premium-gated).
    var rField = document.querySelector("[data-recur-reminder-field]");
    if (rField) {
      rField.hidden = !hasReminderCols;
      var rEa = rField.querySelector("[data-recur-reminder-ea]");
      if (rEa) rEa.textContent = eaBadge;
    }
  }
  function countActive(debts) {
    return debts.filter(function (d) { return d.status !== "paid"; }).length;
  }

  // ---------- Premium Navigation ----------
  // Menu sheet + Premium Hub dikonfigurasi berdasarkan hasPremiumAccess().
  // Free: teaser #premium. Premium/Early Access: hub #premium-hub.
  // Premium sections TIDAK auto-show di dashboard — hanya via view "premium".
  function setupPremiumNav() {
    var premium = hasPremiumAccess(userProfile);
    var teaser = document.getElementById("premium");
    var hub = document.getElementById("premium-hub");

    // Set which premium section is active (tapi tetap hidden sampai view premium dibuka).
    if (teaser) teaser.dataset.premiumActive = premium ? "false" : "true";
    if (hub) hub.dataset.premiumActive = premium ? "true" : "false";

    // Menu sheet (mobile): update link premium.
    var menuPremium = document.querySelector("[data-menu-premium]");
    if (menuPremium) {
      var titleEl = menuPremium.querySelector("[data-menu-premium-title]");
      var subEl = menuPremium.querySelector("[data-menu-premium-sub]");
      if (premium) {
        menuPremium.setAttribute("href", "#premium-hub");
        if (titleEl) titleEl.textContent = "Nyangkut Premium";
        if (subEl) subEl.textContent = "Aktif";
      } else {
        menuPremium.setAttribute("href", "#premium");
        if (titleEl) titleEl.textContent = "Premium";
        if (subEl) subEl.textContent = "Segera hadir";
      }
    }

    // Sidebar desktop: bedakan label premium.
    var sidePremium = document.querySelector(".side-premium");
    if (sidePremium) {
      var labelEl = sidePremium.querySelector(".segera-label");
      if (premium) {
        sidePremium.setAttribute("href", "#premium-hub");
        if (labelEl) {
          labelEl.textContent = "AKTIF";
          labelEl.classList.add("aktif-label");
        }
      } else {
        sidePremium.setAttribute("href", "#premium");
      }
    }

    // Initial view + hashchange listener.
    showView();
    window.addEventListener("hashchange", showView);
  }

  // ============ View Switching ============
  // Dashboard = overview (ringkasan, hook, kalender, terbaru).
  // Dedicated views: catatan, orang, berulang, premium.
  // Premium Hub TIDAK dirender di dashboard — hanya di view "premium".
  function showView() {
    var hash = (window.location.hash || "").replace("#", "");
    var view = "dashboard"; // default

    // Map hash ke view.
    if (hash === "catatan") view = "catatan";
    else if (hash === "orang") view = "orang";
    else if (hash === "berulang") view = "berulang";
    else if (hash === "premium" || hash === "premium-hub") view = "premium";
    else if (hash === "kalender") view = "dashboard"; // kalender ada di dashboard
    // Hash lain (termasuk kosong) = dashboard.

    // Hide semua views, show yang aktif.
    document.querySelectorAll("[data-view]").forEach(function (el) {
      var elView = el.getAttribute("data-view");
      if (elView === "premium") {
        // Premium: hanya tampilkan section yang aktif (teaser vs hub).
        var isActive = el.dataset.premiumActive === "true";
        el.hidden = !(view === "premium" && isActive);
      } else {
        el.hidden = (elView !== view);
      }
    });

    // Update nav active states.
    document.querySelectorAll("[data-nav]").forEach(function (nav) {
      var navView = nav.getAttribute("data-nav");
      // "kalender" nav tetap highlight saat di dashboard (karena kalender di dashboard).
      var isActive = (navView === view) || (navView === "kalender" && view === "dashboard" && hash === "kalender");
      nav.classList.toggle("is-active", isActive);
    });

    // Scroll behavior:
    // - Ganti view (non-dashboard): scroll ke atas.
    // - Hash "kalender": scroll ke section kalender di dashboard.
    // - Dashboard default: biarkan (tidak scroll paksa).
    if (view !== "dashboard") {
      window.scrollTo(0, 0);
    } else if (hash === "kalender") {
      var calEl = document.getElementById("kalender");
      if (calEl) calEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ============ Premium Hook (dashboard sales card) ============
  // Compact contextual card setelah summary. Priority:
  // 1. Near Free limit (8+/10 active) | 2. Banyak jatuh tempo | 3. Punya recurring | 4. Default
  function getPremiumHookType() {
    var premium = hasPremiumAccess(userProfile);
    if (premium) {
      // Bedakan Early Access vs plan=premium murni.
      if (userProfile && userProfile.early_access === true && userProfile.plan !== "premium") {
        return "early-access";
      }
      return "premium";
    }
    // Free user: cek kondisi kontekstual.
    var active = (allDebts || []).filter(function (d) {
      return d.status !== "paid" && (d.amount - (d.paid_amount || 0)) > 0;
    });
    if (active.length >= 8) return "near-limit";
    var withDue = active.filter(function (d) { return !!d.due_date; });
    if (withDue.length >= 3) return "many-due";
    var hasRecur = (allRules || []).some(function (r) { return r.is_active !== false; });
    if (hasRecur) return "has-recurring";
    return "default";
  }

  function renderPremiumHook() {
    var hook = document.querySelector("[data-premium-hook]");
    if (!hook) return;
    var inner = hook.querySelector("[data-hook-inner]");
    if (!inner) return;

    var type = getPremiumHookType();
    var html = "";

    if (type === "early-access") {
      html =
        '<div class="hook-main">' +
          '<span class="hook-crown" aria-hidden="true">👑</span>' +
          '<div class="hook-text">' +
            '<div class="hook-title-row"><strong>Nyangkut Premium</strong><span class="hook-badge">AKSES AWAL</span></div>' +
            '<small>Kamu sedang menikmati Nyangkut Premium. Semua fitur Premium tersedia selama masa Akses Awal.</small>' +
          '</div>' +
          '<a href="#premium-hub" class="hook-cta">Lihat Fitur →</a>' +
        '</div>';
    } else if (type === "premium") {
      html =
        '<div class="hook-main">' +
          '<span class="hook-crown" aria-hidden="true">👑</span>' +
          '<div class="hook-text">' +
            '<div class="hook-title-row"><strong>Nyangkut Premium</strong><span class="hook-badge hook-badge-active">AKTIF</span></div>' +
            '<small>Semua fitur Premium kamu di satu tempat.</small>' +
          '</div>' +
          '<a href="#premium-hub" class="hook-cta">Buka Premium →</a>' +
        '</div>';
    } else if (type === "near-limit") {
      html =
        '<div class="hook-main">' +
          '<span class="hook-crown" aria-hidden="true">👑</span>' +
          '<div class="hook-text">' +
            '<div class="hook-title-row"><strong>Catatan kamu mulai banyak</strong></div>' +
            '<small>Dengan Premium, kamu nggak perlu khawatir batas catatan aktif.</small>' +
          '</div>' +
          '<a href="#premium-hub" class="hook-cta">Lihat Premium →</a>' +
        '</div>';
    } else if (type === "many-due") {
      html =
        '<div class="hook-main">' +
          '<span class="hook-crown" aria-hidden="true">👑</span>' +
          '<div class="hook-text">' +
            '<div class="hook-title-row"><strong>Banyak yang harus dibayar?</strong></div>' +
            '<small>Atur pengingat H-7, H-3, H-1, Hari H sampai H+1 dengan Premium.</small>' +
          '</div>' +
          '<a href="#premium-hub" class="hook-cta">Lihat Premium →</a>' +
        '</div>';
    } else if (type === "has-recurring") {
      html =
        '<div class="hook-main">' +
          '<span class="hook-crown" aria-hidden="true">👑</span>' +
          '<div class="hook-text">' +
            '<div class="hook-title-row"><strong>Cicilan kamu sudah otomatis</strong></div>' +
            '<small>Sekarang atur pengingatnya lebih fleksibel dengan Premium.</small>' +
          '</div>' +
          '<a href="#premium-hub" class="hook-cta">Lihat Premium →</a>' +
        '</div>';
    } else {
      // Default: full sales card.
      html =
        '<div class="hook-main">' +
          '<span class="hook-crown" aria-hidden="true">👑</span>' +
          '<div class="hook-text">' +
            '<div class="hook-title-row"><strong>Nyangkut Premium</strong></div>' +
            '<small class="hook-tagline">Jangan cuma catat. Urus sampai beres.</small>' +
          '</div>' +
          '<a href="#premium-hub" class="hook-cta">Lihat Premium →</a>' +
        '</div>' +
        '<ul class="hook-benefits">' +
          '<li><span aria-hidden="true">🔔</span><span>Pengingat lebih lengkap<small>H-7 · H-3 · H-1 · Hari H · H+1</small></span></li>' +
          '<li><span aria-hidden="true">🔄</span><span>Catatan Setiap Bulan<small>Cicilan &amp; tagihan otomatis tiap bulan</small></span></li>' +
          '<li><span aria-hidden="true">∞</span><span>Catatan tanpa batas</span></li>' +
        '</ul>' +
        '<div class="hook-price">Rp19.900<span>/bulan</span> <em>atau Rp199.000/tahun</em></div>';
    }

    inner.innerHTML = html;
    hook.hidden = false;
  }

  // ============ Yang Perlu Diperhatikan ============
  // Priority: 1. Terlambat | 2. Jatuh tempo hari ini | 3. Jatuh tempo terdekat | 4. Partial
  // Max 3 items. Hanya dari allDebts (RLS-filtered). Paid & tanpa due_date excluded.
  // Timezone: pakai todayJakarta() agar konsisten dengan Calendar.
  function renderAttention() {
    var list = document.querySelector("[data-attn-list]");
    var empty = document.querySelector("[data-attn-empty]");
    var title = document.querySelector("[data-attn-title]");
    var sub = document.querySelector("[data-attn-sub]");
    if (!list) return;

    var today = todayJakarta();
    var active = (allDebts || []).filter(function (d) {
      return d.status !== "paid" && (d.amount - (d.paid_amount || 0)) > 0 && !!d.due_date;
    });

    // Hitung selisih hari dari due_date ke today (positif = terlambat).
    function daysOverdue(due) {
      var ms = Date.parse(today) - Date.parse(due);
      return Math.round(ms / 86400000);
    }

    // Kategorikan.
    var overdue = [];
    var dueToday = [];
    var upcoming = [];
    var partial = [];

    active.forEach(function (d) {
      var remaining = d.amount - (d.paid_amount || 0);
      if (d.due_date < today) {
        overdue.push({ debt: d, remaining: remaining, kind: "overdue", days: daysOverdue(d.due_date) });
      } else if (d.due_date === today) {
        dueToday.push({ debt: d, remaining: remaining, kind: "today" });
      } else if (d.status === "partial") {
        // Partial dengan due_date future: masuk kategori partial (tapi tetap sort by due_date).
        partial.push({ debt: d, remaining: remaining, kind: "partial" });
      } else {
        upcoming.push({ debt: d, remaining: remaining, kind: "soon" });
      }
    });

    // Sort: overdue by due_date asc (paling lama terlambat dulu), upcoming/partial by due_date asc.
    overdue.sort(function (a, b) { return a.debt.due_date < b.debt.due_date ? -1 : 1; });
    upcoming.sort(function (a, b) { return a.debt.due_date < b.debt.due_date ? -1 : 1; });
    partial.sort(function (a, b) { return a.debt.due_date < b.debt.due_date ? -1 : 1; });

    // Gabung dengan priority, max 3.
    var items = overdue.concat(dueToday, upcoming, partial).slice(0, 3);

    // Heading selalu statis.
    if (title) title.textContent = "🔔 Yang Perlu Diperhatikan";

    if (items.length === 0) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      if (sub) sub.hidden = true;
      // Update empty text via HTML sudah statis, tapi pastikan sub disembunyikan.
      return;
    }

    if (empty) empty.hidden = true;
    if (sub) {
      sub.textContent = "Beberapa catatan yang perlu kamu cek.";
      sub.hidden = false;
    }

    list.innerHTML = items.map(function (item) {
      var d = item.debt;
      var label = "";
      var dotCls = "";

      if (item.kind === "overdue") {
        label = "Terlambat " + item.days + " hari · Sisa " + rupiah(item.remaining);
        dotCls = "is-overdue";
      } else if (item.kind === "today") {
        // Jika partial, tampilkan sisa; jika belum bayar sama sekali, tampilkan amount.
        var amtToday = d.status === "partial" ? "Sisa " + rupiah(item.remaining) : rupiah(d.amount);
        label = "Jatuh tempo hari ini · " + amtToday;
        dotCls = "is-today";
      } else if (item.kind === "soon") {
        label = dueLine(d, today) + " · " + rupiah(item.remaining);
        dotCls = "is-soon";
      } else if (item.kind === "partial") {
        label = "Sebagian · Sisa " + rupiah(item.remaining);
        dotCls = "is-partial";
      }

      return (
        '<li><a class="attn-item" href="/debt/?id=' + encodeURIComponent(d.id) + '">' +
          '<span class="attn-dot ' + dotCls + '" aria-hidden="true"></span>' +
          '<span class="attn-text">' +
            '<strong>' + escapeHtml(d.person_name) + "</strong>" +
            '<small>' + escapeHtml(label) + "</small>" +
          "</span>" +
          '<span class="attn-chev" aria-hidden="true">›</span>' +
        "</a></li>"
      );
    }).join("");
  }

  // ============ Catatan Terbaru (compact, 3-5 items) ============
  function renderRecentNotes() {
    var list = document.querySelector("[data-recent-list]");
    var empty = document.querySelector("[data-recent-empty]");
    if (!list) return;

    var sorted = sortDebts(allDebts || []);
    var recent = sorted.slice(0, 5);

    if (recent.length === 0) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    var today = dayStr(new Date());
    list.innerHTML = recent.map(function (d) {
      var remaining = d.amount - (d.paid_amount || 0);
      var avCls = d.direction === "receivable" ? "in" : "out";
      var initial = (d.person_name || "?").trim().charAt(0).toUpperCase();
      var dueTxt = d.due_date ? dueLine(d, today) : "";
      var sisaTxt = d.status === "paid" ? "Lunas" : "Sisa " + rupiah(remaining);
      return (
        '<li><a class="tx-item' + (d.status === "paid" ? " is-paid" : "") +
        '" href="/debt/?id=' + encodeURIComponent(d.id) + '">' +
          '<span class="tx-avatar ' + avCls + '" aria-hidden="true">' + escapeHtml(initial) + "</span>" +
          '<span class="tx-body">' +
            '<span class="tx-top"><span class="tx-name">' + escapeHtml(d.person_name) + '</span><span class="tx-amount">' + rupiah(d.amount) + "</span></span>" +
            '<span class="tx-sub">' +
              (dueTxt ? '<span class="tx-due">' + escapeHtml(dueTxt) + "</span>" : "") +
              '<p class="tx-sisa">' + escapeHtml(sisaTxt) + "</p>" +
            "</span>" +
          "</span>" +
          '<span class="tx-chev" aria-hidden="true">›</span></a></li>'
      );
    }).join("");
  }

  // Hub: tombol Pengingat Lanjutan -> buka modal Tambah Catatan
  // (tempat user mengatur Advanced Reminder).
  document.querySelectorAll("[data-hub-reminder]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var addBtn = document.querySelector("[data-add]");
      if (addBtn) addBtn.click();
    });
  });

  // Urut: yang belum lunas dulu berdasarkan jatuh tempo terdekat
  // (tanpa jatuh tempo di belakang), yang sudah lunas paling bawah.
  function sortDebts(list) {
    return list.slice().sort(function (a, b) {
      var pa = a.status === "paid" ? 1 : 0;
      var pb = b.status === "paid" ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (a.due_date && b.due_date) {
        if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
      } else if (a.due_date) {
        return -1;
      } else if (b.due_date) {
        return 1;
      }
      return b.created_at < a.created_at ? -1 : 1; // fallback: terbaru dulu
    });
  }

  // ---------- Kalender Kewajiban ----------
  // Read-only: memakai data debts existing (RLS). Tidak menulis paid_amount/status.
  var MONTHS_FULL = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  var CAL_DOW = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

  var calGrid = document.querySelector("[data-cal-grid]");
  var calMonthEl = document.querySelector("[data-cal-month]");
  var calDetail = document.querySelector("[data-cal-detail]");
  var calDetailTitle = document.querySelector("[data-cal-detail-title]");
  var calDetailList = document.querySelector("[data-cal-detail-list]");
  var calEmpty = document.querySelector("[data-cal-empty]");

  var allDebts = [];
  var calYear = 0, calMonth = 0;
  var selectedDate = null; // "YYYY-MM-DD"

  // Hari ini dalam Asia/Jakarta, eksplisit (tidak mengandalkan TZ browser).
  function todayJakarta() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function fmtDateLong(iso) {
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return String(iso);
    return parseInt(p[2], 10) + " " + MONTHS_FULL[parseInt(p[1], 10) - 1] + " " + p[0];
  }

  function calDotClass(status) {
    if (status === "paid") return "dot-paid";
    if (status === "partial") return "dot-partial";
    return "dot-unpaid";
  }

  function calIsOverdue(d, today) {
    return !!d.due_date && String(d.due_date).slice(0, 10) < today && d.status !== "paid";
  }

  function debtsByDate() {
    var map = {};
    allDebts.forEach(function (d) {
      if (!d.due_date) return;
      var k = String(d.due_date).slice(0, 10);
      (map[k] = map[k] || []).push(d);
    });
    return map;
  }

  function calAriaLabel(iso, txs) {
    var label = fmtDateLong(iso);
    if (!txs.length) return label + ", tidak ada catatan";
    var c = { unpaid: 0, partial: 0, paid: 0 };
    txs.forEach(function (d) { c[d.status === "paid" ? "paid" : d.status === "partial" ? "partial" : "unpaid"]++; });
    var parts = [];
    if (c.unpaid) parts.push(c.unpaid + " belum dibayar");
    if (c.partial) parts.push(c.partial + " dibayar sebagian");
    if (c.paid) parts.push(c.paid + " lunas");
    return label + ", " + txs.length + " transaksi: " + parts.join(", ");
  }

  function renderCalendar() {
    if (!calGrid) return;
    var map = debtsByDate();
    var today = todayJakarta();
    calMonthEl.textContent = MONTHS_FULL[calMonth] + " " + calYear;

    var html = "";
    CAL_DOW.forEach(function (w) {
      html += '<div class="cal-dow" role="columnheader" aria-hidden="true">' + w + "</div>";
    });

    var first = new Date(calYear, calMonth, 1);
    var offset = (first.getDay() + 6) % 7; // Senin = 0
    var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    var daysInPrev = new Date(calYear, calMonth, 0).getDate();
    var cells = Math.ceil((offset + daysInMonth) / 7) * 7;

    var prio = { unpaid: 0, partial: 1, paid: 2 };
    for (var i = 0; i < cells; i++) {
      var dnum, m = calMonth, y = calYear, other = false;
      if (i < offset) {
        dnum = daysInPrev - offset + 1 + i; m = calMonth - 1; other = true;
        if (m < 0) { m = 11; y--; }
      } else if (i < offset + daysInMonth) {
        dnum = i - offset + 1;
      } else {
        dnum = i - offset - daysInMonth + 1; m = calMonth + 1; other = true;
        if (m > 11) { m = 0; y++; }
      }
      var iso = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(dnum).padStart(2, "0");
      var txs = (map[iso] || []).slice().sort(function (a, b) {
        return (prio[a.status] == null ? 0 : prio[a.status]) - (prio[b.status] == null ? 0 : prio[b.status]);
      });

      var dots = "";
      var maxDots = 3;
      txs.slice(0, maxDots).forEach(function (d) {
        var od = calIsOverdue(d, today) ? " is-overdue" : "";
        dots += '<span class="cal-dot ' + calDotClass(d.status) + od + '" aria-hidden="true"></span>';
      });
      if (txs.length > maxDots) {
        dots += '<span class="cal-more" aria-hidden="true">+' + (txs.length - maxDots) + "</span>";
      }

      var cls = "cal-cell";
      if (other) cls += " is-other";
      if (iso === today) cls += " is-today";
      if (iso === selectedDate) cls += " is-selected";
      if (txs.some(function (d) { return calIsOverdue(d, today); })) cls += " is-overdue";

      html += '<button type="button" role="gridcell" class="' + cls + '" data-cal-date="' + iso +
        '" aria-label="' + escapeHtml(calAriaLabel(iso, txs)) + '">' +
        '<span class="cal-date" aria-hidden="true">' + dnum + "</span>" +
        '<span class="cal-dots" aria-hidden="true">' + dots + "</span></button>";
    }
    calGrid.innerHTML = html;

    calGrid.querySelectorAll("[data-cal-date]").forEach(function (btn) {
      btn.addEventListener("click", function () { selectCalDate(btn.getAttribute("data-cal-date")); });
    });

    var hasAnyDue = allDebts.some(function (d) { return !!d.due_date; });
    if (calEmpty) calEmpty.hidden = hasAnyDue;
    if (selectedDate) renderCalDetail(selectedDate);
  }

  function selectCalDate(iso) {
    selectedDate = iso;
    renderCalendar();
    renderCalDetail(iso);
    if (calDetail && !calDetail.hidden && window.innerWidth < 640) {
      calDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function renderCalDetail(iso) {
    if (!calDetail) return;
    var today = todayJakarta();
    var txs = (debtsByDate()[iso] || []).slice();
    var prio = { unpaid: 0, partial: 1, paid: 2 };
    txs.sort(function (a, b) {
      return (prio[a.status] == null ? 0 : prio[a.status]) - (prio[b.status] == null ? 0 : prio[b.status]);
    });

    calDetailTitle.textContent = fmtDateLong(iso);
    if (!txs.length) {
      calDetailList.innerHTML = '<li><p class="cal-detail-empty">Belum ada catatan untuk tanggal ini.</p></li>';
    } else {
      calDetailList.innerHTML = txs.map(function (d) {
        var rem = Number(d.amount) - Number(d.paid_amount);
        var dirLabel = d.direction === "receivable" ? "Uang yang harus kamu tagih" : "Uang yang harus kamu bayar";
        var amountLine = d.status === "partial" ? "Sisa " + rupiah(rem) : rupiah(d.amount);
        var statusLine = escapeHtml(statusLabel(d.status));
        if (calIsOverdue(d, today)) statusLine += ' · <span class="overdue-tag">Terlambat</span>';
        return '<li><a class="cal-tx" href="/debt/?id=' + encodeURIComponent(d.id) + '">' +
          '<span class="cal-dot ' + calDotClass(d.status) + '" aria-hidden="true"></span>' +
          "<div><p class=\"cal-tx-dir\">" + dirLabel + "</p>" +
          '<p class="cal-tx-name">' + escapeHtml(d.person_name) + "</p>" +
          '<p class="cal-tx-amount">' + amountLine + "</p>" +
          '<p class="cal-tx-status">' + statusLine + "</p></div></a></li>";
      }).join("");
    }
    calDetail.hidden = false;
  }

  function hideCalDetail() {
    selectedDate = null;
    if (calDetail) calDetail.hidden = true;
    renderCalendar();
  }

  function shiftCalMonth(delta) {
    calMonth += delta;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    if (calMonth > 11) { calMonth = 0; calYear++; }
    selectedDate = null;
    if (calDetail) calDetail.hidden = true;
    renderCalendar();
  }

  function goCalToday() {
    var p = todayJakarta().split("-");
    calYear = parseInt(p[0], 10);
    calMonth = parseInt(p[1], 10) - 1;
    selectCalDate(todayJakarta());
  }

  function initCalendar() {
    if (!calGrid) return;
    var p = todayJakarta().split("-");
    calYear = parseInt(p[0], 10);
    calMonth = parseInt(p[1], 10) - 1;
    var prev = document.querySelector("[data-cal-prev]");
    var next = document.querySelector("[data-cal-next]");
    var todayBtn = document.querySelector("[data-cal-today]");
    var closeBtn = document.querySelector("[data-cal-detail-close]");
    if (prev) prev.addEventListener("click", function () { shiftCalMonth(-1); });
    if (next) next.addEventListener("click", function () { shiftCalMonth(1); });
    if (todayBtn) todayBtn.addEventListener("click", goCalToday);
    if (closeBtn) closeBtn.addEventListener("click", hideCalDetail);
    renderCalendar();
  }

  function renderDebts(debts) {
    var today = dayStr(new Date());
    var now = new Date();
    var dow = (now.getDay() + 6) % 7; // Senin = 0
    var weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dow);
    var weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    var ws = dayStr(weekStart);
    var we = dayStr(weekEnd);

    function remaining(d) {
      return Number(d.amount) - Number(d.paid_amount);
    }
    function outstanding(d) {
      return d.status !== "paid";
    }

    var sum = function (list) {
      return list.reduce(function (acc, d) { return acc + remaining(d); }, 0);
    };

    var receivable = debts.filter(function (d) { return d.direction === "receivable" && outstanding(d); });
    var payable = debts.filter(function (d) { return d.direction === "payable" && outstanding(d); });
    var overdue = debts.filter(function (d) {
      return d.due_date && d.due_date < today && outstanding(d);
    });
    var dueWeek = debts.filter(function (d) {
      return d.due_date && d.due_date >= ws && d.due_date <= we && outstanding(d);
    });

    cards.receivable.textContent = rupiah(sum(receivable));
    cards.payable.textContent = rupiah(sum(payable));
    var overdueSum = sum(overdue);
    cards.overdue.textContent = rupiah(overdueSum);
    // Red state hanya jika ada yang terlambat; Rp0 = neutral.
    cards.overdue.classList.toggle("card-value-danger", overdueSum > 0);
    cards.dueWeek.textContent = rupiah(sum(dueWeek));

    if (!debts.length) {
      showState("empty");
      return;
    }

    updateLimitHint(debts);
    renderTxArea(); // list penuh, atau hasil filter jika search/filter aktif
  }

  // Due badge ala "TODAY" / "2 DAYS": Terlambat, Hari ini, Besok, X hari, Lunas.
  function dueBadge(d, today) {
    if (d.status === "paid") return '<span class="due-badge due-paid">Lunas</span>';
    if (!d.due_date) return "";
    if (d.due_date < today) return '<span class="due-badge due-overdue">Terlambat</span>';
    if (d.due_date === today) return '<span class="due-badge due-today">Hari ini</span>';
    var tmr = new Date(today + "T00:00:00");
    tmr.setDate(tmr.getDate() + 1);
    if (d.due_date === dayStr(tmr)) return '<span class="due-badge due-soon">Besok</span>';
    var diff = Math.round((new Date(d.due_date + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
    if (diff > 0 && diff <= 7) return '<span class="due-badge due-soon">' + diff + " hari</span>";
    return "";
  }

  function dueLine(d, today) {
    if (!d.due_date) return "Tanpa jatuh tempo";
    if (d.due_date < today && d.status !== "paid") return "Terlambat · jatuh tempo " + fmtDue(d.due_date);
    return "Jatuh tempo " + fmtDue(d.due_date);
  }

  // Satu builder item list — dipakai list penuh maupun hasil filter.
  // Struktur HTML identik dengan versi lama (hanya diubah dari createElement ke string).
  function txItemHTML(d, today) {
    var rem = Number(d.amount) - Number(d.paid_amount);
    var initial = (String(d.person_name || "?").trim().charAt(0) || "?").toUpperCase();
    var avCls = d.direction === "receivable" ? "av-receivable" : "av-payable";
    var dirChip = d.direction === "receivable"
      ? '<span class="chip chip-dir-receivable">Nyangkut</span>'
      : '<span class="chip chip-dir-payable">Utang kamu</span>';
    var partialChip = d.status === "partial"
      ? '<span class="chip chip-status-partial">Dibayar sebagian</span>' : "";

    var sisaLine = d.status === "paid"
      ? '<p class="tx-sisa is-paid">Lunas</p>'
      : '<p class="tx-sisa">Sisa ' + rupiah(rem) + "</p>";

    var noteLine = d.note ? '<p class="tx-note">“' + escapeHtml(d.note) + "”</p>" : "";

    return '<a class="tx-item' + (d.status === "paid" ? " is-paid" : "") +
      '" href="/debt/?id=' + encodeURIComponent(d.id) + '">' +
      '<span class="tx-avatar ' + avCls + '" aria-hidden="true">' + escapeHtml(initial) + "</span>" +
      '<span class="tx-body">' +
        '<span class="tx-top"><span class="tx-name">' + escapeHtml(d.person_name) + '</span><span class="tx-amount">' + rupiah(d.amount) + "</span></span>" +
        '<span class="tx-sub"><span class="tx-due">' + escapeHtml(dueLine(d, today)) + "</span>" + sisaLine + "</span>" +
        '<span class="tx-badges">' + dueBadge(d, today) + dirChip + partialChip + "</span>" +
        noteLine +
      "</span>" +
      '<span class="tx-chev" aria-hidden="true">›</span></a>';
  }

  // Tampilkan info limit untuk Free user: subtle di 8/10, jelas di 9/10 dan 10/10.
  // Premium/Early Access tidak melihat hint ini.
  function updateLimitHint(debts) {
  var hint = document.querySelector("[data-limit-hint]");
  if (!hint) return;
  hint.hidden = true;
  hint.classList.remove("is-limit");
  if (hasPremiumAccess(userProfile)) return;
  var active = countActive(debts);
  if (active < 8) return;
  hint.hidden = false;
  if (active >= FREE_ACTIVE_LIMIT) {
    hint.classList.add("is-limit");
    hint.innerHTML = "Kamu sudah mencapai batas 10 catatan aktif di paket Free. " +
      '<a href="#premium">Upgrade ke Premium</a>';
  } else if (active >= 9) {
    hint.textContent = active + " dari 10 catatan aktif. Catatan yang lunas tidak dihitung.";
  } else {
    hint.textContent = active + " dari 10 catatan aktif di paket Free.";
  }
  }

  function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  }

  function waitForClient(tries) {
  return new Promise(function (resolve) {
    (function poll(n) {
      if (window.NyangkutDB) return resolve(window.NyangkutDB);
      if (n <= 0) return resolve(null);
      setTimeout(function () { poll(n - 1); }, 100);
    })(tries == null ? 50 : tries);
  });
  }

  async function load() {
  showState("loading");
  try {
    var session = await auth.getSession();
    if (!session || !session.user) {
      window.location.replace("/login/");
      return;
    }
    var client = await waitForClient();
    if (!client) throw new Error("Supabase client tidak tersedia.");

    // Nama + status akses dari tabel profiles (fallback ke metadata auth).
    var name = session.user.name || "Teman";
    var isEarlyAccess = true; // default aman: anggap early access kalau kolom belum ada
    try {
      var prof = await client.from("profiles").select("name, early_access, plan").single();
      if (prof.data) {
        userProfile = prof.data;
        if (prof.data.name) name = prof.data.name;
        if (typeof prof.data.early_access === "boolean") isEarlyAccess = prof.data.early_access;
      }
    } catch (e) {
      // Kolom plan mungkin belum ada (migration 004 belum jalan) -> coba tanpa plan.
      try {
        var prof2 = await client.from("profiles").select("name, early_access").single();
        if (prof2.data) {
          userProfile = prof2.data;
          if (prof2.data.name) name = prof2.data.name;
          if (typeof prof2.data.early_access === "boolean") isEarlyAccess = prof2.data.early_access;
        }
      } catch (e2) { /* pakai fallback */ }
    }
    var nameEl = document.querySelector("[data-user-name]");
    if (nameEl) nameEl.textContent = name;
    var badgeEl = document.querySelector("[data-early-badge]");
    if (badgeEl) badgeEl.hidden = !isEarlyAccess;
    // Avatar inisial + label tanggal hari ini di header.
    var avEl = document.querySelector("[data-user-avatar]");
    if (avEl) avEl.textContent = (name.trim().charAt(0) || "?").toUpperCase();
    var dateEl = document.querySelector("[data-today-label]");
    if (dateEl) {
      try {
        dateEl.textContent = new Date().toLocaleDateString("id-ID", {
          weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta"
        });
      } catch (e) { /* abaikan */ }
    }

    // Probe kolom Advanced Reminder (migration 007). Gagal -> fitur disembunyikan,
    // semua flow tetap jalan dengan basic reminder.
    try {
      var remProbe = await client.from("debts").select("reminder_offsets").limit(1);
      hasReminderCols = !remProbe.error;
    } catch (e) { hasReminderCols = false; }
    setupReminderUI();
    setupPremiumNav();

    // RLS otomatis membatasi hanya baris milik user ini.
    var res = await client
      .from("debts")
      .select("id, direction, person_name, amount, paid_amount, status, note, due_date, created_at, recurring_rule_id, period_key")
      .order("created_at", { ascending: false });
    if (res.error) throw res.error;

    allDebts = res.data || [];
    renderDebts(sortDebts(allDebts));
    renderPeople();
    renderCalendar();
    renderPremiumHook();
    renderAttention();
    renderRecentNotes();
    loadRecurring();
  } catch (err) {
    console.error("[Nyangkut] dashboard gagal memuat:", err);
    showState("error");
  }
  }

  // ---------- Search + Filter (client-side dari allDebts, RLS-safe) ----------
  // Tidak ada query baru: semua filtering dilakukan terhadap data yang sudah
  // di-fetch sekali di load() (data milik user ini saja, RLS di server).
  // Urutan existing dipertahankan: hasil filter selalu lewat sortDebts().
  var sfBar = document.querySelector("[data-sf-bar]");
  var sfInput = document.querySelector("[data-sf-q]");
  var sfClear = document.querySelector("[data-sf-clear]");
  var sfMeta = document.querySelector("[data-sf-meta]");
  var sfCount = document.querySelector("[data-sf-count]");
  var sfState = { q: "", jenis: "all", status: "all", due: "all" };
  var sfTimer = null;

  var SF_PRESETS = {
    all:        { jenis: "all",        status: "all",    due: "all" },
    receivable: { jenis: "receivable", status: "all",    due: "all" },
    payable:    { jenis: "payable",    status: "all",    due: "all" },
    unpaid:     { jenis: "all",        status: "unpaid", due: "all" },
    overdue:    { jenis: "all",        status: "all",    due: "overdue" }
  };

  function sfIsActive() {
    return !!(sfState.q || sfState.jenis !== "all" || sfState.status !== "all" || sfState.due !== "all");
  }

  function sfWeekRange() {
    var now = new Date();
    var dow = (now.getDay() + 6) % 7; // Senin = 0
    var ws = new Date(now); ws.setDate(now.getDate() - dow);
    var we = new Date(ws); we.setDate(ws.getDate() + 6);
    return [dayStr(ws), dayStr(we)];
  }

  function sfMatch(d) {
    var s = sfState;
    // Jenis: istilah natural -> direction DB.
    if (s.jenis !== "all" && d.direction !== s.jenis) return false;
    // Status: "Belum lunas" = unpaid ATAU partial (belum dibayar penuh).
    if (s.status === "unpaid" && d.status === "paid") return false;
    if (s.status === "partial" && d.status !== "partial") return false;
    if (s.status === "paid" && d.status !== "paid") return false;
    // Jatuh tempo.
    var today = dayStr(new Date());
    if (s.due === "overdue") {
      if (!(d.due_date && d.due_date < today && d.status !== "paid")) return false;
    } else if (s.due === "week") {
      var r = sfWeekRange();
      if (!(d.due_date && d.due_date >= r[0] && d.due_date <= r[1] && d.status !== "paid")) return false;
    } else if (s.due === "nodue") {
      if (d.due_date) return false;
    }
    // Search: case-insensitive di person_name + note (provider tersimpan di person_name).
    if (s.q) {
      var hay = (String(d.person_name || "") + " " + String(d.note || "")).toLowerCase();
      if (hay.indexOf(s.q.toLowerCase()) === -1) return false;
    }
    return true;
  }

  // Render area list: penuh (tanpa filter) atau hasil filter. Dipanggil dari renderDebts.
  function renderTxArea() {
    var today = dayStr(new Date());
    if (!sfIsActive()) {
      txList.innerHTML = sortDebts(allDebts).map(function (d) { return txItemHTML(d, today); }).join("");
      showState("list");
      if (sfMeta) sfMeta.hidden = true;
      return;
    }
    var list = sortDebts(allDebts.filter(sfMatch));
    txList.innerHTML = list.map(function (d) { return txItemHTML(d, today); }).join("");
    showState(list.length ? "list" : "search-empty");
    if (sfMeta) {
      sfMeta.hidden = false;
      if (sfCount) sfCount.textContent = "Menampilkan " + list.length + " dari " + allDebts.length + " catatan";
    }
  }

  function syncSfUI() {
    document.querySelectorAll("[data-sf-quick]").forEach(function (b) {
      var p = SF_PRESETS[b.getAttribute("data-sf-quick")];
      var match = p && p.jenis === sfState.jenis && p.status === sfState.status && p.due === sfState.due;
      b.classList.toggle("is-active", !!match);
    });
    ["jenis", "status", "due"].forEach(function (g) {
      document.querySelectorAll('[data-sf-group="' + g + '"] [data-sf-val]').forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-sf-val") === sfState[g]);
      });
    });
    // Tombol "Filter" menyala saat ada filter aktif di luar preset cepat.
    var filterBtn = document.querySelector("[data-sf-open]");
    if (filterBtn) filterBtn.classList.toggle("is-active", sfIsActive());
    if (sfClear && sfInput) sfClear.hidden = !sfInput.value;
  }

  function sfReset() {
    sfState = { q: "", jenis: "all", status: "all", due: "all" };
    if (sfInput) sfInput.value = "";
    syncSfUI();
    renderTxArea();
  }

  if (sfInput) {
    sfInput.addEventListener("input", function () {
      if (sfClear) sfClear.hidden = !sfInput.value;
      clearTimeout(sfTimer);
      // Debounce 150ms: filtering murni client-side, tanpa query baru.
      sfTimer = setTimeout(function () {
        sfState.q = sfInput.value.trim();
        syncSfUI();
        renderTxArea();
      }, 150);
    });
  }
  if (sfClear && sfInput) {
    sfClear.addEventListener("click", function () {
      sfInput.value = "";
      sfState.q = "";
      syncSfUI();
      renderTxArea();
      sfInput.focus();
    });
  }
  document.querySelectorAll("[data-sf-quick]").forEach(function (b) {
    b.addEventListener("click", function () {
      var p = SF_PRESETS[b.getAttribute("data-sf-quick")];
      if (!p) return;
      sfState.jenis = p.jenis;
      sfState.status = p.status;
      sfState.due = p.due;
      syncSfUI();
      renderTxArea();
    });
  });
  document.querySelectorAll('[data-sf-group] [data-sf-val]').forEach(function (b) {
    b.addEventListener("click", function () {
      var group = b.closest("[data-sf-group]").getAttribute("data-sf-group");
      sfState[group] = b.getAttribute("data-sf-val");
      syncSfUI();
      renderTxArea();
    });
  });
  document.querySelectorAll("[data-sf-reset]").forEach(function (b) {
    b.addEventListener("click", sfReset);
  });

  // ---------- Filter sheet (bottom sheet, pola sama seperti more-sheet) ----------
  var filterSheet = document.querySelector("[data-filter-sheet]");
  var filterBackdrop = document.querySelector("[data-filter-backdrop]");

  function openFilter() {
    if (!filterSheet || !filterBackdrop) return;
    filterSheet.hidden = false;
    filterBackdrop.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        filterSheet.classList.add("show");
        filterBackdrop.classList.add("show");
      });
    });
    document.body.style.overflow = "hidden";
  }

  function closeFilter() {
    if (!filterSheet || !filterBackdrop || filterSheet.hidden) return;
    filterSheet.classList.remove("show");
    filterBackdrop.classList.remove("show");
    document.body.style.overflow = "";
    setTimeout(function () {
      filterSheet.hidden = true;
      filterBackdrop.hidden = true;
    }, 250);
  }

  document.querySelectorAll("[data-sf-open]").forEach(function (b) {
    b.addEventListener("click", openFilter);
  });
  document.querySelectorAll("[data-filter-close]").forEach(function (b) {
    b.addEventListener("click", closeFilter);
  });
  if (filterBackdrop) filterBackdrop.addEventListener("click", closeFilter);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeFilter();
  });

  // ---------- Recurring rules (Catatan Setiap Bulan — Premium) ----------
  // Template jadwal bulanan. Generation dilakukan server-side via cron;
  // frontend hanya CRUD rule milik user (RLS). Edit rule TIDAK mengubah
  // debt lama yang sudah dibuat.
  var recurList = document.querySelector("[data-recur-list]");
  var recurEmpty = document.querySelector("[data-recur-empty]");
  var recurTeaser = document.querySelector("[data-recur-teaser]");
  var recurSub = document.querySelector("[data-recur-sub]");
  var allRules = [];

  var RECUR_MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

  function recurPeriodLabel(period) {
    // "2026-11" -> "November 2026"
    var p = String(period || "").split("-");
    if (p.length !== 2) return String(period || "");
    return RECUR_MONTHS[parseInt(p[1], 10) - 1] + " " + p[0];
  }

  function computeStartPeriod(dueDay) {
    // Catatan setiap bulan baru: jika tanggal sudah lewat bulan ini, mulai bulan depan
    // (biar tidak langsung membuat debt yang overdue).
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth() + 1;
    if (dueDay <= now.getDate()) {
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return y + "-" + String(m).padStart(2, "0");
  }

  async function loadRecurring() {
    var hasAccess = hasPremiumAccess(userProfile);
    if (recurTeaser) recurTeaser.hidden = hasAccess;
    document.querySelectorAll("[data-recur-add]").forEach(function (b) {
      b.hidden = !hasAccess;
    });
    if (recurSub && userProfile && userProfile.early_access === true) {
      recurSub.textContent = "Cicilan & tagihan yang muncul otomatis tiap bulan. Klik catatan untuk melihat transaksi bulan ini. Termasuk akses awal 🎉";
    }
    if (!hasAccess) {
      allRules = [];
      renderRecurring();
      return;
    }
    try {
      var client = await waitForClient();
      if (!client) throw new Error("no-client");
      // reminder_offsets hanya jika migration 007 sudah jalan.
      var ruleSel = "id, direction, person_name, amount, note, due_day, is_active, start_period, created_at";
      if (hasReminderCols) ruleSel += ", reminder_offsets";
      var res = await client.from("recurring_rules")
        .select(ruleSel)
        .order("created_at", { ascending: false });
      if (res.error) throw res.error;
      allRules = res.data || [];
    } catch (e) {
      // Tabel belum ada (migration 006 belum dijalankan) -> jangan crash.
      console.warn("[Nyangkut] recurring load gagal:", e);
      allRules = [];
    }
    renderRecurring();
    // Re-render hook: kondisi "punya recurring" baru diketahui setelah allRules terisi.
    renderPremiumHook();
  }

  // Peta rule -> DEBT periode berjalan (Asia/Jakarta, sama seperti generator).
  // Dibangun ulang setiap renderRecurring() dari allDebts.
  // Dipakai untuk navigasi card DAN status pembayaran.
  var recurDebtMap = {};

  function recurCurrentPeriod() {
    return todayJakarta().slice(0, 7); // "YYYY-MM"
  }

  function buildRecurDebtMap() {
    recurDebtMap = {};
    var period = recurCurrentPeriod();
    allDebts.forEach(function (d) {
      if (d.recurring_rule_id && d.period_key === period) {
        recurDebtMap[d.recurring_rule_id] = d;
      }
    });
  }

  function openRecurDebt(ruleId) {
    var debt = recurDebtMap[ruleId];
    if (debt) {
      window.location.href = "/debt/?id=" + encodeURIComponent(debt.id);
    } else {
      // Jangan membuat debt baru hanya karena user mengklik card.
      toast("Transaksi bulan ini belum dibuat.");
    }
  }

  // Status pembayaran transaksi bulan berjalan.
  // Nominal recurring (RpX / bulan) TIDAK PERNAH diubah di sini.
  function recurPayStatus(r) {
    var d = recurDebtMap[r.id];
    if (!d) {
      return '<p class="recur-paystatus is-none">Belum dibuat</p>';
    }
    var today = dayStr(new Date());
    var overdue = !!(d.due_date && d.due_date < today && d.status !== "paid");
    var lateTag = overdue ? ' · <span class="recur-late">Terlambat</span>' : "";
    if (d.status === "paid") {
      return '<p class="recur-paystatus is-paid">Lunas ✓</p>';
    }
    if (d.status === "partial") {
      var rem = Number(d.amount) - Number(d.paid_amount);
      return '<p class="recur-paystatus is-partial">Sisa ' + rupiah(rem) + lateTag + "</p>";
    }
    return '<p class="recur-paystatus is-unpaid">Belum dibayar' + lateTag + "</p>";
  }

  function recurCardHTML(r) {
    var dirLabel = r.direction === "receivable" ? "Uang masuk" : "Utang kamu";
    var statusCls = r.is_active ? "is-active" : "is-inactive";
    var statusTxt = r.is_active ? "● Aktif" : "○ Nonaktif";
    var toggleTxt = r.is_active ? "Nonaktifkan" : "Aktifkan";
    var noteLine = r.note ? '<p class="recur-schedule">“' + escapeHtml(r.note) + "”</p>" : "";
    return '<li class="recur-card ' + (r.is_active ? "" : "is-inactive") + '">' +
      '<div class="recur-card-main recur-open" data-recur-open="' + r.id + '"' +
        ' role="link" tabindex="0"' +
        ' aria-label="Lihat transaksi ' + escapeHtml(r.person_name) + ' bulan ini">' +
        '<span class="recur-emoji" aria-hidden="true">🔁</span>' +
        "<div>" +
          '<p class="recur-name">' + escapeHtml(r.person_name) + "</p>" +
          '<p class="recur-amount">' + rupiah(r.amount) + " / bulan</p>" +
          '<p class="recur-schedule">Setiap tanggal ' + r.due_day + " · " + dirLabel + "</p>" +
          noteLine +
          recurPayStatus(r) +
        "</div>" +
        '<span class="recur-chev" aria-hidden="true">›</span>' +
      "</div>" +
      '<div class="recur-card-foot">' +
        '<span class="recur-status ' + statusCls + '">' + statusTxt + "</span>" +
        '<div class="recur-actions">' +
          '<button type="button" class="link-btn" data-recur-edit="' + r.id + '">Edit</button>' +
          '<button type="button" class="link-btn" data-recur-toggle="' + r.id + '">' + toggleTxt + "</button>" +
          '<button type="button" class="link-btn link-danger" data-recur-delete="' + r.id + '">Hapus</button>' +
        "</div>" +
      "</div></li>";
  }

  function renderRecurring() {
    if (!recurList) return;
    buildRecurDebtMap();
    var sorted = allRules.slice().sort(function (a, b) {
      if (!!a.is_active !== !!b.is_active) return a.is_active ? -1 : 1;
      return 0;
    });
    if (recurEmpty) recurEmpty.hidden = sorted.length > 0;
    recurList.innerHTML = sorted.map(recurCardHTML).join("");
    // Klik area utama card -> buka debt periode berjalan.
    // Tombol Edit/Nonaktifkan/Hapus ada di area terpisah (foot) dan tidak ikut navigasi.
    recurList.querySelectorAll("[data-recur-open]").forEach(function (el) {
      el.addEventListener("click", function () { openRecurDebt(el.getAttribute("data-recur-open")); });
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openRecurDebt(el.getAttribute("data-recur-open"));
        }
      });
    });
    recurList.querySelectorAll("[data-recur-edit]").forEach(function (b) {
      b.addEventListener("click", function () { openRecurModal(b.getAttribute("data-recur-edit")); });
    });
    recurList.querySelectorAll("[data-recur-toggle]").forEach(function (b) {
      b.addEventListener("click", function () { toggleRule(b.getAttribute("data-recur-toggle")); });
    });
    recurList.querySelectorAll("[data-recur-delete]").forEach(function (b) {
      b.addEventListener("click", function () { deleteRule(b.getAttribute("data-recur-delete")); });
    });
  }

  async function toggleRule(id) {
    var rule = allRules.find(function (r) { return r.id === id; });
    if (!rule) return;
    try {
      var client = await waitForClient();
      var res = await client.from("recurring_rules").update({ is_active: !rule.is_active }).eq("id", id);
      if (res.error) throw res.error;
      rule.is_active = !rule.is_active;
      renderRecurring();
      toast(rule.is_active ? "Catatan setiap bulan diaktifkan." : "Catatan setiap bulan dinonaktifkan. Catatan yang sudah ada tetap aman.");
    } catch (e) {
      console.error("[Nyangkut] toggle rule gagal:", e);
      toast("Gagal mengubah aturan. Coba lagi ya.");
    }
  }

  async function deleteRule(id) {
    var rule = allRules.find(function (r) { return r.id === id; });
    if (!rule) return;
    var ok = window.confirm(
      'Hapus "' + rule.person_name + '" dari catatan setiap bulan?\n\nCatatan yang sudah dibuat TIDAK ikut terhapus.'
    );
    if (!ok) return;
    try {
      var client = await waitForClient();
      var res = await client.from("recurring_rules").delete().eq("id", id);
      if (res.error) throw res.error;
      allRules = allRules.filter(function (r) { return r.id !== id; });
      renderRecurring();
      toast("Catatan setiap bulan dihapus. Riwayat transaksi tetap aman.");
    } catch (e) {
      console.error("[Nyangkut] hapus rule gagal:", e);
      toast("Gagal menghapus aturan. Coba lagi ya.");
    }
  }

  // ---------- Recurring modal (buat / edit) ----------
  var recurModal = document.querySelector("[data-recur-modal]");
  var recurForm = document.querySelector("[data-recur-form]");
  var recurFormError = document.querySelector("[data-recur-form-error]");
  var recurTitle = document.querySelector("[data-recur-modal-title]");
  var recurSubmitLabel = document.querySelector("[data-recur-submit-label]");
  var recurDirection = null;
  var recurEditingId = null;
  var recurBusy = false;
  var recurDaySelect = document.getElementById("r-day");
  var rAmountInput = document.getElementById("r-amount");

  // Isi opsi tanggal 1-31.
  if (recurDaySelect && !recurDaySelect.options.length) {
    for (var dd = 1; dd <= 31; dd++) {
      var opt = document.createElement("option");
      opt.value = String(dd);
      opt.textContent = "Tanggal " + dd;
      recurDaySelect.appendChild(opt);
    }
  }

  function updateRecurPreview() {
    var wrap = document.querySelector("[data-recur-preview]");
    var titleEl = document.querySelector("[data-recur-preview-title]");
    var subEl = document.querySelector("[data-recur-preview-sub]");
    if (!wrap || !recurDaySelect || !titleEl || !subEl) return;
    // Hanya tampilkan preview saat buat baru (bukan edit).
    if (recurEditingId) { wrap.hidden = true; return; }
    var day = parseInt(recurDaySelect.value || "1", 10);
    var start = computeStartPeriod(day);
    var digits = rAmountInput ? rAmountInput.value.replace(/\D/g, "") : "";
    var amountTxt = digits ? rupiah(Number(digits)) : "Rp…";
    titleEl.textContent = "Mulai " + recurPeriodLabel(start);
    subEl.textContent = "Catatan " + amountTxt + " akan otomatis dibuat setiap tanggal " + day + ".";
    wrap.hidden = false;
  }

  function openRecurModal(editId) {
    if (!recurModal || !hasPremiumAccess(userProfile)) return;
    recurEditingId = editId || null;
    recurDirection = null;
    recurBusy = false;
    if (recurForm) recurForm.reset();
    if (recurFormError) recurFormError.hidden = true;
    document.querySelectorAll("[data-rdirection]").forEach(function (b) {
      b.setAttribute("aria-checked", "false");
    });
    document.querySelectorAll("[data-rerror]").forEach(function (e) { e.hidden = true; });
    if (recurTitle) recurTitle.textContent = editId ? "Edit Catatan Setiap Bulan" : "Buat Catatan Setiap Bulan";
    if (recurSubmitLabel) recurSubmitLabel.textContent = editId ? "Simpan Perubahan" : "Simpan Catatan";

    if (editId) {
      var rule = allRules.find(function (r) { return r.id === editId; });
      if (rule) {
        recurDirection = rule.direction;
        document.querySelectorAll("[data-rdirection]").forEach(function (b) {
          b.setAttribute("aria-checked", String(b.getAttribute("data-rdirection") === rule.direction));
        });
        document.getElementById("r-name").value = rule.person_name || "";
        if (rAmountInput) {
          rAmountInput.value = new Intl.NumberFormat("id-ID").format(Number(rule.amount) || 0);
        }
        document.getElementById("r-note").value = rule.note || "";
        if (recurDaySelect) recurDaySelect.value = String(rule.due_day || 1);
        setReminderChecks(recurForm, rule.reminder_offsets || null);
      }
    } else if (recurDaySelect) {
      recurDaySelect.value = "15";
      setReminderChecks(recurForm, null);
    }
    updateRecurPreview();
    recurModal.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { recurModal.classList.add("show"); });
    });
    document.body.style.overflow = "hidden";
  }

  function closeRecurModal() {
    if (!recurModal) return;
    recurModal.classList.remove("show");
    document.body.style.overflow = "";
    setTimeout(function () {
      if (!recurModal.classList.contains("show")) recurModal.hidden = true;
    }, 200);
    recurEditingId = null;
  }

  function rFieldError(name, show) {
    var el = document.querySelector('[data-rerror="' + name + '"]');
    if (el) el.hidden = !show;
  }

  document.querySelectorAll("[data-recur-add]").forEach(function (b) {
    b.addEventListener("click", function () { openRecurModal(null); });
  });
  document.querySelectorAll("[data-recur-close]").forEach(function (b) {
    b.addEventListener("click", closeRecurModal);
  });
  if (recurModal) {
    recurModal.addEventListener("click", function (e) {
      if (e.target === recurModal) closeRecurModal();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && recurModal && !recurModal.hidden) closeRecurModal();
  });
  document.querySelectorAll("[data-rdirection]").forEach(function (b) {
    b.addEventListener("click", function () {
      recurDirection = b.getAttribute("data-rdirection");
      document.querySelectorAll("[data-rdirection]").forEach(function (o) {
        o.setAttribute("aria-checked", String(o === b));
      });
      rFieldError("direction", false);
    });
  });
  if (recurDaySelect) {
    recurDaySelect.addEventListener("change", updateRecurPreview);
  }
  if (rAmountInput) {
    rAmountInput.addEventListener("input", function () {
      var digits = rAmountInput.value.replace(/\D/g, "").slice(0, 15);
      rAmountInput.value = digits ? new Intl.NumberFormat("id-ID").format(Number(digits)) : "";
      updateRecurPreview();
    });
  }

  if (recurForm) {
    recurForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (recurBusy) return;
      if (!hasPremiumAccess(userProfile)) {
        if (recurFormError) {
          recurFormError.textContent = "Fitur ini khusus Premium.";
          recurFormError.hidden = false;
        }
        return;
      }
      if (recurFormError) recurFormError.hidden = true;

      var name = document.getElementById("r-name").value.trim();
      var amountDigits = rAmountInput.value.replace(/\D/g, "");
      var amount = amountDigits ? Number(amountDigits) : 0;
      var note = document.getElementById("r-note").value.trim();
      var dueDay = parseInt(recurDaySelect.value, 10);

      var valid = true;
      if (!recurDirection) { rFieldError("direction", true); valid = false; }
      if (!name) { rFieldError("person_name", true); valid = false; } else { rFieldError("person_name", false); }
      if (!(amount > 0)) { rFieldError("amount", true); valid = false; } else { rFieldError("amount", false); }
      if (!(dueDay >= 1 && dueDay <= 31)) valid = false;
      if (!valid) return;

      recurBusy = true;
      if (recurSubmitLabel) recurSubmitLabel.textContent = "Menyimpan…";

      var payload = {
        direction: recurDirection,
        person_name: name,
        amount: amount,
        note: note || null,
        due_day: dueDay,
        is_active: true
      };
      // start_period hanya saat buat baru (kolom tidak bisa di-update client).
      if (!recurEditingId) payload.start_period = computeStartPeriod(dueDay);
      // Advanced Reminder: config ikut template; diwariskan ke debt bulanan.
      var rRemOffsets = collectReminderOffsets(recurForm);
      if (rRemOffsets) payload.reminder_offsets = rRemOffsets;

      waitForClient().then(function (client) {
        if (!client) throw new Error("no-client");
        if (recurEditingId) {
          // Edit: hanya field yang diizinkan; debt lama TIDAK berubah.
          var upd = {
            direction: payload.direction,
            person_name: payload.person_name,
            amount: payload.amount,
            note: payload.note,
            due_day: payload.due_day
          };
          // reminder_offsets boleh null (kembali ke basic) — hanya jika kolom ada.
          if (hasReminderCols) upd.reminder_offsets = rRemOffsets;
          return client.from("recurring_rules")
            .update(upd)
            .eq("id", recurEditingId);
        }
        return client.from("recurring_rules").insert(payload);
      }).then(function (res) {
        if (res.error) throw res.error;
        closeRecurModal();
        toast(recurEditingId ? "Catatan setiap bulan diperbarui." : "Catatan setiap bulan disimpan. Catatan baru akan otomatis dibuat setiap bulan.");
        return loadRecurring();
      }).catch(function (err) {
        console.error("[Nyangkut] simpan rule gagal:", err);
        if (recurFormError) {
          var msg = String((err && err.message) || "");
          recurFormError.textContent = msg.includes("recurring_rules")
            ? "Fitur ini belum aktif di database. Coba lagi nanti ya."
            : "Gagal menyimpan. Periksa koneksi kamu lalu coba lagi.";
          recurFormError.hidden = false;
        }
        recurBusy = false;
        if (recurSubmitLabel) recurSubmitLabel.textContent = recurEditingId ? "Simpan Perubahan" : "Simpan Catatan";
      });
    });
  }

  // ---------- modal + form tambah catatan ----------
  var modal = document.querySelector("[data-modal]");
  var form = document.querySelector("[data-debt-form]");
  var submitBtn = document.querySelector("[data-submit]");
  var submitLabel = submitBtn ? submitBtn.querySelector("[data-button-label]") : null;
  var formError = document.querySelector("[data-form-error]");
  var amountInput = document.getElementById("f-amount");
  var dueInput = document.getElementById("f-due");
  var direction = null;
  var busy = false;
  var toastTimer = null;

  var modalCloseTimer = null;

  function openModal() {
  if (modal) {
    if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; }
    // Reset pilihan pengingat tiap buka modal.
    setReminderChecks(document.querySelector("[data-debt-form]"), null);
    modal.hidden = false;
    // Animasi via class .show (bottom sheet di mobile, centered di desktop).
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { modal.classList.add("show"); });
    });
    document.body.style.overflow = "hidden"; // kunci scroll belakang saat modal buka
  }
  }

  function closeModal() {
  if (modal) {
    modal.classList.remove("show");
    if (modalCloseTimer) clearTimeout(modalCloseTimer);
    modalCloseTimer = setTimeout(function () {
      modalCloseTimer = null;
      // Hanya sembunyikan jika tidak dibuka lagi selama animasi.
      if (!modal.classList.contains("show")) modal.hidden = true;
    }, 200);
  }
  document.body.style.overflow = "";
  resetForm();
  }

  function resetForm() {
  direction = null;
  busy = false;
  if (form) form.reset();
  document.querySelectorAll(".seg-opt").forEach(function (b) {
    b.setAttribute("aria-checked", "false");
  });
  document.querySelectorAll("[data-error]").forEach(function (e) { e.hidden = true; });
  if (formError) formError.hidden = true;
  setBusy(false);
  if (typeof resetProvider === "function") resetProvider();
  updateProviderVisibility();
  }

  function setBusy(b) {
  busy = b;
  if (submitBtn) submitBtn.disabled = b;
  if (submitLabel) submitLabel.textContent = b ? "Menyimpan…" : "Simpan Catatan";
  }

  function fieldError(name, show) {
  var el = document.querySelector('[data-error="' + name + '"]');
  if (el) el.hidden = !show;
  }

  function showFormError(msg) {
  if (!formError) return;
  formError.textContent = msg;
  formError.hidden = !msg;
  }

  function toast(msg) {
  var el = document.querySelector("[data-toast]");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function friendlyInsertError(err) {
  var msg = String((err && err.message) || "").toLowerCase();
  // Trigger free limit dari database (migration 004).
  if (msg.includes("free_limit_reached")) {
    return "Kamu sudah mencapai batas 10 catatan aktif di paket Free.";
  }
  if (msg.includes("jwt") || msg.includes("auth") || msg.includes("permission") || msg.includes("policy")) {
    return "Sesi kamu bermasalah. Coba keluar lalu masuk lagi ya.";
  }
  return "Gagal menyimpan. Periksa koneksi kamu lalu coba lagi.";
  }

  document.querySelectorAll("[data-add]").forEach(function (b) {
  b.addEventListener("click", openModal);
  });
  document.querySelectorAll("[data-modal-close]").forEach(function (b) {
  b.addEventListener("click", closeModal);
  });
  if (modal) {
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });
  }
  document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && modal && !modal.hidden) closeModal();
  });

  // Pilihan arah: segmented, tanpa default diam-diam.
  document.querySelectorAll(".seg-opt").forEach(function (b) {
  b.addEventListener("click", function () {
    direction = b.getAttribute("data-direction");
    document.querySelectorAll(".seg-opt").forEach(function (o) {
      o.setAttribute("aria-checked", String(o === b));
    });
    fieldError("direction", false);
    updateProviderVisibility();
  });
  });

  // ---------- Provider pinjaman/paylater (hanya untuk payable, opsional) ----------
  // Provider hanya helper pengisi "Nama"; yang tersimpan tetap person_name existing.
  // Tidak ada perubahan schema/database.
  var PROVIDERS = ["Kredivo", "Akulaku", "AdaKami", "SPinjam", "SPayLater",
  "GoPay Pinjam", "AdaPundi", "Jago", "Easycash"];
  var PROVIDER_CUSTOM = "__custom";

  var providerField = document.querySelector("[data-provider-field]");
  var providerBtn = document.querySelector("[data-provider-btn]");
  var providerLabel = document.querySelector("[data-provider-label]");
  var providerPanel = document.querySelector("[data-provider-panel]");
  var providerSearch = document.querySelector("[data-provider-search]");
  var providerList = document.querySelector("[data-provider-list]");
  var providerCustomWrap = document.querySelector("[data-provider-custom]");
  var providerCustomInput = document.querySelector("[data-provider-custom-input]");
  var nameInput = document.getElementById("f-name");
  var PROVIDER_PLACEHOLDER = "Pilih penyedia (boleh dilewati)";

  function updateProviderVisibility() {
  if (!providerField) return;
  var show = direction === "payable";
  providerField.hidden = !show;
  if (!show) resetProvider();
  }

  function resetProvider() {
  if (providerLabel) providerLabel.textContent = PROVIDER_PLACEHOLDER;
  if (providerCustomWrap) providerCustomWrap.hidden = true;
  if (providerCustomInput) providerCustomInput.value = "";
  closeProviderPanel();
  }

  function closeProviderPanel() {
  if (providerPanel) providerPanel.hidden = true;
  if (providerBtn) providerBtn.setAttribute("aria-expanded", "false");
  }

  function openProviderPanel() {
  if (!providerPanel) return;
  renderProviderOptions("");
  providerPanel.hidden = false;
  providerBtn.setAttribute("aria-expanded", "true");
  providerSearch.value = "";
  setTimeout(function () { providerSearch.focus(); }, 30);
  }

  function renderProviderOptions(q) {
  var query = String(q || "").trim().toLowerCase();
  var html = "";
  var matches = PROVIDERS.filter(function (p) {
    return !query || p.toLowerCase().indexOf(query) !== -1;
  });
  if (!matches.length && query) {
    html += '<li class="provider-empty">Tidak ketemu. Pilih "Lainnya / Isi sendiri" di bawah.</li>';
  }
  matches.forEach(function (p) {
    html += '<li><button type="button" data-provider-pick="' + escapeHtml(p) + '" role="option">' +
      escapeHtml(p) + "</button></li>";
  });
  html += '<li><button type="button" class="provider-custom-opt" data-provider-pick="' +
    PROVIDER_CUSTOM + '" role="option">Lainnya / Isi sendiri</button></li>';
  providerList.innerHTML = html;
  providerList.querySelectorAll("[data-provider-pick]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      pickProvider(btn.getAttribute("data-provider-pick"));
    });
  });
  }

  function pickProvider(value) {
  if (value === PROVIDER_CUSTOM) {
    providerLabel.textContent = "Lainnya / Isi sendiri";
    providerCustomWrap.hidden = false;
    closeProviderPanel();
    setTimeout(function () { providerCustomInput.focus(); }, 30);
    return;
  }
  if (nameInput) {
    nameInput.value = value;
    fieldError("person_name", false);
  }
  providerLabel.textContent = value;
  providerCustomWrap.hidden = true;
  if (providerCustomInput) providerCustomInput.value = "";
  closeProviderPanel();
  }

  if (providerBtn) {
  providerBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (providerPanel.hidden) openProviderPanel();
    else closeProviderPanel();
  });
  }
  if (providerSearch) {
  providerSearch.addEventListener("input", function () {
    renderProviderOptions(providerSearch.value);
  });
  providerSearch.addEventListener("click", function (e) { e.stopPropagation(); });
  }
  if (providerCustomInput && nameInput) {
  providerCustomInput.addEventListener("input", function () {
    nameInput.value = providerCustomInput.value;
    fieldError("person_name", false);
  });
  }
  document.addEventListener("click", function (e) {
  if (providerPanel && !providerPanel.hidden &&
      !e.target.closest("[data-provider-field]")) {
    closeProviderPanel();
  }
  });
  document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && providerPanel && !providerPanel.hidden) {
    closeProviderPanel();
    if (providerBtn) providerBtn.focus();
  }
  });

  // Format rupiah saat mengetik: hanya digit, pemisah ribuan otomatis.
  if (amountInput) {
  amountInput.addEventListener("input", function () {
    var digits = amountInput.value.replace(/\D/g, "").slice(0, 15);
    amountInput.value = digits
      ? new Intl.NumberFormat("id-ID").format(Number(digits))
      : "";
  });
  }

  var clearDue = document.querySelector("[data-clear-due]");
  if (clearDue && dueInput) {
  clearDue.addEventListener("click", function () { dueInput.value = ""; });
  }

  if (form) {
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) return; // cegah double submit
    showFormError("");

    var nameInput = document.getElementById("f-name");
    var name = nameInput.value.trim();
    var amountDigits = amountInput.value.replace(/\D/g, "");
    var amount = amountDigits ? Number(amountDigits) : 0;
    var note = document.getElementById("f-note").value.trim();
    var due = dueInput.value || null;

    var valid = true;
    if (!direction) { fieldError("direction", true); valid = false; }
    if (!name) { fieldError("person_name", true); valid = false; } else { fieldError("person_name", false); }
    if (!(amount > 0)) { fieldError("amount", true); valid = false; } else { fieldError("amount", false); }
    if (!valid) return;

    // Pre-check free limit (UX cepat; enforcement tetap di database trigger).
    if (!hasPremiumAccess(userProfile) && countActive(allDebts) >= FREE_ACTIVE_LIMIT) {
      showFormError("Kamu sudah mencapai batas 10 catatan aktif di paket Free.");
      return;
    }

    setBusy(true);

    // Payload minimal: user_id diisi DEFAULT auth.uid() oleh database,
    // paid_amount/status dipaksa trigger. Jangan kirim ketiganya.
    var payload = {
      direction: direction,
      person_name: name,
      amount: amount,
      note: note || null,
      due_date: due,
    };
    // Advanced Reminder: hanya untuk premium & jika kolom sudah ada.
    var noteForm = document.querySelector("[data-debt-form]");
    var remOffsets = collectReminderOffsets(noteForm);
    if (remOffsets) payload.reminder_offsets = remOffsets;

    waitForClient().then(function (client) {
      if (!client) throw new Error("no-client");
      return client.from("debts").insert(payload);
    }).then(function (res) {
      if (res.error) throw res.error;
      closeModal();
      toast("Catatan berhasil disimpan.");
      return load(); // re-fetch: kartu + list langsung update
    }).catch(function (err) {
      console.error("[Nyangkut] insert debt gagal:", err);
      showFormError(friendlyInsertError(err));
      setBusy(false);
    });
  });
  }

  var retry = document.querySelector("[data-retry]");
  if (retry) retry.addEventListener("click", load);

  // ============ Orang & Saldo ============
  // Agregasi client-side dari allDebts (sudah RLS-filtered di load()).
  // Tidak ada query baru, tidak ada table baru, tidak ada balance yang disimpan.
  // Source of truth tetap debts.amount / debts.paid_amount / payments.

  function normalizePersonKey(name) {
    return String(name || "").trim().toLowerCase();
  }

  function personRemaining(d) {
    return Number(d.amount) - Number(d.paid_amount);
  }

  function personIsOverdue(d, today) {
    return !!(d.due_date && d.due_date < today && d.status !== "paid");
  }

  function buildPeople(debts) {
    var today = dayStr(new Date());
    var map = {};
    debts.forEach(function (d) {
      var key = normalizePersonKey(d.person_name);
      if (!key) return;
      if (!map[key]) {
        map[key] = {
          key: key,
          displayName: String(d.person_name).trim(),
          debts: [],
          receivableActive: 0,
          payableActive: 0,
          activeCount: 0,
          overdueCount: 0,
          hasHistory: false,
        };
      }
      var p = map[key];
      p.debts.push(d);
      var rem = personRemaining(d);
      if (rem > 0) {
        if (d.direction === "receivable") p.receivableActive += rem;
        else p.payableActive += rem;
        p.activeCount++;
        if (personIsOverdue(d, today)) p.overdueCount++;
      } else {
        p.hasHistory = true;
      }
    });
    var list = Object.keys(map).map(function (k) { return map[k]; });
    // Urut: yang punya saldo aktif dulu (total terbesar), lalu nama A-Z.
    // Orang yang semua transaksinya lunas tetap muncul di bawah (history tersedia).
    list.sort(function (a, b) {
      var ta = a.receivableActive + a.payableActive;
      var tb = b.receivableActive + b.payableActive;
      var aa = ta > 0 ? 0 : 1;
      var ab = tb > 0 ? 0 : 1;
      if (aa !== ab) return aa - ab;
      if (ta !== tb) return tb - ta;
      return a.displayName.localeCompare(b.displayName, "id");
    });
    return list;
  }

  var peopleCache = [];
  var peopleEls = {
    summary: document.querySelector("[data-people-summary]"),
    count: document.querySelector("[data-people-count]"),
    inEl: document.querySelector("[data-people-in]"),
    outEl: document.querySelector("[data-people-out]"),
    searchWrap: document.querySelector("[data-people-search-wrap]"),
    search: document.querySelector("[data-people-search]"),
    empty: document.querySelector("[data-people-empty]"),
    noResult: document.querySelector("[data-people-no-result]"),
    list: document.querySelector("[data-people-list]"),
  };

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function personBalanceHTML(p) {
    var parts = [];
    if (p.receivableActive > 0) {
      parts.push('Kamu harus menerima <span class="bal-in">' + rupiah(p.receivableActive) + "</span>");
    }
    if (p.payableActive > 0) {
      parts.push('Kamu harus bayar <span class="bal-out">' + rupiah(p.payableActive) + "</span>");
    }
    if (!parts.length) return '<span class="person-meta">Tidak ada saldo aktif</span>';
    return parts.join("<br>");
  }

  function personMetaHTML(p) {
    var bits = [];
    if (p.activeCount > 0) {
      bits.push(p.activeCount + " catatan" + (p.overdueCount > 0 ? ' · <span class="overdue-tag">' + p.overdueCount + " terlambat</span>" : ""));
    } else {
      bits.push("Riwayat tersedia");
    }
    return bits.join("");
  }

  function renderPeople() {
    if (!peopleEls.list) return;
    peopleCache = buildPeople(allDebts);
    var q = peopleEls.search ? normalizePersonKey(peopleEls.search.value) : "";
    var filtered = q
      ? peopleCache.filter(function (p) { return p.key.indexOf(q) !== -1; })
      : peopleCache;

    var hasAny = peopleCache.length > 0;
    // Summary: hanya dari orang aktif (ada saldo > 0).
    var active = peopleCache.filter(function (p) {
      return p.receivableActive + p.payableActive > 0;
    });
    if (peopleEls.summary) peopleEls.summary.hidden = !hasAny;
    if (peopleEls.searchWrap) peopleEls.searchWrap.hidden = !hasAny;
    if (peopleEls.empty) peopleEls.empty.hidden = hasAny;
    if (peopleEls.noResult) peopleEls.noResult.hidden = !(hasAny && filtered.length === 0);

    if (hasAny && peopleEls.count) {
      peopleEls.count.textContent = active.length;
      peopleEls.inEl.textContent = rupiah(active.reduce(function (a, p) { return a + p.receivableActive; }, 0));
      peopleEls.outEl.textContent = rupiah(active.reduce(function (a, p) { return a + p.payableActive; }, 0));
    }

    peopleEls.list.innerHTML = filtered.map(function (p) {
      var initial = (p.displayName.trim().charAt(0) || "?").toUpperCase();
      return (
        '<li><button type="button" class="person-card" data-person-key="' + escHtml(p.key) + '">' +
        '<span class="person-avatar" aria-hidden="true">' + escHtml(initial) + "</span>" +
        '<span class="person-body">' +
        '<span class="person-name">' + escHtml(p.displayName) + "</span>" +
        '<span class="person-balance">' + personBalanceHTML(p) + "</span>" +
        '<span class="person-meta">' + personMetaHTML(p) + "</span>" +
        "</span>" +
        '<span class="person-chevron" aria-hidden="true">›</span>' +
        "</button></li>"
      );
    }).join("");

    peopleEls.list.querySelectorAll("[data-person-key]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openPersonDetail(btn.getAttribute("data-person-key"));
      });
    });
  }

  if (peopleEls.search) {
    peopleEls.search.addEventListener("input", function () {
      renderPeople();
    });
  }

  // ---------- Person detail sheet ----------
  var personSheet = document.querySelector("[data-person-sheet]");
  var personBackdrop = document.querySelector("[data-person-backdrop]");

  function showSheet(sheet, backdrop) {
    if (!sheet) return;
    sheet.hidden = false;
    requestAnimationFrame(function () {
      sheet.classList.add("show");
      if (backdrop) {
        backdrop.hidden = false;
        requestAnimationFrame(function () { backdrop.classList.add("show"); });
      }
    });
    document.body.style.overflow = "hidden";
  }
  function hideSheet(sheet, backdrop) {
    if (!sheet) return;
    sheet.classList.remove("show");
    if (backdrop) backdrop.classList.remove("show");
    setTimeout(function () {
      sheet.hidden = true;
      if (backdrop) backdrop.hidden = true;
      // Jangan paksa unlock kalau modal lain masih terbuka.
      if (!document.querySelector(".sheet.show") && !document.querySelector(".modal-backdrop.show")) {
        document.body.style.overflow = "";
      }
    }, 200);
  }

  function openPersonDetail(key) {
    var p = null;
    for (var i = 0; i < peopleCache.length; i++) {
      if (peopleCache[i].key === key) { p = peopleCache[i]; break; }
    }
    if (!p || !personSheet) return;

    var avEl = personSheet.querySelector("[data-person-avatar]");
    if (avEl) avEl.textContent = (p.displayName.trim().charAt(0) || "?").toUpperCase();
    var nameEl = personSheet.querySelector("[data-person-name]");
    if (nameEl) nameEl.textContent = p.displayName;
    var metaEl = personSheet.querySelector("[data-person-meta]");
    if (metaEl) metaEl.innerHTML = personMetaHTML(p);

    var body = personSheet.querySelector("[data-person-body]");
    if (body) {
      var today = dayStr(new Date());
      var html = "";

      // Blok saldo: tampilkan kedua sisi secara transparan (tanpa netting).
      if (p.receivableActive > 0) {
        html += '<div class="person-bal-block">' +
          '<p class="person-bal-label">' + escHtml(p.displayName) + " masih harus bayar kamu</p>" +
          '<p class="person-bal-value bal-in">' + rupiah(p.receivableActive) + "</p>" +
          "</div>";
      }
      if (p.payableActive > 0) {
        html += '<div class="person-bal-block">' +
          '<p class="person-bal-label">Kamu masih harus bayar ' + escHtml(p.displayName) + "</p>" +
          '<p class="person-bal-value bal-out">' + rupiah(p.payableActive) + "</p>" +
          "</div>";
      }
      if (p.receivableActive + p.payableActive === 0) {
        html += '<div class="person-bal-block">' +
          '<p class="person-bal-label">Tidak ada saldo aktif</p>' +
          '<p class="person-bal-sub">Semua catatan dengan ' + escHtml(p.displayName) + " sudah lunas. Riwayat tetap tersedia di bawah.</p>" +
          "</div>";
      }

      // Catatan aktif (ada sisa).
      var activeDebts = p.debts.filter(function (d) { return personRemaining(d) > 0; });
      // Urut: jatuh tempo terdekat dulu.
      activeDebts.sort(function (a, b) {
        if (a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : 1;
        if (a.due_date) return -1;
        if (b.due_date) return 1;
        return 0;
      });
      html += '<h4 class="person-sec-title">Catatan aktif</h4>';
      if (activeDebts.length) {
        html += '<ul class="person-note-list">';
        activeDebts.forEach(function (d) {
          var rem = personRemaining(d);
          var isRecv = d.direction === "receivable";
          var overdue = personIsOverdue(d, today);
          var noteName = d.note ? d.note : (isRecv ? "Uang yang harus balik ke kamu" : "Uang yang harus kamu bayar");
          html += '<li class="person-note">' +
            '<div class="person-note-info">' +
            '<p class="person-note-name">' + escHtml(noteName) + "</p>" +
            '<p class="person-note-amounts">Total <strong>' + rupiah(d.amount) + "</strong>" +
            " · Sisa <strong>" + rupiah(rem) + "</strong>" +
            (d.due_date ? " · " + escHtml(fmtDue(d.due_date)) : "") +
            (overdue ? ' · <span class="overdue-tag">Terlambat</span>' : "") +
            "</p></div>" +
            '<div class="person-note-actions">' +
            (isRecv ? '<button type="button" class="wa-mini-btn" data-wa-for="' + d.id + '" aria-label="Ingatkan via WhatsApp">💬</button>' : "") +
            '<a class="person-note-link" href="/debt/?id=' + d.id + '" aria-label="Lihat detail catatan">›</a>' +
            "</div></li>";
        });
        html += "</ul>";
      } else {
        html += '<p class="person-empty-note">Tidak ada catatan aktif.</p>';
      }

      // Riwayat (lunas).
      var paidDebts = p.debts.filter(function (d) { return personRemaining(d) <= 0; });
      if (paidDebts.length) {
        html += '<h4 class="person-sec-title">Riwayat</h4><ul class="person-note-list">';
        paidDebts.forEach(function (d) {
          var noteName = d.note ? d.note : (d.direction === "receivable" ? "Uang yang harus balik ke kamu" : "Uang yang harus kamu bayar");
          html += '<li class="person-note is-paid">' +
            '<div class="person-note-info">' +
            '<p class="person-note-name">' + escHtml(noteName) + "</p>" +
            '<p class="person-note-amounts"><strong>' + rupiah(d.amount) + "</strong> · Lunas ✓</p></div>" +
            '<div class="person-note-actions">' +
            '<a class="person-note-link" href="/debt/?id=' + d.id + '" aria-label="Lihat detail catatan">›</a>' +
            "</div></li>";
        });
        html += "</ul>";
      }

      body.innerHTML = html;

      // Wire WA buttons (per-note, reuse flow yang sama).
      body.querySelectorAll("[data-wa-for]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var debtId = btn.getAttribute("data-wa-for");
          var debt = null;
          for (var j = 0; j < allDebts.length; j++) {
            if (allDebts[j].id === debtId) { debt = allDebts[j]; break; }
          }
          if (debt) openWaModalFor(debt);
        });
      });
    }

    showSheet(personSheet, personBackdrop);
  }

  function closePersonDetail() {
    hideSheet(personSheet, personBackdrop);
  }

  document.querySelectorAll("[data-person-close]").forEach(function (b) {
    b.addEventListener("click", closePersonDetail);
  });
  if (personBackdrop) {
    personBackdrop.addEventListener("click", closePersonDetail);
  }

  // ---------- WA Tagih (port dari debt page, per-note) ----------
  // Logic sama persis: modal input nomor -> preview -> wa.me -> user tekan Send.
  // Rate limit 10x/hari/akun tetap berlaku. Nomor tidak pernah disimpan.
  var WA_DAILY_LIMIT = 10;
  var waModal = document.querySelector("[data-wa-modal]");
  var waForm = document.querySelector("[data-wa-form]");
  var waPhone = document.getElementById("wa-phone");
  var waError = document.querySelector("[data-wa-error]");
  var waTargetDebt = null;

  function waDayStartWIB() {
    // Awal hari ini dalam WIB sebagai ISO string.
    var now = new Date();
    var wib = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
    wib.setHours(0, 0, 0, 0);
    return new Date(wib.getTime() - (7 * 60 + now.getTimezoneOffset()) * 60000).toISOString();
  }

  async function getWaUsageToday() {
    try {
      var c = await waitForClient();
      var res = await c.from("wa_reminder_usage")
        .select("id", { count: "exact", head: true })
        .gte("used_at", waDayStartWIB());
      if (res.error) throw res.error;
      return res.count || 0;
    } catch (e) {
      console.warn("[Nyangkut] WA rate limit check gagal:", e);
      return 0; // fail-open
    }
  }

  async function logWaUsage() {
    try {
      var c = await waitForClient();
      var session = await c.auth.getSession();
      var uid = session && session.data && session.data.session && session.data.session.user
        ? session.data.session.user.id : null;
      if (!uid) return;
      await c.from("wa_reminder_usage").insert({ user_id: uid });
    } catch (e) {
      console.warn("[Nyangkut] WA usage log gagal:", e);
    }
  }

  function normalizeWaNumber(input) {
    var digits = String(input || "").replace(/\D/g, "");
    if (digits.startsWith("62")) {
      // sudah format internasional
    } else if (digits.startsWith("0")) {
      digits = "62" + digits.slice(1);
    } else if (digits.startsWith("8")) {
      digits = "62" + digits;
    } else {
      return null;
    }
    if (!/^628\d{8,11}$/.test(digits)) return null;
    return digits;
  }

  function fmtDateLong(iso) {
    if (!iso) return "";
    var p = String(iso).slice(0, 10).split("-");
    if (p.length !== 3) return String(iso);
    return parseInt(p[2], 10) + " " + MONTHS[parseInt(p[1], 10) - 1] + " " + p[0];
  }

  function buildWaMessageFor(debt) {
    var rem = personRemaining(debt);
    var amountStr = rupiah(rem);
    var isPartial = debt.status === "partial" && Number(debt.paid_amount) > 0;
    var amountWord = isPartial ? "sisa " + amountStr : "uang " + amountStr;
    var body;
    if (debt.due_date) {
      body = "mau ingetin soal " + amountWord + " yang jatuh tempo " + fmtDateLong(debt.due_date) + " ya.";
    } else {
      body = "mau ingetin soal " + amountWord + " yang kemarin ya.";
    }
    return "Hai " + debt.person_name + ", " + body + " Kalau sudah sempat, boleh dibalikin. Makasih 🙏";
  }

  function openWaModalFor(debt) {
    if (!debt || debt.direction !== "receivable" || debt.status === "paid") return;
    if (personRemaining(debt) <= 0) return;
    waTargetDebt = debt;
    if (waForm) waForm.reset();
    if (waError) waError.hidden = true;
    var preview = document.querySelector("[data-wa-preview]");
    if (preview) preview.textContent = buildWaMessageFor(debt);
    if (waModal) {
      waModal.hidden = false;
      requestAnimationFrame(function () { waModal.classList.add("show"); });
    }
    document.body.style.overflow = "hidden";
    setTimeout(function () { if (waPhone) waPhone.focus(); }, 50);
  }

  function closeWaModal() {
    if (!waModal) return;
    waModal.classList.remove("show");
    setTimeout(function () {
      waModal.hidden = true;
      if (!document.querySelector(".sheet.show")) document.body.style.overflow = "";
    }, 200);
    waTargetDebt = null;
  }

  document.querySelectorAll("[data-wa-close]").forEach(function (b) {
    b.addEventListener("click", closeWaModal);
  });
  if (waModal) {
    waModal.addEventListener("click", function (e) {
      if (e.target === waModal) closeWaModal();
    });
  }
  if (waForm) {
    waForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!waTargetDebt) return;
      var normalized = normalizeWaNumber(waPhone.value);
      if (!normalized) {
        waError.textContent = "Nomor WhatsApp belum valid.";
        waError.hidden = false;
        waPhone.focus();
        return;
      }
      waError.hidden = true;
      var used = await getWaUsageToday();
      if (used >= WA_DAILY_LIMIT) {
        waError.textContent = "Kamu sudah mencapai batas 10 pengingat WhatsApp hari ini. Coba lagi besok ya.";
        waError.hidden = false;
        return;
      }
      logWaUsage();
      var url = "https://wa.me/" + normalized + "?text=" + encodeURIComponent(buildWaMessageFor(waTargetDebt));
      closeWaModal();
      window.open(url, "_blank", "noopener");
    });
    waPhone.addEventListener("input", function () {
      waError.hidden = true;
    });
  }

  // ---------- navigasi: sidebar + bottom nav ----------
  (function initNav() {
  var links = Array.prototype.slice.call(document.querySelectorAll("[data-nav]"));
  if (!links.length) return;

  // Scroll-spy sederhana: tandai link aktif berdasarkan posisi section.
  // Visibility dicek saat scroll (bukan saat init) karena #premium vs
  // #premium-hub ditukar setelah userProfile dimuat.
  var sections = ["top", "catatan", "orang", "kalender", "berulang", "premium", "premium-hub"].map(function (id) {
    return { id: id, el: document.getElementById(id) };
  }).filter(function (s) { return s.el; });

  function setActive(id) {
    links.forEach(function (l) {
      l.classList.toggle("is-active", l.getAttribute("data-nav") === id);
    });
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var y = window.scrollY + 120;
      var current = "top";
      sections.forEach(function (s) {
        if (!s.el.hidden && s.el.offsetTop <= y) current = s.id;
      });
      setActive(current);
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Klik anchor: smooth scroll (CSS sudah handle), tutup sheet jika terbuka.
  links.forEach(function (l) {
    l.addEventListener("click", function () { closeMore(); });
  });
  })();

  // ---------- sheet "Lainnya" (mobile) ----------
  var moreSheet = document.querySelector("[data-more-sheet]");
  var moreBackdrop = document.querySelector("[data-more-backdrop]");

  function openMore() {
  if (!moreSheet || !moreBackdrop) return;
  moreSheet.hidden = false;
  moreBackdrop.hidden = false;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      moreSheet.classList.add("show");
      moreBackdrop.classList.add("show");
    });
  });
  document.body.style.overflow = "hidden";
  }

  function closeMore() {
  if (!moreSheet || !moreBackdrop || moreSheet.hidden) return;
  moreSheet.classList.remove("show");
  moreBackdrop.classList.remove("show");
  document.body.style.overflow = "";
  setTimeout(function () {
    moreSheet.hidden = true;
    moreBackdrop.hidden = true;
  }, 250);
  }

  var moreOpen = document.querySelector("[data-more-open]");
  if (moreOpen) moreOpen.addEventListener("click", openMore);
  var moreClose = document.querySelector("[data-more-close]");
  if (moreClose) moreClose.addEventListener("click", closeMore);
  if (moreBackdrop) moreBackdrop.addEventListener("click", closeMore);
  document.querySelectorAll("[data-more-link]").forEach(function (l) {
  l.addEventListener("click", closeMore);
  });
  document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") closeMore();
  });

  // Theme toggle lives in /assets/theme-toggle.js (single ☀️/🌙 header button).

  // Kalau halaman dikembalikan dari bfcache (mis. tombol back setelah logout),
  // validasi ulang session supaya data private tidak tampil basi.
  window.addEventListener("pageshow", function (e) {
  if (e.persisted) load();
  });

  initCalendar();
  // Hook untuk Split Bill (file terpisah): refresh data & tutup modal.
  window.NyangkutSplitBill = {
    refresh: function () { load(); },
    getDebts: function () { return allDebts || []; },
    closeAddModal: function () { closeModal(); },
    getClient: function () { return waitForClient(); },
  };
  load();
})();
