-- ============================================================
-- Nyangkut migration 002 — tabel reminders (email reminder MVP)
-- H-1 (before_due_1d) dan H+1 (overdue_1d).
-- Anti-duplikat dijamin UNIQUE(debt_id, type) di level database.
-- Tulis hanya via service_role (server-side); client hanya boleh SELECT.
-- Timezone aplikasi: Asia/Jakarta (WIB). Cron jalan 00:00 UTC = 07:00 WIB.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reminders (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id       uuid        NOT NULL REFERENCES public.debts(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type          text        NOT NULL CHECK (type IN ('before_due_1d', 'overdue_1d')),
  scheduled_for date        NOT NULL,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_one_per_debt_type UNIQUE (debt_id, type)
);

CREATE INDEX IF NOT EXISTS reminders_user_id_idx ON public.reminders(user_id);
CREATE INDEX IF NOT EXISTS reminders_unsent_idx  ON public.reminders(sent_at) WHERE sent_at IS NULL;

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reminders_select_own ON public.reminders;
CREATE POLICY reminders_select_own ON public.reminders
  FOR SELECT USING (auth.uid() = user_id);

-- Client (authenticated) hanya boleh baca. Tidak ada policy INSERT/UPDATE/DELETE:
-- penulisan hanya lewat service_role dari server (Vercel function), yang bypass RLS.
REVOKE ALL ON public.reminders FROM anon, authenticated;
GRANT SELECT ON public.reminders TO authenticated;
