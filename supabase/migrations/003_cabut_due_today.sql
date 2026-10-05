-- ============================================================
-- Nyangkut migration 003 — cabut tipe reminder sementara due_today
-- Dijalankan SETELAH pipeline email terbukti jalan (verifikasi 2026-10-06).
--
-- URUTAN PENTING:
--   1. Hapus dulu semua baris due_today (pending maupun terkirim) —
--      kalau tidak, CHECK yang dikencangkan akan GAGAL karena
--      melanggar constraint pada data yang sudah ada.
--   2. Kencangkan lagi CHECK constraint ke dua tipe resmi:
--      before_due_1d (H-1) dan overdue_1d (H+1).
--   3. Hapus blok due_today di api/reminders/run.js, lalu redeploy.
--      (lihat CABUT-DUE-TODAY.md untuk potongan kodenya)
--
-- NOTE: constraint asli dari migration 002 bernama otomatis
-- `reminders_type_check`. Kalau migration pelonggaran kemarin memberi
-- nama lain, DROP di bawah akan no-op berkat IF EXISTS — jalankan
-- query discovery di bawah untuk tahu nama yang benar.
-- ============================================================

-- 1. Bersihkan semua baris due_today (sementara, aman dihapus).
DELETE FROM public.reminders WHERE type = 'due_today';

-- 2. Kencangkan CHECK kembali ke dua tipe resmi.
ALTER TABLE public.reminders DROP CONSTRAINT IF EXISTS reminders_type_check;
ALTER TABLE public.reminders
  ADD CONSTRAINT reminders_type_check
  CHECK (type IN ('before_due_1d', 'overdue_1d'));

-- Verifikasi: harusnya 0 baris non-resmi, dan constraint hanya 2 tipe.
-- SELECT type, count(*) FROM public.reminders GROUP BY type;
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.reminders'::regclass AND contype = 'c';
