-- ============================================================================
-- Minyan Lyon — §8.2 Contributions communautaires
-- ============================================================================
-- Principes tenus par ce schéma :
--   * Aucune synagogue n'est perdue : les id existants sont les clés de tout
--     le système de versions et ne sont jamais réattribués.
--   * Tout changement est tracé : qui, quand, quoi (avant → après), par quel
--     moyen (saisie manuelle / photo / PDF).
--   * Tout est réversible : `contributions` conserve l'historique complet et
--     l'admin peut annuler n'importe quelle ligne.
--   * `horaires` n'est JAMAIS modifiable directement par le client : les
--     écritures passent obligatoirement par les fonctions serveur ci-dessous.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Qui est admin ? Une table plutôt qu'un e-mail codé en dur, pour pouvoir
-- en ajouter sans redéployer.
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email   text not null,
  added_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Référents de synagogue (§8.3) : un utilisateur N3 rattaché à une ou
-- plusieurs shuls, nommé par l'admin.
-- ---------------------------------------------------------------------------
create table if not exists public.referents (
  syn_id   int  not null,
  user_id  uuid not null references auth.users(id) on delete cascade,
  nomme_par uuid references auth.users(id),
  nomme_at timestamptz not null default now(),
  primary key (syn_id, user_id)
);

create or replace function public.is_referent(p_syn_id int)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.referents r
    where r.syn_id = p_syn_id and r.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Horaires courants : une ligne par synagogue, les 15 colonnes du Sheet.
-- ---------------------------------------------------------------------------
create table if not exists public.horaires (
  syn_id  int primary key,
  ven_sh  text, ven_mi  text, ven_ar  text,
  shab_sh text, shab_mi text, shab_ar text,
  dim_sh  text, dim_mi  text, dim_ar  text,
  lj_sh   text, lj_mi   text, lj_ar   text,
  mm_sh   text, mm_mi   text, mm_ar   text,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id),
  updated_by_name text
);

-- ---------------------------------------------------------------------------
-- Historique + file de modération.
-- ---------------------------------------------------------------------------
create table if not exists public.contributions (
  id  uuid primary key default gen_random_uuid(),
  syn_id int not null,
  champ  text not null,                       -- ex. 'lj_sh'
  ancienne_valeur text,
  nouvelle_valeur text,
  auteur_id     uuid references auth.users(id),
  auteur_nom    text,
  auteur_email  text,
  auteur_palier text,                         -- 'N0' | 'N1' | 'N2' | 'N3' | 'admin'
  source        text not null default 'manuel'
                check (source in ('manuel','photo','pdf')),
  fichier_url   text,                         -- justificatif si source <> manuel
  confiance     numeric check (confiance is null or (confiance >= 0 and confiance <= 1)),
  statut        text not null default 'propose'
                check (statut in ('propose','valide','rejete','annule')),
  created_at  timestamptz not null default now(),
  traite_at   timestamptz,
  traite_par  uuid references auth.users(id)
);

create index if not exists contributions_syn_idx    on public.contributions(syn_id, created_at desc);
create index if not exists contributions_statut_idx on public.contributions(statut) where statut = 'propose';
create index if not exists contributions_auteur_idx on public.contributions(auteur_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Confirmations « 👍 » : un utilisateur ne confirme un champ qu'une fois.
-- ---------------------------------------------------------------------------
create table if not exists public.verifications (
  syn_id     int  not null,
  champ      text not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  user_nom   text,
  created_at timestamptz not null default now(),
  primary key (syn_id, champ, user_id)
);

-- ---------------------------------------------------------------------------
-- Garde-fou d'usage de l'IA : 3 imports par utilisateur et par heure (§8.4).
-- Écrit uniquement par l'Edge Function (service role).
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id         bigserial primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_idx on public.ai_usage(user_id, created_at desc);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table public.horaires      enable row level security;
alter table public.contributions enable row level security;
alter table public.verifications enable row level security;
alter table public.referents     enable row level security;
alter table public.admins        enable row level security;
alter table public.ai_usage      enable row level security;

-- --- horaires : lecture publique, AUCUNE écriture cliente -------------------
drop policy if exists horaires_read on public.horaires;
create policy horaires_read on public.horaires
  for select using (true);
-- Pas de policy insert/update/delete : même l'admin passe par apply_contribution().

-- --- contributions ---------------------------------------------------------
-- Un utilisateur n'insère que ses propres lignes, toujours en statut 'propose'.
drop policy if exists contributions_insert_own on public.contributions;
create policy contributions_insert_own on public.contributions
  for insert to authenticated
  with check (auteur_id = auth.uid() and statut = 'propose');

-- Il relit les siennes ; l'admin et le référent de la shul voient tout.
drop policy if exists contributions_select on public.contributions;
create policy contributions_select on public.contributions
  for select to authenticated
  using (auteur_id = auth.uid() or public.is_admin() or public.is_referent(syn_id));

-- Seul l'admin change un statut (valide / rejete / annule).
drop policy if exists contributions_admin_update on public.contributions;
create policy contributions_admin_update on public.contributions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --- verifications ---------------------------------------------------------
drop policy if exists verifications_read on public.verifications;
create policy verifications_read on public.verifications
  for select using (true);

drop policy if exists verifications_insert_own on public.verifications;
create policy verifications_insert_own on public.verifications
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists verifications_delete_own on public.verifications;
create policy verifications_delete_own on public.verifications
  for delete to authenticated
  using (user_id = auth.uid());

-- --- referents / admins ----------------------------------------------------
drop policy if exists referents_read on public.referents;
create policy referents_read on public.referents
  for select to authenticated using (true);

drop policy if exists referents_admin_write on public.referents;
create policy referents_admin_write on public.referents
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins
  for select to authenticated using (true);
-- Aucune policy d'écriture : la table admins se remplit depuis le SQL editor.

-- --- ai_usage : réservé au service role ------------------------------------
-- RLS activée sans aucune policy = table invisible et inaccessible aux clients.

-- ============================================================================
-- FONCTIONS SERVEUR — seul chemin d'écriture vers `horaires`
-- ============================================================================

-- Applique une contribution à `horaires` et la marque 'valide'.
-- Autorisée pour : l'admin, ou le référent de la synagogue concernée.
create or replace function public.apply_contribution(p_contrib_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.contributions%rowtype;
  v_nom text;
begin
  select * into c from public.contributions where id = p_contrib_id;
  if not found then
    raise exception 'Contribution introuvable';
  end if;
  if not (public.is_admin() or public.is_referent(c.syn_id)) then
    raise exception 'Droits insuffisants pour appliquer cette contribution';
  end if;
  if c.champ not in ('ven_sh','ven_mi','ven_ar','shab_sh','shab_mi','shab_ar',
                     'dim_sh','dim_mi','dim_ar','lj_sh','lj_mi','lj_ar',
                     'mm_sh','mm_mi','mm_ar') then
    raise exception 'Champ inconnu : %', c.champ;
  end if;

  select coalesce(auteur_nom, auteur_email) into v_nom
  from public.contributions where id = p_contrib_id;

  insert into public.horaires (syn_id) values (c.syn_id)
  on conflict (syn_id) do nothing;

  -- format() + %I : le nom de colonne est validé ci-dessus, jamais concaténé brut.
  execute format(
    'update public.horaires set %I = $1, updated_at = now(), updated_by = $2, updated_by_name = $3 where syn_id = $4',
    c.champ
  ) using c.nouvelle_valeur, auth.uid(), v_nom, c.syn_id;

  update public.contributions
     set statut = 'valide', traite_at = now(), traite_par = auth.uid()
   where id = p_contrib_id;
end;
$$;

-- Annule une contribution déjà appliquée : remet l'ancienne valeur (§8.5).
create or replace function public.revert_contribution(p_contrib_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.contributions%rowtype;
begin
  select * into c from public.contributions where id = p_contrib_id;
  if not found then raise exception 'Contribution introuvable'; end if;
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if c.statut <> 'valide' then raise exception 'Cette contribution n''a pas été appliquée'; end if;

  execute format(
    'update public.horaires set %I = $1, updated_at = now(), updated_by = $2 where syn_id = $3',
    c.champ
  ) using c.ancienne_valeur, auth.uid(), c.syn_id;

  update public.contributions
     set statut = 'annule', traite_at = now(), traite_par = auth.uid()
   where id = p_contrib_id;
end;
$$;

-- Règle N2 (§8.3) : deux propositions N2 identiques et non traitées sur le
-- même champ s'appliquent automatiquement.
create or replace function public.auto_apply_on_consensus()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if new.auteur_palier <> 'N2' or new.statut <> 'propose' then
    return new;
  end if;
  select count(distinct auteur_id) into n
  from public.contributions
  where syn_id = new.syn_id
    and champ = new.champ
    and nouvelle_valeur is not distinct from new.nouvelle_valeur
    and auteur_palier = 'N2'
    and statut = 'propose';
  if n >= 2 then
    perform public.apply_contribution(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists contributions_consensus on public.contributions;
create trigger contributions_consensus
  after insert on public.contributions
  for each row execute function public.auto_apply_on_consensus();

-- ============================================================================
-- STOCKAGE DES JUSTIFICATIFS (§8.4) — bucket privé, purge à 90 jours
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('justificatifs', 'justificatifs', false, 10485760,
        array['image/jpeg','image/png','image/heic','image/heif','image/webp','application/pdf'])
on conflict (id) do nothing;

-- Un utilisateur dépose dans justificatifs/{syn_id}/{uuid} ; il relit ses
-- propres fichiers, l'admin relit tout.
drop policy if exists justif_insert on storage.objects;
create policy justif_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'justificatifs' and owner = auth.uid());

drop policy if exists justif_select on storage.objects;
create policy justif_select on storage.objects
  for select to authenticated
  using (bucket_id = 'justificatifs' and (owner = auth.uid() or public.is_admin()));

drop policy if exists justif_delete on storage.objects;
create policy justif_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'justificatifs' and public.is_admin());

-- Purge des justificatifs de plus de 90 jours. À planifier avec pg_cron :
--   select cron.schedule('purge-justificatifs', '0 3 * * *',
--                        $$select public.purge_justificatifs()$$);
create or replace function public.purge_justificatifs()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with vieux as (
    delete from storage.objects
    where bucket_id = 'justificatifs'
      and created_at < now() - interval '90 days'
    returning 1
  )
  select count(*) into n from vieux;

  update public.contributions
     set fichier_url = null
   where fichier_url is not null
     and created_at < now() - interval '90 days';

  return n;
end;
$$;
