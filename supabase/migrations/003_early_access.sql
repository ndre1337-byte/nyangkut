-- ============================================================
-- Migration 003: Early Access untuk Nyangkut
-- Dijalankan SEKALI saja. Aman diulang (idempotent).
--
-- Menambahkan flag early_access ke public.profiles:
--   - User yang daftar selama masa Early Access → true
--   - User tidak boleh mengubah flag ini sendiri (server-side only)
--
-- FUTURE PREMIUM LAUNCH (JANGAN jalankan sekarang):
--   1. Migrasi existing early_access users menjadi Free (one-time):
--        UPDATE public.profiles SET early_access = false;
--   2. Default untuk pendaftar baru menjadi false:
--        ALTER TABLE public.profiles ALTER COLUMN early_access SET DEFAULT false;
--   3. Setelah itu baru implement plan/subscription system.
-- ============================================================

-- 1. Tambah kolom jika belum ada. DEFAULT true → user baru otomatis Early Access.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS early_access boolean NOT NULL DEFAULT true;

-- 2. Pastikan existing users = true (semua yang daftar selama masa Early Access).
UPDATE public.profiles
  SET early_access = true
  WHERE early_access IS DISTINCT FROM true;

-- 3. SECURITY: cabut UPDATE general, kasih hanya kolom yang aman.
--    Pola sama seperti proteksi paid_amount/status di tabel debts (migration 001).
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT SELECT, INSERT ON public.profiles TO authenticated;
GRANT UPDATE (name) ON public.profiles TO authenticated;
-- NOTE: kolom early_access, id, created_at, updated_at TIDAK bisa diubah client.
-- Trigger handle_updated_at() tetap jalan (SECURITY DEFINER, tidak terpengaruh).
