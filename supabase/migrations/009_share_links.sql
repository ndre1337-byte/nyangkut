-- ============================================================
-- NYANGKUT — Share Links (Migration 009)
-- ============================================================
-- Cara pakai: copy SELURUH isi file ini, paste di
-- Supabase Dashboard > SQL Editor > New query > Run.
--
-- 1. Tabel public.split_bill_shares: satu share link per peserta
--    Split Bill. Token mentah TIDAK PERNAH disimpan, hanya
--    SHA-256 hash-nya.
-- 2. Rewrite public.split_bill_create(): sekalian membuat share
--    rows dalam transaksi yang sama (atomic), dan mengembalikan
--    raw token SEKALI ke owner.
--
-- Keamanan:
-- - RLS ENABLED tanpa policy -> deny-all untuk anon/authenticated.
-- - REVOKE ALL eksplisit untuk PUBLIC, anon, authenticated.
-- - TIDAK ADA function public-read untuk anon. Pembacaan share
--   hanya lewat Vercel server endpoint (service_role, server-side).
-- - split_bill_create: SECURITY DEFINER + SET search_path = ''
--   + semua referensi fully qualified (guidance Supabase terbaru).
-- - GRANT EXECUTE hanya untuk authenticated (tidak berubah).
-- ============================================================

-- Pastikan pgcrypto tersedia di schema extensions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'extensions' AND p.proname = 'gen_random_bytes'
  ) THEN
    RAISE EXCEPTION 'pgcrypto tidak ditemukan di schema extensions.';
  END IF;
END
$$;

-- ----------------------------------------------------------
-- 1. Tabel share links
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.split_bill_shares (
  id               uuid         PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  debt_id          uuid         NOT NULL REFERENCES public.debts(id) ON DELETE CASCADE,
  participant_name text         NOT NULL CHECK (char_length(TRIM(participant_name)) >= 1),
  bill_name        text         NOT NULL,
  -- SHA-256 hex dari raw token (64 char). Raw token tidak disimpan.
  token_hash       text         NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  -- Disiapkan untuk invalidasi manual/revoke di masa depan. V1: NULL.
  revoked_at       timestamptz  NULL
);

CREATE INDEX IF NOT EXISTS split_bill_shares_debt_id_idx
  ON public.split_bill_shares (debt_id);

ALTER TABLE public.split_bill_shares ENABLE ROW LEVEL SECURITY;
-- SENGAJA tanpa policy: deny-all untuk anon & authenticated.
-- Akses hanya lewat SECURITY DEFINER function (creation) dan
-- Vercel server endpoint (service_role, read).

-- Defense in depth: revoke eksplisit walau RLS sudah deny-all.
REVOKE ALL ON TABLE public.split_bill_shares FROM PUBLIC;
REVOKE ALL ON TABLE public.split_bill_shares FROM anon, authenticated;

-- ----------------------------------------------------------
-- 2. Rewrite split_bill_create(): debts + shares, atomic.
-- ----------------------------------------------------------
-- Tipe split_bill_item sudah ada dari migration 008.

-- Return type berubah (uuid[] -> TABLE), jadi DROP dulu:
-- PostgreSQL tidak mengizinkan CREATE OR REPLACE mengubah return type.
DROP FUNCTION IF EXISTS public.split_bill_create(public.split_bill_item[], text);

CREATE FUNCTION public.split_bill_create(
  p_items     public.split_bill_item[],
  p_bill_name text DEFAULT NULL
)
RETURNS TABLE (
  debt_id     uuid,
  share_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id    uuid;
  v_item       public.split_bill_item;
  v_debt_id    uuid;
  v_note       text;
  v_bill       text;
  v_token      text;
  v_token_hash text;
BEGIN
  -- Wajib authenticated.
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- Validasi: minimal 1 item.
  IF p_items IS NULL OR array_length(p_items, 1) IS NULL OR array_length(p_items, 1) < 1 THEN
    RAISE EXCEPTION 'SPLIT_BILL_EMPTY: minimal 1 peserta' USING ERRCODE = 'P0001';
  END IF;

  -- Validasi: maksimal 20 items (sesuai MVP).
  IF array_length(p_items, 1) > 20 THEN
    RAISE EXCEPTION 'SPLIT_BILL_TOO_MANY: maksimal 20 peserta' USING ERRCODE = 'P0001';
  END IF;

  -- Nama bill untuk share page. Fallback jika kosong.
  v_bill := NULLIF(TRIM(p_bill_name), '');
  IF v_bill IS NULL THEN
    v_bill := 'Split Bill';
  END IF;

  -- Insert semua dalam satu transaction (function = atomic).
  -- Trigger trg_check_free_note_limit jalan per-row:
  -- jika limit tercapai di item ke-N, SEMUA di-rollback.
  -- Jika satu share gagal dibuat, SEMUA ikut rollback.
  FOREACH v_item IN ARRAY p_items
  LOOP
    -- Validasi per-item.
    IF v_item.person_name IS NULL OR char_length(TRIM(v_item.person_name)) < 1 THEN
      RAISE EXCEPTION 'SPLIT_BILL_INVALID_NAME: nama peserta tidak valid' USING ERRCODE = 'P0001';
    END IF;
    IF v_item.amount IS NULL OR v_item.amount <= 0 THEN
      RAISE EXCEPTION 'SPLIT_BILL_INVALID_AMOUNT: nominal harus > 0' USING ERRCODE = 'P0001';
    END IF;

    -- Note: format "Split Bill: <nama>" jika bill name ada.
    v_note := v_item.note;
    IF p_bill_name IS NOT NULL AND char_length(TRIM(p_bill_name)) > 0 THEN
      v_note := 'Split Bill: ' || TRIM(p_bill_name) ||
                CASE WHEN v_note IS NOT NULL AND char_length(TRIM(v_note)) > 0
                     THEN ' — ' || TRIM(v_note)
                     ELSE '' END;
    END IF;

    INSERT INTO public.debts (user_id, direction, person_name, amount, note, due_date)
    VALUES (
      v_user_id,
      'receivable',  -- Split Bill selalu receivable (user yang bayarin)
      TRIM(v_item.person_name),
      v_item.amount,
      NULLIF(TRIM(v_note), ''),
      v_item.due_date
      -- paid_amount & status: JANGAN diisi, trigger yang atur.
    )
    RETURNING id INTO v_debt_id;

    -- Token participant-specific: 32 random bytes (256-bit),
    -- base64url tanpa padding (43 char). Raw token hanya
    -- dikembalikan sekali ke owner, tidak disimpan.
    v_token := rtrim(
      translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'),
      '='
    );
    v_token_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

    INSERT INTO public.split_bill_shares (debt_id, participant_name, bill_name, token_hash)
    VALUES (v_debt_id, TRIM(v_item.person_name), v_bill, v_token_hash);

    debt_id := v_debt_id;
    share_token := v_token;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

-- Hanya authenticated user yang bisa panggil (tidak berubah).
REVOKE ALL ON FUNCTION public.split_bill_create(public.split_bill_item[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.split_bill_create(public.split_bill_item[], text) TO authenticated;

-- Pastikan tipe bisa dipakai oleh authenticated (tidak berubah).
GRANT USAGE ON TYPE public.split_bill_item TO authenticated;
