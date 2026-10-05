# Nyangkut — Database Schema v1 (MVP)

> Status: **RANCANGAN — belum dijalankan.** Migration siap di `migrations/001_nyangkut_mvp.sql`.
> Cara menjalankan: copy isi file → Supabase Dashboard > SQL Editor > New query > Run (sekali saja).

## A. Diagram relationship

```
┌──────────────────┐
│    auth.users    │  (milik Supabase Auth, jangan diutak-atik)
└────────┬─────────┘
         │ 1 : 1  (trigger on_auth_user_created)
         ▼
┌──────────────────┐
│     profiles     │
│  id  PK + FK     │
│  name            │
└──────────────────┘

┌──────────────────┐        ┌──────────────────┐
│      debts       │── 1:N ─▶│     payments     │
│  id  PK          │        │  id  PK           │
│  user_id  FK     │        │  debt_id  FK      │
│  direction       │        │  amount           │
│  person_name     │        │  paid_at          │
│  amount          │        │  note             │
│  paid_amount ◀───┘        └──────────────────┘
│  status     │ trigger trg_payments_recalc
│  note       │ (hitung ulang otomatis)
│  due_date   │
└──────────────────┘

RLS aktif di profiles, debts, payments:
hanya baris milik auth.uid() yang bisa dibaca/diubah.
```

## B. Daftar tabel

| Tabel      | Fungsi                                                    |
|------------|-----------------------------------------------------------|
| `profiles`  | Profil user (1 baris per akun), dibuat otomatis saat register |
| `debts`    | Inti aplikasi: catatan uang nyangkut, dua arah (piutang & utang) |
| `payments` | Riwayat pembayaran, termasuk pembayaran sebagian / cicilan |

## C. Kolom setiap tabel

**profiles**
- `id` uuid PK, FK → auth.users(id) — id user, sama dengan id auth
- `name` text NOT NULL — nama tampilan
- `created_at` / `updated_at` timestamptz

**debts**
- `id` uuid PK — id unik catatan
- `user_id` uuid NOT NULL, FK → auth.users(id), default `auth.uid()` — pemilik
- `direction` text — `'receivable'` (piutang: uang orang lain yg jadi hak user) atau `'payable'` (utang: utang user ke orang lain)
- `person_name` text NOT NULL — nama orang (tidak boleh kosong)
- `amount` numeric(14,2) > 0 — nominal total
- `paid_amount` numeric(14,2) default 0 — total terbayar, **diisi otomatis trigger**
- `status` text — `'unpaid'` / `'partial'` / `'paid'`, **diisi otomatis trigger**
- `note` text, nullable — catatan / alasan
- `due_date` date, nullable — jatuh tempo
- `created_at` / `updated_at` timestamptz

**payments**
- `id` uuid PK
- `debt_id` uuid NOT NULL, FK → debts(id) ON DELETE CASCADE — catatan induk
- `amount` numeric(14,2) > 0 — nominal pembayaran ini
- `paid_at` date default hari ini — tanggal bayar (bisa diisi manual untuk pembayaran lampau)
- `note` text, nullable — mis. "via transfer BCA"
- `created_at` timestamptz

## D. Penjelasan fungsi setiap tabel

- **profiles** — data profil milik aplikasi (terpisah dari `auth.users` yang dikelola Supabase).
  Dibuat otomatis oleh trigger setiap ada user baru, nama diambil dari form register.
- **debts** — satu-satunya tabel catatan. Satu tabel untuk dua arah supaya query,
  RLS, dan kode aplikasi tidak dobel. Kolom `paid_amount` + `status` adalah data
  turunan yang dirawat trigger dari `payments`, jadi dashboard bisa baca langsung
  tanpa menghitung ulang.
- **payments** — setiap pembayaran (penuh maupun sebagian) adalah satu baris.
  Riwayat lengkap tersimpan di sini; trigger menjumlahkannya ke `debts.paid_amount`.
- **Status tidak pernah stale**: trigger `trg_debts_recalc_status` menghitung ulang
  `status` setiap `debts.amount` berubah (BEFORE UPDATE). Menurunkan `amount` di
  bawah `paid_amount` ditolak oleh CHECK — konsisten dengan aturan no-overpayment.

## E. RLS policy

Prinsip: **user hanya menyentuh data miliknya sendiri** (`auth.uid()`).

| Tabel | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| profiles | id milik sendiri | id milik sendiri | id milik sendiri | — (tidak bisa hapus) |
| debts | `user_id` milik sendiri | `user_id` milik sendiri | `user_id` milik sendiri | `user_id` milik sendiri |
| payments | debt induk milik sendiri (via `EXISTS`) | debt induk milik sendiri | debt induk milik sendiri | debt induk milik sendiri |

Catatan:
- `payments` tidak punya kolom `user_id`; kepemilikan dicek lewat `debts` induk,
  jadi tidak mungkin ada payment nyangkut ke utang orang lain.
- Role `anon` tidak diberi akses apa pun; hanya `authenticated`.
- `service_role` (dipakai Supabase internal) bypass RLS — normal.

## F. SQL migration

File siap jalan: `migrations/001_nyangkut_mvp.sql` (60 statements, lolos parse check).
Isi: 5 function, 3 tabel, 4 index, 6 trigger, RLS + 12 policy + column-level grants.

## G. Keputusan & risiko — perlu persetujuan Jaing

1. **Satu tabel `debts` untuk piutang + utang** (bedakan via `direction`).
   Rekomendasi: ya — query & RLS lebih simpel. Alternatif: dua tabel terpisah (lebih eksplisit, tapi dobel semua).
2. **`paid_amount` + `status` 100% database-controlled** (bukan convention).
   - INSERT: trigger `trg_debts_force_initial` selalu menimpa jadi 0/`unpaid`.
   - UPDATE: grant kolom — client tidak punya hak UPDATE atas kedua kolom itu.
   - Satu-satunya penulis: trigger `recalc_debt_payment` (SECURITY DEFINER).
   - Function trigger di-REVOKE dari PUBLIC (tidak bisa dipanggil via RPC).
3. **Bayar melebihi nominal DITOLAK** (`CHECK paid_amount <= amount`).
   Perlu konfirmasi: apakah kasus "bayar kelebihan" perlu didukung? Kalau ya, constraint ini dicabut.
4. **Nama orang = teks bebas** (bukan tabel kontak). Dua orang bernama sama ("Budi") akan tercatat terpisah tanpa pengenal unik. Kontak terstruktur + nomor HP ditambahkan nanti saat fitur WhatsApp (tabel `contacts`, tanpa merombak tabel ini).
5. **Hapus utang = hapus permanen**, riwayat payment-nya ikut hilang (CASCADE).
   Alternatif: soft delete (kolom `deleted_at`). Rekomendasi MVP: hard delete cukup.
6. **Tabel `profiles` + trigger auto-create.** Standar Supabase; rumah untuk nama & pengaturan user ke depan.
7. **Enum pakai TEXT + CHECK** (bukan tipe ENUM native) supaya tambah nilai baru lebih gampang.

## H. Jalur pengembangan fitur berikutnya (tanpa merombak tabel inti)

- **Reminder** → tabel baru `reminders` (debt_id FK, remind_at, channel, sent_at). Tabel `debts` tidak berubah.
- **Recurring** → tabel baru `recurring_rules` (template + frekuensi); aplikasi generate baris `debts` dari rule. Tabel `debts` tidak berubah.
- **Split bill** → tabel baru `split_groups` + tambah **satu kolom nullable** `debts.split_group_id`. Bersifat aditif, bukan rombakan.
- **WhatsApp reminder** → tabel baru `contacts` (nama + nomor HP) + tambah **satu kolom nullable** `debts.contact_id`. Bersifat aditif.
