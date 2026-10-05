// Split Bill Wizard — file terpisah dari dashboard.js
// Menggunakan window.NyangkutSplitBill untuk integrasi.
(function () {
  "use strict";

  // Helpers (duplikat minimal dari dashboard.js agar file mandiri).
  var Nyangkut = {
    escapeHtml: function (s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },
    rupiah: function (n) {
      var v = Math.round(Number(n) || 0);
      return "Rp" + v.toLocaleString("id-ID");
    },
    todayJakarta: function () {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
    },
    waitForClient: async function () {
      // Ambil Supabase client dari dashboard.js via global.
      if (window.NyangkutSplitBill && window.NyangkutSplitBill.getClient) {
        return window.NyangkutSplitBill.getClient();
      }
      // Fallback: cari dari window.supabase jika ada.
      return null;
    },
  };

  // ============ Split Bill Wizard ============
  // Flow: Detail (1) -> Peserta (2) -> Cara Bagi (3) -> Review (4) -> Success (5)
  // Atomic creation via RPC split_bill_create(). Tidak ada tabel baru.
  var splitState = null;

  function splitReset() {
    splitState = {
      step: 1,
      billName: "",
      total: 0,
      date: Nyangkut.todayJakarta(),
      dueDate: null,
      people: [{ name: "Saya", isSelf: true }],
      method: "equal",
      customAmounts: {}, // name -> amount
      creating: false,
    };
  }

  function openSplitBill() {
    var m = document.querySelector("[data-split-modal]");
    if (!m) return;
    splitReset();
    // Set default tanggal hari ini.
    var dateInput = document.getElementById("sb-date");
    if (dateInput) dateInput.value = splitState.date;
    splitGotoStep(1);
    m.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { m.classList.add("show"); });
    });
    document.body.style.overflow = "hidden";
  }

  function closeSplitBill() {
    var m = document.querySelector("[data-split-modal]");
    if (!m) return;
    m.classList.remove("show");
    setTimeout(function () {
      if (!m.classList.contains("show")) m.hidden = true;
    }, 200);
    document.body.style.overflow = "";
  }

  function splitGotoStep(n) {
    splitState.step = n;
    // Update progress.
    document.querySelectorAll("[data-split-progress] .sp-step").forEach(function (el) {
      var sn = parseInt(el.getAttribute("data-sp"), 10);
      el.classList.toggle("is-active", sn === n);
    });
    // Show/hide steps.
    document.querySelectorAll("[data-split-step]").forEach(function (el) {
      var sn = parseInt(el.getAttribute("data-split-step"), 10);
      el.hidden = (sn !== n);
    });
    // Actions.
    var actions = document.querySelector("[data-split-actions]");
    var successActions = document.querySelector("[data-split-success-actions]");
    if (actions) actions.hidden = (n === 5);
    if (successActions) successActions.hidden = (n !== 5);
    // Back button.
    var backBtn = document.querySelector("[data-split-back]");
    if (backBtn) backBtn.hidden = (n === 1 || n === 5);
    // Next button label.
    var nextBtn = document.querySelector("[data-split-next]");
    if (nextBtn) {
      if (n === 4) nextBtn.textContent = "Buat Catatan";
      else nextBtn.textContent = "Lanjut";
      nextBtn.disabled = false;
    }
    // Render per-step.
    if (n === 2) splitRenderPeople();
    if (n === 3) splitRenderAmounts();
    if (n === 4) splitRenderReview();
  }

  // Deterministic rounding: bagi rata dengan remainder ke peserta awal.
  // Contoh: 100000 / 3 = [33334, 33333, 33333]. Total selalu tepat.
  function splitCalcEqual(total, count) {
    var base = Math.floor(total / count);
    var remainder = total - (base * count);
    var result = [];
    for (var i = 0; i < count; i++) {
      result.push(base + (i < remainder ? 1 : 0));
    }
    return result;
  }

  function splitParseRupiah(str) {
    if (!str) return 0;
    var cleaned = String(str).replace(/[^0-9]/g, "");
    var n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
  }

  function splitGetUserName() {
    // Ambil nama user dari dashboard jika ada, fallback "Saya".
    try {
      var el = document.querySelector("[data-user-name]");
      var name = el ? el.textContent.trim() : "";
      if (name && name !== "Teman") return name;
    } catch (e) {}
    return "Saya";
  }

  function splitRenderPeople() {
    var ul = document.querySelector("[data-sb-people]");
    if (!ul) return;

    var userName = splitGetUserName();
    var others = splitState.people.filter(function (p) { return !p.isSelf; });

    // Saya card (non-editable).
    var html = '<li class="split-person-card is-self">' +
      '<span class="sp-avatar" aria-hidden="true">👤</span>' +
      '<span class="sp-info"><span class="sp-name">' + Nyangkut.escapeHtml(userName) + '</span>' +
      '<span class="sp-sub">Kamu · Bayar dulu</span></span>' +
      '<span class="sp-badge">Payer</span>' +
      "</li>";

    // Others as cards.
    others.forEach(function (p) {
      var idx = splitState.people.indexOf(p);
      html += '<li class="split-person-card">' +
        '<span class="sp-avatar" aria-hidden="true">👤</span>' +
        '<span class="sp-info"><span class="sp-name">' + Nyangkut.escapeHtml(p.name) + "</span></span>" +
        '<button type="button" class="btn-icon sp-remove" data-sb-remove-person="' + idx + '" aria-label="Hapus ' + Nyangkut.escapeHtml(p.name) + '">✕</button>' +
        "</li>";
    });

    ul.innerHTML = html;

    // Bind remove.
    ul.querySelectorAll("[data-sb-remove-person]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.getAttribute("data-sb-remove-person"), 10);
        splitState.people.splice(idx, 1);
        splitRenderPeople();
        splitUpdateStep2State();
      });
    });

    splitUpdateStep2State();
  }

  function splitUpdateStep2State() {
    var others = splitState.people.filter(function (p) { return !p.isSelf; });
    var emptyEl = document.querySelector("[data-sb-empty]");
    var addWrap = document.querySelector("[data-sb-add-wrap]");
    var addBtn = document.querySelector("[data-sb-add-person]");
    var nextBtn = document.querySelector("[data-split-next]");

    if (emptyEl) emptyEl.hidden = others.length > 0;
    // Sembunyikan tombol "+ Tambah orang" saat form add terbuka.
    if (addBtn) addBtn.hidden = addWrap && !addWrap.hidden;

    // Lanjut disabled jika belum ada peserta lain.
    if (nextBtn && splitState.step === 2) {
      var canProceed = others.length >= 1;
      nextBtn.disabled = !canProceed;
      nextBtn.style.opacity = canProceed ? "1" : "0.5";
    }
  }

  function splitShowAddForm() {
    var wrap = document.querySelector("[data-sb-add-wrap]");
    var btn = document.querySelector("[data-sb-add-person]");
    var input = document.getElementById("sb-person-input");
    if (wrap) {
      wrap.hidden = false;
      var errEl = wrap.querySelector("[data-sb-add-error]");
      if (errEl) errEl.hidden = true;
    }
    if (btn) btn.hidden = true;
    if (input) {
      input.value = "";
      setTimeout(function () { input.focus(); }, 100);
    }
    splitUpdateStep2State();
  }

  function splitHideAddForm() {
    var wrap = document.querySelector("[data-sb-add-wrap]");
    var btn = document.querySelector("[data-sb-add-person]");
    if (wrap) wrap.hidden = true;
    if (btn) btn.hidden = false;
    splitUpdateStep2State();
  }

  function splitConfirmAdd() {
    var input = document.getElementById("sb-person-input");
    var wrap = document.querySelector("[data-sb-add-wrap]");
    var errEl = wrap ? wrap.querySelector("[data-sb-add-error]") : null;
    var name = input ? input.value.trim() : "";

    function showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    }

    if (!name) {
      showErr("Nama orang wajib diisi.");
      return;
    }
    // Duplicate check (case-insensitive + trim).
    var key = name.toLowerCase();
    var dup = splitState.people.some(function (p) {
      return !p.isSelf && p.name.trim().toLowerCase() === key;
    });
    // Juga cegah duplikat dengan nama user sendiri.
    var userName = splitGetUserName().toLowerCase();
    if (dup || key === userName || key === "saya") {
      showErr("Orang ini sudah ditambahkan.");
      return;
    }
    if (splitState.people.length >= 20) {
      showErr("Maksimal 20 peserta.");
      return;
    }

    splitState.people.push({ name: name, isSelf: false });
    splitHideAddForm();
    splitRenderPeople();
  }

  function splitRenderAmounts() {
    var ul = document.querySelector("[data-sb-amounts]");
    if (!ul) return;
    var userName = splitGetUserName();

    if (splitState.method === "equal") {
      var shares = splitCalcEqual(splitState.total, splitState.people.length);
      ul.innerHTML = splitState.people.map(function (p, idx) {
        var displayName = p.isSelf ? userName : Nyangkut.escapeHtml(p.name);
        var label = p.isSelf ? "Bagian kamu" : "Harus bayar";
        return '<li class="split-amount-card">' +
          '<span class="sp-avatar" aria-hidden="true">👤</span>' +
          '<span class="sp-info"><span class="sp-name">' + displayName + '</span>' +
          '<span class="sp-sub">' + label + "</span></span>" +
          '<span class="sp-amount-static">' + Nyangkut.rupiah(shares[idx]) + "</span>" +
          "</li>";
      }).join("");
      var check = document.querySelector("[data-sb-total-check]");
      if (check) check.hidden = true;
      var hint = document.querySelector("[data-sb-custom-hint]");
      if (hint) hint.hidden = true;
    } else {
      // Custom: input per orang.
      ul.innerHTML = splitState.people.map(function (p, idx) {
        var displayName = p.isSelf ? userName : Nyangkut.escapeHtml(p.name);
        var label = p.isSelf ? "Bagian kamu" : "Harus bayar";
        var ariaLabel = p.isSelf ? "Bagian " + userName : "Bagian " + p.name;
        var val = splitState.customAmounts[p.name] || "";
        return '<li class="split-amount-card">' +
          '<span class="sp-avatar" aria-hidden="true">👤</span>' +
          '<span class="sp-info"><span class="sp-name">' + displayName + '</span>' +
          '<span class="sp-sub">' + label + "</span></span>" +
          '<div class="amount-wrap split-amount-input"><span class="amount-prefix" aria-hidden="true">Rp</span>' +
          '<input type="text" inputmode="numeric" data-sb-amount-idx="' + idx + '" placeholder="0" value="' + Nyangkut.escapeHtml(String(val)) + '" aria-label="' + Nyangkut.escapeHtml(ariaLabel) + '" />' +
          "</div></li>";
      }).join("");
      ul.querySelectorAll("[data-sb-amount-idx]").forEach(function (input) {
        input.addEventListener("input", function () {
          var idx = parseInt(input.getAttribute("data-sb-amount-idx"), 10);
          var p = splitState.people[idx];
          splitState.customAmounts[p.name] = splitParseRupiah(input.value);
          // Format display.
          var v = splitState.customAmounts[p.name];
          input.value = v > 0 ? v.toLocaleString("id-ID") : "";
          splitUpdateTotalCheck();
        });
        // Format on blur.
        input.addEventListener("blur", function () {
          var idx = parseInt(input.getAttribute("data-sb-amount-idx"), 10);
          var p = splitState.people[idx];
          var v = splitState.customAmounts[p.name] || 0;
          input.value = v > 0 ? v.toLocaleString("id-ID") : "";
        });
      });
      // Custom hint dengan total dinamis.
      var hintEl = document.querySelector("[data-sb-custom-hint]");
      if (hintEl) {
        var ht = hintEl.querySelector("[data-sb-hint-total]");
        if (ht) ht.textContent = Nyangkut.rupiah(splitState.total);
        hintEl.hidden = false;
      }
      splitUpdateTotalCheck();
    }
  }

  function splitUpdateTotalCheck() {
    var check = document.querySelector("[data-sb-total-check]");
    if (!check) return;
    check.hidden = false;
    var sum = 0;
    splitState.people.forEach(function (p) {
      sum += splitState.customAmounts[p.name] || 0;
    });
    var sumEl = check.querySelector("[data-sb-sum]");
    var targetEl = check.querySelector("[data-sb-target]");
    var diffEl = check.querySelector("[data-sb-diff]");
    var statusEl = check.querySelector("[data-sb-status]");
    var progressEl = check.querySelector("[data-sb-progress]");
    if (sumEl) sumEl.textContent = Nyangkut.rupiah(sum);
    if (targetEl) targetEl.textContent = Nyangkut.rupiah(splitState.total);

    var diff = splitState.total - sum;
    check.classList.remove("is-success", "is-over");
    if (progressEl) {
      var pct = splitState.total > 0 ? Math.min(100, Math.round((sum / splitState.total) * 100)) : 0;
      progressEl.style.width = pct + "%";
    }

    if (diffEl) {
      if (diff === 0 && sum > 0) {
        diffEl.textContent = "✓ Total sudah pas.";
        check.classList.add("is-success");
        if (statusEl) statusEl.textContent = "✓";
      } else if (diff > 0) {
        diffEl.textContent = "Kurang " + Nyangkut.rupiah(diff) + ".";
        if (statusEl) statusEl.textContent = "";
      } else {
        diffEl.textContent = "Kelebihan " + Nyangkut.rupiah(-diff) + ".";
        check.classList.add("is-over");
        if (statusEl) statusEl.textContent = "!";
      }
      diffEl.hidden = false;
    }
    // Disable next jika belum pas.
    var nextBtn = document.querySelector("[data-split-next]");
    if (nextBtn && splitState.step === 3 && splitState.method === "custom") {
      nextBtn.disabled = (sum !== splitState.total);
      nextBtn.style.opacity = (sum !== splitState.total) ? "0.5" : "1";
    }
    // "Isi sisa" helper: hanya jika tepat 1 yang kosong dan remaining > 0.
    splitUpdateFillRest(diff);
  }

  function splitUpdateFillRest(diff) {
    // Hapus helper lama.
    var old = document.querySelector("[data-sb-fill-rest]");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    if (diff <= 0) return;
    var empties = splitState.people.filter(function (p) {
      return !(splitState.customAmounts[p.name] > 0);
    });
    if (empties.length !== 1) return;
    var p = empties[0];
    var ul = document.querySelector("[data-sb-amounts]");
    if (!ul) return;
    var idx = splitState.people.indexOf(p);
    var rows = ul.querySelectorAll(".split-amount-card");
    if (idx < 0 || idx >= rows.length) return;

    var helper = document.createElement("div");
    helper.className = "split-fill-rest";
    helper.setAttribute("data-sb-fill-rest", "");
    helper.innerHTML = '<span>Sisa ' + Nyangkut.rupiah(diff) + '</span>' +
      '<button type="button" class="btn-ghost btn-sm" data-sb-fill-btn>Isi sisa</button>';
    rows[idx].appendChild(helper);

    helper.querySelector("[data-sb-fill-btn]").addEventListener("click", function () {
      // Jangan override amount yang sudah diisi.
      if (splitState.customAmounts[p.name] > 0) return;
      splitState.customAmounts[p.name] = diff;
      // Update input display.
      var input = rows[idx].querySelector("[data-sb-amount-idx]");
      if (input) input.value = diff.toLocaleString("id-ID");
      splitUpdateTotalCheck();
    });
  }

  function splitGetShares() {
    // Return array of {name, amount} untuk non-self participants.
    var others = splitState.people.filter(function (p) { return !p.isSelf; });
    if (splitState.method === "equal") {
      var shares = splitCalcEqual(splitState.total, splitState.people.length);
      // Map shares ke people (termasuk self di index 0).
      return others.map(function (p) {
        var idx = splitState.people.indexOf(p);
        return { name: p.name.trim(), amount: shares[idx] };
      });
    } else {
      return others.map(function (p) {
        return { name: p.name.trim(), amount: splitState.customAmounts[p.name] || 0 };
      });
    }
  }

  function splitValidateStep(n) {
    var errEl = document.querySelector("[data-split-error]");
    function showErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      return false;
    }
    function hideErr() { if (errEl) errEl.hidden = true; }

    if (n === 1) {
      var name = document.getElementById("sb-name").value.trim();
      var total = splitParseRupiah(document.getElementById("sb-total").value);
      if (!name) return showErr("Nama tagihan perlu diisi.");
      if (total <= 0) return showErr("Total tagihan harus lebih dari Rp0.");
      splitState.billName = name;
      splitState.total = total;
      splitState.date = document.getElementById("sb-date").value || todayJakarta();
      splitState.dueDate = document.getElementById("sb-due").value || null;
      hideErr();
      return true;
    }
    if (n === 2) {
      var others = splitState.people.filter(function (p) { return !p.isSelf; });
      if (others.length < 1) return showErr("Tambah minimal 1 orang selain kamu.");
      // Cek nama kosong & duplicate.
      var names = {};
      for (var i = 0; i < others.length; i++) {
        var nm = others[i].name.trim();
        if (!nm) return showErr("Nama peserta tidak boleh kosong.");
        var key = nm.toLowerCase();
        if (names[key]) return showErr("Nama '" + nm + "' duplikat.");
        names[key] = true;
      }
      if (splitState.people.length > 20) return showErr("Maksimal 20 peserta.");
      hideErr();
      return true;
    }
    if (n === 3) {
      if (splitState.method === "custom") {
        var sum = 0;
        splitState.people.forEach(function (p) {
          sum += splitState.customAmounts[p.name] || 0;
        });
        if (sum !== splitState.total) return showErr("Total pembagian belum sesuai.");
        // Cek tidak ada yang 0 untuk non-self? Boleh 0, tapi harus >0 untuk debt.
        var shares = splitGetShares();
        for (var j = 0; j < shares.length; j++) {
          if (shares[j].amount <= 0) return showErr("Nominal " + shares[j].name + " harus lebih dari Rp0.");
        }
      }
      hideErr();
      return true;
    }
    return true;
  }

  function splitRenderReview() {
    var div = document.querySelector("[data-sb-review]");
    if (!div) return;
    var shares = splitGetShares();
    var totalBack = shares.reduce(function (s, x) { return s + x.amount; }, 0);

    var html = '<div class="split-review-head">' +
      "<h3>" + Nyangkut.escapeHtml(splitState.billName) + "</h3>" +
      "<p>Total: " + Nyangkut.rupiah(splitState.total) + " · " + splitState.people.length + " orang</p>" +
      (splitState.dueDate ? "<p>Jatuh tempo: " + Nyangkut.escapeHtml(splitState.dueDate) + "</p>" : "<p>Tanpa jatuh tempo</p>") +
      "</div>";

    // Self.
    var selfShare = splitState.method === "equal"
      ? splitCalcEqual(splitState.total, splitState.people.length)[0]
      : (splitState.customAmounts["Saya"] || 0);
    html += '<div class="split-review-item">' +
      '<div><div class="r-name">Saya</div><div class="r-sub">Bagian kamu</div></div>' +
      '<div class="r-amount">' + Nyangkut.rupiah(selfShare) + "</div></div>";

    // Others.
    shares.forEach(function (s) {
      html += '<div class="split-review-item">' +
        '<div><div class="r-name">' + Nyangkut.escapeHtml(s.name) + '</div><div class="r-sub">Masih harus bayar</div></div>' +
        '<div class="r-amount">' + Nyangkut.rupiah(s.amount) + "</div></div>";
    });

    html += '<div class="split-review-total">' +
      "Uang yang masih harus kembali ke kamu<br><strong>" + Nyangkut.rupiah(totalBack) + "</strong></div>";

    div.innerHTML = html;

    // Update CTA label.
    var nextBtn = document.querySelector("[data-split-next]");
    if (nextBtn) nextBtn.textContent = "Buat " + shares.length + " Catatan";
  }

  async function splitCreate() {
    if (splitState.creating) return;
    splitState.creating = true;
    var nextBtn = document.querySelector("[data-split-next]");
    if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = "Menyimpan…"; }

    try {
      var client = await Nyangkut.waitForClient();
      if (!client) throw new Error("no-client");

      var shares = splitGetShares();
      // Format untuk RPC: array of {person_name, amount, note, due_date}.
      var items = shares.map(function (s) {
        return {
          person_name: s.name,
          amount: s.amount,
          note: null, // note di-format di RPC dari bill name
          due_date: splitState.dueDate,
        };
      });

      var res = await client.rpc("split_bill_create", {
        p_items: items,
        p_bill_name: splitState.billName,
      });

      if (res.error) throw res.error;

      // RPC (migration 009) mengembalikan [{debt_id, share_token}] seurutan
      // dengan items. Gabungkan dengan data share client-side.
      var rows = res.data;
      var valid =
        Array.isArray(rows) &&
        rows.length === shares.length &&
        rows.every(function (r) { return r && typeof r.share_token === "string" && r.share_token.length > 0; });
      var links = shares.map(function (s, i) {
        return {
          name: s.name,
          amount: s.amount,
          token: valid ? rows[i].share_token : null,
        };
      });

      // Success: tampilkan step 5.
      splitShowSuccess(links);
      // Refresh dashboard data.
      if (window.NyangkutSplitBill) window.NyangkutSplitBill.refresh();

    } catch (e) {
      var errEl = document.querySelector("[data-split-error]");
      var msg = "Terjadi kendala saat membuat catatan. Data kamu belum berubah.";
      if (e && e.message) {
        if (e.message.includes("FREE_LIMIT_REACHED")) {
          var activeCount = (window.NyangkutSplitBill ? window.NyangkutSplitBill.getDebts() : []).filter(function (d) {
            return d.status !== "paid";
          }).length;
          var need = splitGetShares().length;
          var remaining = Math.max(0, 10 - activeCount);
          msg = "Split Bill ini akan membuat " + need + " catatan, tapi kuota catatan kamu tinggal " + remaining + ".";
        } else if (e.message.includes("NOT_AUTHENTICATED")) {
          msg = "Sesi kamu berakhir. Silakan login ulang.";
        }
      }
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      // Kembali ke step 4.
      splitGotoStep(4);
    } finally {
      splitState.creating = false;
      if (nextBtn) { nextBtn.disabled = false; }
    }
  }

  function splitShowSuccess(links) {
    var totalBack = links.reduce(function (s, x) { return s + x.amount; }, 0);
    var sub = document.querySelector("[data-sb-success-sub]");
    if (sub) sub.textContent = links.length + " catatan berhasil dibuat.";
    var ul = document.querySelector("[data-sb-success-list]");
    if (ul) {
      ul.innerHTML = links.map(function (s, i) {
        var waBtn = s.token
          ? '<button type="button" class="btn-wa-sm" data-sb-share-wa="' + i + '">💬 Kirim via WhatsApp</button>'
          : "";
        return (
          '<li class="split-share-row">' +
          '<div class="split-share-info"><span class="split-name">' + Nyangkut.escapeHtml(s.name) + "</span>" +
          '<span class="split-share-amount">' + Nyangkut.rupiah(s.amount) + "</span></div>" +
          waBtn +
          "</li>"
        );
      }).join("");
      // Bind per-participant WA buttons.
      ul.querySelectorAll("[data-sb-share-wa]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          splitShareWAFor(links[parseInt(btn.getAttribute("data-sb-share-wa"), 10)]);
        });
      });
    }
    var totalEl = document.querySelector("[data-sb-success-total]");
    if (totalEl) totalEl.textContent = Nyangkut.rupiah(totalBack);
    // Simpan untuk referensi.
    splitState.lastLinks = links;
    splitGotoStep(5);
  }

  // Share Bill Link: participant-specific, via WhatsApp.
  // BUKAN WA Tagih: tidak memakai kuota 10/hari, tidak mengirim reminder.
  // User yang menekan tombol; tidak ada auto-send.
  function splitShareWAFor(link) {
    if (!link || !link.token) return;
    var url = "https://www.nyangkut.id/s/" + link.token;
    var lines = [
      "Hai " + link.name + " 👋",
      "",
      "Ini bagian kamu dari " + (splitState.billName || "Split Bill") + ":",
      "",
      Nyangkut.rupiah(link.amount),
      "",
      "Lihat detailnya di:",
      url,
      "",
      "— nyangkut.id",
    ];
    var waUrl = "https://wa.me/?text=" + encodeURIComponent(lines.join("\n"));
    window.open(waUrl, "_blank");
  }

  // Bind Split Bill events (dipanggil sekali saat init).
  function initSplitBill() {
    // Mode selector di Add Catatan modal.
    document.querySelectorAll("[data-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("[data-mode]").forEach(function (b) {
          b.classList.remove("is-selected");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("is-selected");
        btn.setAttribute("aria-checked", "true");
        var mode = btn.getAttribute("data-mode");
        var biasaFields = document.querySelector("[data-biasa-fields]");
        if (mode === "split") {
          // Tutup modal biasa, buka Split Bill wizard.
          if (window.NyangkutSplitBill) window.NyangkutSplitBill.closeAddModal();
          setTimeout(openSplitBill, 250);
          // Reset mode ke biasa untuk buka berikutnya.
          setTimeout(function () {
            document.querySelectorAll("[data-mode]").forEach(function (b) {
              var isBiasa = b.getAttribute("data-mode") === "biasa";
              b.classList.toggle("is-selected", isBiasa);
              b.setAttribute("aria-checked", isBiasa ? "true" : "false");
            });
          }, 500);
        }
      });
    });

    // Split modal close.
    document.querySelectorAll("[data-split-close],[data-split-close2],[data-split-close3]").forEach(function (btn) {
      btn.addEventListener("click", closeSplitBill);
    });
    var splitModal = document.querySelector("[data-split-modal]");
    if (splitModal) {
      splitModal.addEventListener("click", function (e) {
        if (e.target === splitModal) closeSplitBill();
      });
    }

    // Navigation.
    var nextBtn = document.querySelector("[data-split-next]");
    if (nextBtn) nextBtn.addEventListener("click", function () {
      if (splitState.step === 4) {
        splitCreate();
      } else {
        if (splitValidateStep(splitState.step)) splitGotoStep(splitState.step + 1);
      }
    });
    var backBtn = document.querySelector("[data-split-back]");
    if (backBtn) backBtn.addEventListener("click", function () {
      if (splitState.step > 1) splitGotoStep(splitState.step - 1);
    });

    // Step 1: clear due.
    var clearDue = document.querySelector("[data-sb-clear-due]");
    if (clearDue) clearDue.addEventListener("click", function () {
      document.getElementById("sb-due").value = "";
    });

    // Step 2: add person (inline form).
    var addPerson = document.querySelector("[data-sb-add-person]");
    if (addPerson) addPerson.addEventListener("click", splitShowAddForm);

    var confirmAdd = document.querySelector("[data-sb-confirm-add]");
    if (confirmAdd) confirmAdd.addEventListener("click", splitConfirmAdd);

    var personInput = document.getElementById("sb-person-input");
    if (personInput) {
      personInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          splitConfirmAdd();
        }
      });
    }

    // Step 3: method selector.
    document.querySelectorAll("[data-split-method]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("[data-split-method]").forEach(function (b) {
          b.classList.remove("is-selected");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("is-selected");
        btn.setAttribute("aria-checked", "true");
        splitState.method = btn.getAttribute("data-split-method");
        splitRenderAmounts();
      });
    });

    // WA share per-participant di-bind saat success screen di-render.
  }


  // Init saat DOM ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSplitBill);
  } else {
    initSplitBill();
  }
})();
