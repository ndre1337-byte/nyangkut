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
  }

  function statusLabel(s) {
    if (s === "paid") return "Lunas";
    if (s === "partial") return "Partial";
    return "Belum bayar";
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
    cards.overdue.textContent = rupiah(sum(overdue));
    cards.dueWeek.textContent = rupiah(sum(dueWeek));

    if (!debts.length) {
      showState("empty");
      return;
    }

    txList.innerHTML = "";
    debts.forEach(function (d) {
      var a = document.createElement("a");
      a.className = "tx-item";
      a.href = "/debt/?id=" + encodeURIComponent(d.id);

      var rem = remaining(d);
      var dirChip = d.direction === "receivable"
        ? '<span class="chip chip-dir-receivable">Nyangkut</span>'
        : '<span class="chip chip-dir-payable">Utang lo</span>';
      var statusChip = '<span class="chip chip-status-' + d.status + '">' + statusLabel(d.status) + "</span>";

      var remLine = d.status === "paid"
        ? '<p class="tx-remaining is-paid">Lunas, tidak ada sisa</p>'
        : '<p class="tx-remaining">Sisa ' + rupiah(rem) + "</p>";

      var noteLine = d.note ? '<p class="tx-note">“' + escapeHtml(d.note) + "”</p>" : "";

      a.innerHTML =
        '<div class="tx-row-top"><p class="tx-name">' + escapeHtml(d.person_name) + "</p>" + statusChip + "</div>" +
        '<p class="tx-meta">' + dirChip + " · " + rupiah(d.amount) + "</p>" +
        remLine +
        '<div class="tx-foot"><span>📅 ' + fmtDue(d.due_date) + "</span></div>" +
        noteLine;
      txList.appendChild(a);
    });
    showState("list");
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

      // Nama dari tabel profiles (fallback ke metadata auth).
      var name = session.user.name || "Teman";
      try {
        var prof = await client.from("profiles").select("name").single();
        if (prof.data && prof.data.name) name = prof.data.name;
      } catch (e) { /* pakai fallback */ }
      var nameEl = document.querySelector("[data-user-name]");
      if (nameEl) nameEl.textContent = name;

      // RLS otomatis membatasi hanya baris milik user ini.
      var res = await client
        .from("debts")
        .select("id, direction, person_name, amount, paid_amount, status, note, due_date, created_at")
        .order("created_at", { ascending: false });
      if (res.error) throw res.error;

      renderDebts(res.data || []);
    } catch (err) {
      console.error("[Nyangkut] dashboard gagal memuat:", err);
      showState("error");
    }
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

  function openModal() { if (modal) modal.hidden = false; }

  function closeModal() {
    if (modal) modal.hidden = true;
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
    if (msg.includes("jwt") || msg.includes("auth") || msg.includes("permission") || msg.includes("policy")) {
      return "Sesi lo bermasalah. Coba keluar lalu masuk lagi ya.";
    }
    return "Gagal menyimpan. Periksa koneksi lo lalu coba lagi.";
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
    });
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

  load();
})();
