# Contributions communautaires & import IA — guide de déploiement

> **La refonte est en production.** `index.html` est la V2 décrite ici.
> `index-v1-backup.html` conserve l’ancienne interface : c’est le retour
> arrière, il suffit de la recopier sur `index.html`.
> ⚠️ Toute mise en ligne doit s’accompagner d’une incrémentation de `CACHE`
> dans `sw.js`, sinon les anciens contenus mis en cache ne sont pas purgés.

Ce document couvre le **§8** de la refonte bêta : qui peut modifier quoi, où
sont stockées les données, comment déployer l'Edge Function, où placer la clé
API, et comment nommer un référent de synagogue.

---

## 1. Vue d'ensemble

```
                    ┌──────────────────────────────┐
                    │  index.html (navigateur)     │
                    │  jamais de clé API           │
                    └───────┬──────────────┬───────┘
             lecture        │              │  contribution
                            ▼              ▼
        Google Sheet ──▶ SYNS ◀── Supabase │  Edge Function
        (source actuelle)                  │  parse-bulletin
        cache localStorage ◀───────────────┘  (détient la clé)
        SYNS_DEFAULT (noms seuls)              │
                                                 ▼
                                        API du modèle (Anthropic
                                        ou Gemini selon AI_PROVIDER)
```

**La chaîne de repli existante est conservée telle quelle** : si Supabase est
indisponible, l'app lit le Sheet, puis le cache `localStorage`, puis
`SYNS_DEFAULT`. Les horaires restent affichés dans tous les cas.

> **État actuel :** le Sheet reste la source de vérité en lecture. Les tables
> Supabase du §8.2 sont créées et prêtes, et les contributions y sont
> historisées, mais la bascule complète Sheet → Supabase se fait quand vous
> lancez `scripts/import-sheets.mjs` puis inversez l'ordre dans `loadSyns()`.

---

## 2. Créer le schéma

Dans le **SQL Editor** de Supabase, exécuter :

```
supabase/migrations/20260825_contributions.sql
```

Cela crée `admins`, `referents`, `horaires`, `contributions`, `verifications`,
`ai_usage`, le bucket privé `justificatifs`, toutes les policies RLS et les
fonctions serveur.

Puis se déclarer administrateur (remplacer l'UUID par le vôtre, visible dans
**Authentication → Users**) :

```sql
insert into public.admins (user_id, email)
values ('00000000-0000-0000-0000-000000000000', 'noamamsellem@gmail.com');
```

### Ce que garantissent les RLS

| Table | Lecture | Écriture |
|---|---|---|
| `horaires` | publique | **aucune écriture cliente** — uniquement `apply_contribution()` |
| `contributions` | ses propres lignes, + admin, + référent de la shul | insertion de ses propres lignes en statut `propose` seulement ; seul l'admin change un statut |
| `verifications` | publique | chacun n'insère et ne supprime que sa propre confirmation |
| `referents` | authentifiés | admin seulement |
| `ai_usage` | — | service role seulement (RLS active, aucune policy) |
| `storage/justificatifs` | son propre dépôt, + admin | dépôt authentifié, suppression admin |

---

## 3. Migration one-shot Sheet → Supabase

```bash
# 1) Vérifier ce qui serait importé, sans rien écrire
node scripts/import-sheets.mjs --dry-run

# 2) Appliquer
export SUPABASE_URL=https://dsaizyvxdebqguzyivmy.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...        # Settings → API → service_role
node scripts/import-sheets.mjs
```

Le script **préserve les `id` du Sheet à l'identique** — ce sont les clés de
tout le système de versions. Il est idempotent : relancé, il met à jour les
lignes existantes et n'en supprime aucune. Il signale en console toute
coordonnée hors de la plage lyonnaise plausible.

⚠️ La `service_role` contourne les RLS. Elle ne doit jamais être committée ni
apparaître côté navigateur — uniquement dans votre terminal.

---

## 4. Edge Function `parse-bulletin`

Une seule fonction sert les deux usages, avec un paramètre `mode` :

| `mode` | Qui | Entrée | Sortie |
|---|---|---|---|
| `bulletin` (défaut) | admin uniquement | `pdf_base64` | bannière Chabbat + tableau brut, cellule par cellule |
| `horaires` | tout compte connecté | `file_base64` + `mime` | les 15 colonnes + confiance par champ + `ambigus[]` |

### Déploiement

```bash
supabase functions deploy parse-bulletin
```

### Clé API — où la placer

**Jamais dans `index.html`, jamais dans le dépôt, jamais dans un commit.**
Uniquement en secret Supabase :

```bash
# Option A — Anthropic (fournisseur actuellement utilisé)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set AI_PROVIDER=anthropic          # facultatif, c'est le défaut

# Option B — Gemini (palier gratuit)
supabase secrets set GEMINI_API_KEY=AIza...
supabase secrets set AI_PROVIDER=gemini
```

Basculer d'un fournisseur à l'autre ne demande **aucune modification de code** :
seul le secret `AI_PROVIDER` change, puis on redéploie. Modèles par défaut :
`claude-sonnet-4-6` et `gemini-2.5-flash`, surchargeables via `ANTHROPIC_MODEL`
/ `GEMINI_MODEL`.

Le rate-limit a besoin de :

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Sans ce secret, la fonction **laisse passer** plutôt que de bloquer un
utilisateur légitime, et le signale dans `rate_limit_note`.

### Règles métier — appliquées côté serveur

L'IA ne fait que **lire**. Toutes les conventions sont appliquées dans
`applyBusinessRules()` de l'Edge Function, jamais laissées à son appréciation :

- « Suivi » → arvit = minha + 20 min · « Suivi 20h30 » → 20h30
- `shab_ar` = sortie de Chabbat de la semaine, **jamais** minha + 20
- Rav Hyda (25) → 21h00 · Mizrahi (17) → 22h09 · id 11 → 22h00
- Rite Habad → `shab_ar` vide · Collel Na'halat Moché (5) → pas de `shab_ar`
- Plage « 8h00 - 9h00 » → première heure retenue **et signalée comme ambiguë**
- Heure hors fourchette plausible (Shaharit 5h–10h30, Minha 11h30–21h,
  Arvit 16h–23h30) → **jamais appliquée**, marquée ambiguë

### Garde-fous

- 10 Mo maximum, types acceptés : JPEG, PNG, HEIC/HEIF, WebP, PDF
- 3 imports par utilisateur et par heure
- EXIF retiré **côté navigateur** avant l'envoi (ré-encodage canvas) : la
  position GPS de la photo ne quitte jamais le téléphone
- Justificatif stocké dans le bucket privé `justificatifs/{syn_id}/{uuid}`,
  purgé après 90 jours
- Si le document n'est pas un tableau d'horaires : message clair, **aucune
  écriture**, proposition de saisie manuelle

---

## 5. Paliers et droits (§8.3)

| Palier | Droit |
|---|---|
| **N0** invité | lecture seule ; le crayon invite à se connecter |
| **N1** compte récent | peut **proposer** — passe en modération, rien ne change en ligne |
| **N2** compte confirmé | peut proposer ; **deux propositions N2 identiques** sur le même champ s'appliquent automatiquement (trigger `auto_apply_on_consensus`) |
| **N3** / référent | **applique directement** sur sa ou ses synagogues, avec notification admin et rollback possible |
| **Admin** | tout, plus la file de modération et l'historique complet |

### Nommer un référent de synagogue

C'est la brique qui rend utile une campagne vers les administrateurs de shul :
le référent met à jour ses propres horaires sans passer par la modération.

```sql
-- 1) Récupérer l'UUID de la personne : Authentication → Users
-- 2) Récupérer l'id de la synagogue : colonne A du Sheet
insert into public.referents (syn_id, user_id, nomme_par)
values (2, '11111111-1111-1111-1111-111111111111', auth.uid());
```

Retirer un référent :

```sql
delete from public.referents
where syn_id = 2 and user_id = '11111111-1111-1111-1111-111111111111';
```

---

## 6. Traçabilité et rollback (§8.5)

Chaque sous-carte horaire affiche, en italique gris :

- « Mis à jour par **David L.** il y a 3 jours » — prénom + initiale, **jamais
  l'e-mail**
- « Vérifié par 4 personnes · dernière fois il y a 2 jours »
- 📎 aperçu du justificatif (paliers ≥ N2 et admin), via une URL signée
  valable 60 secondes
- « À vérifier » si aucun horaire n'a bougé depuis plus de 6 mois

L'écran **Historique** est accessible depuis la fiche de chaque synagogue.
Pour l'admin, chaque ligne appliquée porte un bouton *Annuler ce changement*,
qui restaure l'ancienne valeur et passe la contribution en statut `annule`.

Côté SQL :

```sql
select public.revert_contribution('<uuid-de-la-contribution>');
```

---

## 7. Purge des justificatifs

Manuellement :

```sql
select public.purge_justificatifs();
```

Ou planifiée quotidiennement avec `pg_cron` :

```sql
select cron.schedule('purge-justificatifs', '0 3 * * *',
                     $$select public.purge_justificatifs()$$);
```

---

## 8. Dépannage

| Symptôme | Cause probable | Correction |
|---|---|---|
| 401 à l'import | session Supabase expirée | se reconnecter |
| 403 en mode `bulletin` | e-mail ≠ admin | vérifier `ADMIN_EMAIL` dans la fonction |
| 413 | fichier > 10 Mo | recadrer ou compresser la photo |
| 415 | HEIC non converti par le navigateur | exporter en JPEG |
| 429 | 3 imports déjà faits dans l'heure | attendre |
| 422 `document_illisible` | ce n'est pas un tableau d'horaires | saisir manuellement |
| 502 « Erreur du fournisseur d'IA » | clé absente, invalide ou quota dépassé | vérifier le secret et le quota du fournisseur |
| Beaucoup d'`ambigus` | photo floue ou de travers | reprendre la photo bien à plat, en lumière |
