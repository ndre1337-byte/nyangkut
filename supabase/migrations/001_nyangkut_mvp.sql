-- ============================================================
-- NYANGKUT MVP — Database Schema v1
-- ============================================================
-- Cara pakai: copy SELURUH isi file ini, paste di
-- Supabase Dashboard > SQL Editor > New query > Run.
-- Dijalankan SEKALI saja. Aman diulang (idempotent).
--
-- Isi:
--   1. Function: handle_updated_at, handle_new_user,
--      recalc_debt_payment, recalc_debt_status, force_initial_payment_state
--   2. Tabel: profiles, debts, payments
--   3. Index
--   4. Trigger
--   5. RLS + policies + column-level grants
-- ============================================================


-- ----------------------------------------------------------
-- 1. HELPER FUNCTIONS
-- ----------------------------------------------------------

-- Otomatis isi updated_at setiap ada UPDATE.
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Setiap ada user baru di auth.users, buatkan baris profiles.
-- Nama diambil dari metadata saat register (options.data.name).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data ->> 'name'), ''), 'Teman')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Hitung ulang paid_amount + status setiap ada perubahan payments.
-- Dijalankan sebagai owner (SECURITY DEFINER) supaya tidak
-- terkendala RLS saat maintenance data turunan.
CREATE OR REPLACE FUNCTION public.recalc_debt_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids    uuid[] := ARRAY[]::uuid[];
  v_id     uuid;
  v_total  numeric(14,2);
  v_amount numeric(14,2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.debt_id];
  ELSIF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.debt_id];
  ELSE
    v_ids := ARRAY[NEW.debt_id];
    IF OLD.debt_id IS DISTINCT FROM NEW.debt_id THEN
      v_ids := v_ids || OLD.debt_id;
    END IF;
  END IF;

  FOREACH v_id IN ARRAY v_ids
  LOOP
    SELECT COALESCE(SUM(p.amount), 0)
      INTO v_total
      FROM public.payments p
     WHERE p.debt_id = v_id;

    SELECT d.amount
      INTO v_amount
      FROM public.debts d
     WHERE d.id = v_id;

    IF v_amount IS NOT NULL THEN
      UPDATE public.debts
         SET paid_amount = v_total,
             status = CASE
                        WHEN v_total >= v_amount THEN 'paid'
                        WHEN v_total > 0        THEN 'partial'
                        ELSE 'unpaid'
                      END,
             updated_at = now()
       WHERE id = v_id;
    END IF;
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Hitung ulang STATUS setiap debts.amount berubah.
-- paid_amount TIDAK berubah di sini (ia selalu = SUM(payments));
-- yang berubah hanya status, karena status = f(paid_amount, amount).
-- Mencegah state stale, mis: amount naik setelah lunas -> kembali 'partial'.
-- Berjalan BEFORE agar CHECK (paid_amount <= amount) menilai baris final:
-- menurunkan amount di bawah paid_amount akan DITOLAK (konsisten dengan
-- aturan "tidak ada overpayment").
CREATE OR REPLACE FUNCTION public.recalc_debt_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    NEW.status := CASE
                    WHEN NEW.paid_amount >= NEW.amount THEN 'paid'
                    WHEN NEW.paid_amount > 0 THEN 'partial'
                    ELSE 'unpaid'
                  END;
  END IF;
  RETURN NEW;
END;
$$;

-- PAKSA state awal setiap INSERT: paid_amount=0, status='unpaid'.
-- Berjalan SEBELUM row ditulis, jadi nilai apa pun yang dikirim
-- client untuk kedua kolom ini selalu ditimpa. Tidak ada jalur
-- normal bagi client untuk mengisi manual saat INSERT.
CREATE OR REPLACE FUNCTION public.force_initial_payment_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.paid_amount := 0;
  NEW.status := 'unpaid';
  RETURN NEW;
END;
$$;


-- ----------------------------------------------------------
-- 2. TABLES
-- ----------------------------------------------------------

-- Profil user (1 baris per akun). Dibuat otomatis oleh trigger.
CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Catatan uang nyangkut. Satu tabel untuk DUA arah:
--   direction = 'receivable' -> piutang (uang orang lain yg jadi hak user)
--   direction = 'payable'    -> utang (utang user ke orang lain)
CREATE TABLE IF NOT EXISTS public.debts (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid          NOT NULL DEFAULT auth.uid()
                            REFERENCES auth.users(id) ON DELETE CASCADE,
  direction   text          NOT NULL CHECK (direction IN ('receivable', 'payable')),
  person_name text          NOT NULL CHECK (char_length(TRIM(person_name)) >= 1),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status      text          NOT NULL DEFAULT 'unpaid'
                            CHECK (status IN ('unpaid', 'partial', 'paid')),
  note        text,
  due_date    date,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  CHECK (paid_amount <= amount)
);
-- paid_amount & status DIISI OTOMATIS oleh trigger dari tabel payments.
-- Aplikasi TIDAK BOLEH mengisi manual.

-- Riwayat pembayaran (termasuk pembayaran sebagian / cicilan).
CREATE TABLE IF NOT EXISTS public.payments (
  id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id    uuid          NOT NULL REFERENCES public.debts(id) ON DELETE CASCADE,
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_at    date          NOT NULL DEFAULT CURRENT_DATE,
  note       text,
  created_at timestamptz   NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------
-- 3. INDEXES
-- ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS debts_user_id_idx     ON public.debts (user_id);
CREATE INDEX IF NOT EXISTS debts_user_due_idx    ON public.debts (user_id, due_date);
CREATE INDEX IF NOT EXISTS debts_user_status_idx ON public.debts (user_id, status);
CREATE INDEX IF NOT EXISTS payments_debt_id_idx  ON public.payments (debt_id);


-- ----------------------------------------------------------
-- 4. TRIGGERS
-- ----------------------------------------------------------

-- updated_at otomatis
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_debts_updated_at ON public.debts;
CREATE TRIGGER trg_debts_updated_at
  BEFORE UPDATE ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- paksa paid_amount=0 & status='unpaid' saat INSERT (client tidak bisa isi manual)
DROP TRIGGER IF EXISTS trg_debts_force_initial ON public.debts;
CREATE TRIGGER trg_debts_force_initial
  BEFORE INSERT ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public.force_initial_payment_state();

-- profil otomatis saat user register
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- recalc status saat amount berubah (BEFORE: CHECK menilai baris final)
DROP TRIGGER IF EXISTS trg_debts_recalc_status ON public.debts;
CREATE TRIGGER trg_debts_recalc_status
  BEFORE UPDATE OF amount ON public.debts
  FOR EACH ROW EXECUTE FUNCTION public.recalc_debt_status();

-- hitung ulang paid_amount + status setiap payments berubah
DROP TRIGGER IF EXISTS trg_payments_recalc ON public.payments;
CREATE TRIGGER trg_payments_recalc
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.recalc_debt_payment();


-- ----------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ----------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- Hak akses dasar untuk role authenticated
-- (RLS yang menentukan baris mana yang boleh diakses).
--
-- PENGUATAN #2: paid_amount & status adalah database-controlled.
--   - INSERT: trigger trg_debts_force_initial SELALU menimpa keduanya
--     (0 / 'unpaid'), apa pun yang dikirim client.
--   - UPDATE: grant kolom dibatasi — client TIDAK PUNYA hak UPDATE
--     atas paid_amount & status (juga id, user_id, created_at, updated_at).
--     Satu-satunya penulis kedua kolom itu adalah trigger
--     recalc_debt_payment (SECURITY DEFINER = bypass grant & RLS).
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;

REVOKE ALL ON public.debts FROM authenticated;
GRANT SELECT, DELETE ON public.debts TO authenticated;
GRANT INSERT (user_id, direction, person_name, amount, note, due_date)
  ON public.debts TO authenticated;
GRANT UPDATE (direction, person_name, amount, note, due_date)
  ON public.debts TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;

-- Trigger function tidak boleh dipanggil langsung (mis. via RPC).
-- Dijalankan hanya oleh mekanisme trigger (tidak butuh EXECUTE privilege).
REVOKE ALL ON FUNCTION public.handle_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalc_debt_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalc_debt_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_initial_payment_state() FROM PUBLIC;

-- ----- profiles: hanya milik sendiri -----
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- ----- debts: hanya milik sendiri -----
DROP POLICY IF EXISTS "debts_select_own" ON public.debts;
CREATE POLICY "debts_select_own" ON public.debts
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "debts_insert_own" ON public.debts;
CREATE POLICY "debts_insert_own" ON public.debts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "debts_update_own" ON public.debts;
CREATE POLICY "debts_update_own" ON public.debts
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "debts_delete_own" ON public.debts;
CREATE POLICY "debts_delete_own" ON public.debts
  FOR DELETE USING (auth.uid() = user_id);

-- ----- payments: hanya milik sendiri (lewat kepemilikan debts) -----
DROP POLICY IF EXISTS "payments_select_own" ON public.payments;
CREATE POLICY "payments_select_own" ON public.payments
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.debts d
            WHERE d.id = payments.debt_id AND d.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "payments_insert_own" ON public.payments;
CREATE POLICY "payments_insert_own" ON public.payments
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.debts d
            WHERE d.id = payments.debt_id AND d.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "payments_update_own" ON public.payments;
CREATE POLICY "payments_update_own" ON public.payments
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.debts d
            WHERE d.id = payments.debt_id AND d.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.debts d
            WHERE d.id = payments.debt_id AND d.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "payments_delete_own" ON public.payments;
CREATE POLICY "payments_delete_own" ON public.payments
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.debts d
            WHERE d.id = payments.debt_id AND d.user_id = auth.uid())
  );
