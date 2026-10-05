-- ============================================================
-- NYANGKUT — Split Bill RPC (Migration 008)
-- ============================================================
-- Cara pakai: copy SELURUH isi file ini, paste di
-- Supabase Dashboard > SQL Editor > New query > Run.
--
-- Membuat function split_bill_create() untuk atomic creation
-- beberapa debts dalam satu transaction.
--
-- Keamanan:
-- - user_id SELALU dari auth.uid(), tidak bisa di-spoof dari client
-- - paid_amount & status TIDAK bisa di-set dari client (trigger existing)
-- - Free limit trigger existing tetap jalan per-insert
-- - Jika satu insert gagal -> SEMUA rollback (atomic)
-- ============================================================

-- Tipe untuk satu debt dalam split bill.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'split_bill_item') THEN
    CREATE TYPE public.split_bill_item AS (
      person_name text,
      amount      numeric,
      note        text,
      due_date    date
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.split_bill_create(
  p_items    public.split_bill_item[],
  p_bill_name text DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  uuid;
  v_item     public.split_bill_item;
  v_debt_id  uuid;
  v_ids      uuid[] := ARRAY[]::uuid[];
  v_note     text;
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

  -- Insert semua dalam satu transaction (function = atomic).
  -- Trigger trg_check_free_note_limit jalan per-row:
  -- jika limit tercapai di item ke-N, SEMUA di-rollback.
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

    v_ids := v_ids || v_debt_id;
  END LOOP;

  RETURN v_ids;
END;
$$;

-- Hanya authenticated user yang bisa panggil.
REVOKE ALL ON FUNCTION public.split_bill_create(public.split_bill_item[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.split_bill_create(public.split_bill_item[], text) TO authenticated;

-- Pastikan tipe bisa dipakai oleh authenticated.
GRANT USAGE ON TYPE public.split_bill_item TO authenticated;
