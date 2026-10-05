-- ============================================================
-- Migration 005: WA Tagih rate limit (abuse prevention)
-- Dijalankan SEKALI saja. Aman diulang (idempotent).
--
-- Mencatat PENGGUNAAN fitur WA Tagih per akun per hari.
-- Yang dicatat HANYA: user_id + waktu penggunaan.
-- Yang TIDAK PERNAH dicatat: nomor tujuan, nama penerima,
-- isi pesan, nominal transaksi.
--
-- Prinsip (sesuai Legal/Product/Abuse Risk Spec v1):
-- - Maksimal 10 penggunaan per akun per hari (WIB).
-- - Nomor WhatsApp tidak disimpan di mana pun.
-- - Client menghitung pemakaian hari ini via SELECT count.
-- - Client mencatat pemakaian via INSERT (satu baris per klik).
-- - Tidak ada UPDATE/DELETE policy = user tidak bisa manipulasi log.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.wa_reminder_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now()
);

-- Index untuk hitung pemakaian harian per user.
CREATE INDEX IF NOT EXISTS wa_reminder_usage_user_day_idx
  ON public.wa_reminder_usage (user_id, used_at DESC);

ALTER TABLE public.wa_reminder_usage ENABLE ROW LEVEL SECURITY;

-- User hanya bisa INSERT baris miliknya sendiri.
DROP POLICY IF EXISTS "wa_usage_insert_own" ON public.wa_reminder_usage;
CREATE POLICY "wa_usage_insert_own" ON public.wa_reminder_usage
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- User hanya bisa SELECT baris miliknya sendiri (untuk hitung limit).
DROP POLICY IF EXISTS "wa_usage_select_own" ON public.wa_reminder_usage;
CREATE POLICY "wa_usage_select_own" ON public.wa_reminder_usage
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- TIDAK ADA policy UPDATE / DELETE -> user tidak bisa ubah/hapus log.
-- Service role tetap bisa baca untuk investigasi abuse manual.

-- Opsional: bersihkan log lama (>90 hari) agar tabel tidak membengkak.
-- Dijalankan manual bila diperlukan, bukan otomatis.
-- DELETE FROM public.wa_reminder_usage WHERE used_at < now() - interval '90 days';
