-- ============================================================
-- Migration 006: Recurring Payment (cicilan/tagihan berulang)
-- Dijalankan SEKALI saja. Aman diulang (idempotent).
--
-- Konsep:
--   recurring_rules = TEMPLATE (bukan transaksi).
--   Setiap periode, generator server-side membuat SATU debt aktual
--   dari rule yang aktif. Debt hasil recurring adalah transaksi
--   biasa: bisa dibayar (partial/paid), masuk reminder, kalender,
--   search/filter, dan WA Tagih seperti debt lainnya.
--
--   JANGAN PERNAH membuat payment otomatis dari rule.
--
-- Idempotency:
--   debts(recurring_rule_id, period_key) UNIQUE partial index
--   -> cron yang jalan 2x tidak akan membuat duplikat.
--
-- Free limit:
--   Trigger check_free_note_limit (migration 004) berjalan untuk
--   SEMUA insert termasuk service_role, jadi generation otomatis
--   patuh batas 10 active notes. Generator menangkap
--   FREE_LIMIT_REACHED dan melewati rule itu dengan aman
--   (rule tetap aktif, dicoba lagi periode berikutnya).
--
-- Keamanan:
--   - RLS: user hanya akses rule miliknya.
--   - Client TIDAK bisa tulis recurring_rule_id/period_key di debts
--     (kolom baru tidak masuk GRANT) -> tidak bisa spoof.
--   - Client TIDAK bisa ubah frequency/start_period.
--   - Hapus rule = SET NULL di debts (riwayat transaksi aman,
--     tidak ikut terhapus).
-- ============================================================

-- ----------------------------------------------------------
-- 1. Tabel recurring_rules
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_rules (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid          NOT NULL DEFAULT auth.uid()
                                 REFERENCES auth.users(id) ON DELETE CASCADE,
  direction        text          NOT NULL CHECK (direction IN ('receivable', 'payable')),
  person_name      text          NOT NULL CHECK (char_length(TRIM(person_name)) >= 1),
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  note             text,
  due_day          smallint      NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  frequency        text          NOT NULL DEFAULT 'monthly'
                                 CHECK (frequency = 'monthly'),
  is_active        boolean       NOT NULL DEFAULT true,
  start_period     text          NOT NULL CHECK (start_period ~ '^[0-9]{4}-[0-9]{2}$'),
  -- start_period: 'YYYY-MM' periode pertama yang boleh di-generate.
  -- Diisi saat rule dibuat: bulan berjalan jika due_day belum lewat,
  -- bulan depan jika due_day sudah lewat (biar tidak langsung overdue).
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recurring_rules_user_id_idx
  ON public.recurring_rules (user_id);
CREATE INDEX IF NOT EXISTS recurring_rules_active_idx
  ON public.recurring_rules (is_active) WHERE is_active = true;

-- updated_at otomatis (fungsi sudah ada dari migration 001).
DROP TRIGGER IF EXISTS trg_recurring_rules_updated_at ON public.recurring_rules;
CREATE TRIGGER trg_recurring_rules_updated_at
  BEFORE UPDATE ON public.recurring_rules
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ----------------------------------------------------------
-- 2. Kolom pelacak di debts + proteksi duplikat
-- ----------------------------------------------------------
ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS recurring_rule_id uuid
    REFERENCES public.recurring_rules(id) ON DELETE SET NULL;

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS period_key text;

-- Satu debt per (rule, periode). Partial index: hanya untuk debt
-- hasil recurring; debt manual (recurring_rule_id NULL) tidak terpengaruh.
CREATE UNIQUE INDEX IF NOT EXISTS debts_recurring_unique
  ON public.debts (recurring_rule_id, period_key)
  WHERE recurring_rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS debts_recurring_rule_idx
  ON public.debts (recurring_rule_id) WHERE recurring_rule_id IS NOT NULL;

-- ----------------------------------------------------------
-- 3. Row Level Security untuk recurring_rules
-- ----------------------------------------------------------
ALTER TABLE public.recurring_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.recurring_rules FROM authenticated;
GRANT SELECT, DELETE ON public.recurring_rules TO authenticated;
GRANT INSERT (user_id, direction, person_name, amount, note, due_day, is_active, start_period)
  ON public.recurring_rules TO authenticated;
GRANT UPDATE (direction, person_name, amount, note, due_day, is_active)
  ON public.recurring_rules TO authenticated;
-- frequency & start_period: server-side only (default 'monthly';
-- start_period dihitung saat pembuatan).

DROP POLICY IF EXISTS "recurring_rules_select_own" ON public.recurring_rules;
CREATE POLICY "recurring_rules_select_own" ON public.recurring_rules
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "recurring_rules_insert_own" ON public.recurring_rules;
CREATE POLICY "recurring_rules_insert_own" ON public.recurring_rules
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "recurring_rules_update_own" ON public.recurring_rules;
CREATE POLICY "recurring_rules_update_own" ON public.recurring_rules
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "recurring_rules_delete_own" ON public.recurring_rules;
CREATE POLICY "recurring_rules_delete_own" ON public.recurring_rules
  FOR DELETE USING (auth.uid() = user_id);

-- Kolom baru di debts TIDAK masuk GRANT existing ->
-- client tetap tidak bisa menulis recurring_rule_id / period_key.
-- Tidak ada perubahan GRANT debts di sini (sengaja).
