-- ============================================================
-- Nyangkut migration 007 — Advanced Reminder (Premium)
--
-- 1. debts.reminder_offsets (integer[]): konfigurasi preset reminder
--    per catatan. NULL = basic (H-1 + H+1). Contoh: '{-7,-1,0,1}'.
--    Offset negatif = hari SEBELUM jatuh tempo, 0 = Hari H,
--    positif = hari SETELAH jatuh tempo.
-- 2. recurring_rules.reminder_offsets: config di template, diwariskan
--    ke debt saat generator membuat transaksi bulanan.
-- 3. Perluas CHECK reminders.type: tambah before_due_7d, before_due_3d.
--    due_today (Hari H) yang tadinya sementara dijadikan permanen
--    sebagai preset Premium. Migration 003_cabut_due_today.sql
--    menjadi obsolete dan TIDAK boleh dijalankan.
--
-- Enforcement Free vs Premium ada di server (api/reminders/run.js),
-- bukan di constraint: cron hanya memakai config untuk user premium.
-- ============================================================

-- 1. Kolom config di debts.
ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS reminder_offsets integer[];

-- Client boleh menulis kolom config miliknya sendiri
-- (RLS + column grant existing tetap berlaku untuk kolom lain).
GRANT INSERT (reminder_offsets) ON public.debts TO authenticated;
GRANT UPDATE (reminder_offsets) ON public.debts TO authenticated;

-- 2. Kolom config di recurring_rules (template Setiap Bulan).
ALTER TABLE public.recurring_rules
  ADD COLUMN IF NOT EXISTS reminder_offsets integer[];

GRANT UPDATE (reminder_offsets) ON public.recurring_rules TO authenticated;

-- 3. Perluas tipe reminder resmi.
--    Nama constraint dari migration 002: reminders_type_check.
ALTER TABLE public.reminders DROP CONSTRAINT IF EXISTS reminders_type_check;
ALTER TABLE public.reminders
  ADD CONSTRAINT reminders_type_check
  CHECK (type IN (
    'before_due_7d',  -- H-7 (Premium)
    'before_due_3d',  -- H-3 (Premium)
    'before_due_1d',  -- H-1 (basic + Premium)
    'due_today',      -- Hari H (Premium)
    'overdue_1d'      -- H+1 (basic + Premium)
  ));

-- Verifikasi (opsional):
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name IN ('debts','recurring_rules')
--   AND column_name = 'reminder_offsets';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.reminders'::regclass AND contype = 'c';
