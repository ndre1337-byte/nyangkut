-- ============================================================
-- NYANGKUT — Weekly Digest tracking (Migration 010)
-- ============================================================
-- Cara pakai: copy SELURUH isi file ini, paste di
-- Supabase Dashboard > SQL Editor > New query > Run.
--
-- Tabel public.weekly_digests: idempotency tracking untuk
-- email "Nyangkut Mingguan" (1x seminggu, Senin 08:00 WIB).
--
-- Konsep (mengikuti pola tabel reminders):
-- - Satu baris per (user_id, week_key).
-- - UNIQUE(user_id, week_key) -> cron yang jalan 2x tidak
--   membuat duplikat.
-- - sent_at diisi HANYA setelah Resend 2xx. Gagal kirim ->
--   sent_at tetap NULL -> dicoba lagi di invocation berikut.
--
-- Keamanan:
-- - RLS ENABLED tanpa policy -> deny-all untuk anon/authenticated.
-- - REVOKE ALL eksplisit. Hanya service_role (server-side) yang
--   membaca/menulis, lewat Vercel endpoint dengan CRON_SECRET.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.weekly_digests (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Senin dari minggu tersebut (Asia/Jakarta), format date.
  week_key   date        NOT NULL,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_digests_one_per_user_week UNIQUE (user_id, week_key)
);

CREATE INDEX IF NOT EXISTS weekly_digests_unsent_idx
  ON public.weekly_digests (week_key, sent_at) WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS weekly_digests_user_id_idx
  ON public.weekly_digests (user_id);

ALTER TABLE public.weekly_digests ENABLE ROW LEVEL SECURITY;
-- SENGAJA tanpa policy: hanya service_role (server-side).

REVOKE ALL ON TABLE public.weekly_digests FROM PUBLIC;
REVOKE ALL ON TABLE public.weekly_digests FROM anon, authenticated;
