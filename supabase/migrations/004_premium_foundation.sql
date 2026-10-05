-- ============================================================
-- Migration 004: Premium Foundation
-- Dijalankan SEKALI saja. Aman diulang (idempotent).
--
-- 1. Tambah kolom plan ke public.profiles (free/premium, default free).
-- 2. Existing users -> plan='free' (early_access tetap true = FULL ACCESS).
-- 3. Pertahankan security: client TIDAK boleh ubah plan/early_access.
-- 4. Trigger server-side: Free user dibatasi 10 catatan aktif
--    (status != 'paid'). Early Access / Premium = unlimited.
--
-- EFFECTIVE ACCESS (di frontend via helper hasPremiumAccess):
--   early_access=true  -> FULL (sekarang semua user)
--   plan='premium'     -> FULL (nanti setelah payment)
--   lainnya            -> FREE (max 10 active notes)
--
-- FUTURE (JANGAN jalankan sekarang):
--   Saat Premium launch: UPDATE profiles SET early_access=false;
--   Setelah itu user dengan plan='free' -> Free limits,
--   plan='premium' -> Premium access.
-- ============================================================

-- 1. Kolom plan dengan CHECK constraint (hanya free/premium).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
  CONSTRAINT profiles_plan_check CHECK (plan IN ('free', 'premium'));

-- 2. Existing users -> free (early_access TIDAK diubah).
UPDATE public.profiles
  SET plan = 'free'
  WHERE plan IS DISTINCT FROM 'free';

-- 3. SECURITY: pertahankan model privilege.
--    Client hanya boleh SELECT, INSERT, dan UPDATE(name).
--    plan dan early_access TIDAK bisa diubah dari browser.
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT SELECT, INSERT ON public.profiles TO authenticated;
GRANT UPDATE (name) ON public.profiles TO authenticated;

-- Cabut akses eksekusi fungsi trigger dari PUBLIC (pola migration 001).
-- (Dijalankan setelah CREATE FUNCTION di bawah.)

-- 4. Trigger: batasi 10 catatan aktif untuk Free user.
--    Dijalankan sebagai owner (SECURITY DEFINER) agar bisa baca
--    profiles tanpa terkendala RLS, dan agar tidak bisa di-bypass
--    dari client (devtools / direct fetch / API manual tetap kena).
CREATE OR REPLACE FUNCTION public.check_free_note_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_early_access boolean;
  v_plan text;
  v_active_count integer;
BEGIN
  -- Ambil status akses user pemilik catatan.
  SELECT early_access, plan INTO v_early_access, v_plan
  FROM public.profiles
  WHERE id = NEW.user_id;

  -- Early Access atau Premium -> unlimited, lewati cek.
  IF v_early_access IS TRUE OR v_plan = 'premium' THEN
    RETURN NEW;
  END IF;

  -- Free: hitung catatan aktif (status != 'paid').
  SELECT count(*) INTO v_active_count
  FROM public.debts
  WHERE user_id = NEW.user_id
    AND status <> 'paid';

  IF v_active_count >= 10 THEN
    -- Marker FREE_LIMIT_REACHED agar frontend bisa tampilkan
    -- pesan yang ramah (bukan raw DB error).
    RAISE EXCEPTION 'FREE_LIMIT_REACHED: batas 10 catatan aktif tercapai'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_free_note_limit ON public.debts;
CREATE TRIGGER trg_check_free_note_limit
  BEFORE INSERT ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public.check_free_note_limit();

-- Pastikan fungsi trigger tidak bisa dipanggil langsung oleh client.
REVOKE ALL ON FUNCTION public.check_free_note_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_free_note_limit() FROM authenticated;
REVOKE ALL ON FUNCTION public.check_free_note_limit() FROM anon;
