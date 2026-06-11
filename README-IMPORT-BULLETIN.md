# Import bulletin Kol Villeurbanne — Mode d'emploi

Pipeline auto pour transformer le PDF hebdomadaire en lignes de Sheet,
sans saisie manuelle.

## Vue d'ensemble

```
Admin (noamamsellem@gmail.com)
  └─ uploade le PDF dans l'app
       └─ Edge Function `parse-bulletin` (Supabase)
            └─ appelle l'API Anthropic avec le PDF + prompt
                 └─ JSON brut : bannière + 1 ligne par syn
            └─ moteur de règles côté client applique :
                  Suivi → +20 min, fin_chabbat → shab_ar,
                  exceptions par syn (NETS, Mizrahi 22h09, …)
       └─ aperçu éditable des 34 lignes
       └─ « Copier TSV » ou « Télécharger CSV (;) »
```

La clé `ANTHROPIC_API_KEY` ne quitte jamais le serveur — elle est stockée
en secret Supabase et n'est lue que dans l'Edge Function.

## Pré-requis

- Supabase CLI installée : <https://supabase.com/docs/guides/cli>
- Projet lié au repo : `supabase link --project-ref dsaizyvxdebqguzyivmy`
- Une clé API Anthropic active

## Déploiement

```bash
# Depuis la racine du repo
cd minyan-lyon

# 1) Configurer la clé Anthropic comme secret (jamais committée)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# 2) Déployer la fonction
supabase functions deploy parse-bulletin
```

La fonction est alors disponible à :
`https://dsaizyvxdebqguzyivmy.supabase.co/functions/v1/parse-bulletin`

## Utilisation

1. Ouvrir l'app, se connecter avec `noamamsellem@gmail.com` (sinon
   l'entrée est invisible).
2. Profil → « 📄 Importer le bulletin ».
3. Glisser-déposer ou choisir le PDF Kol Villeurbanne de la semaine.
4. Attendre 5-15 s (extraction Anthropic).
5. L'aperçu s'affiche :
   - Champ « Fin de Chabbat à appliquer » (modifiable, alimenté depuis
     la bannière du PDF).
   - Liste des ⚠️ à vérifier (syn non matchée, « Suivi » sans minha,
     structure inattendue, etc.).
   - Tableau 34 lignes × 22 colonnes, toutes les cellules éditables.
   - Alerte rouge pour CERJ (id 14) avec case « réintégrer » décochée
     par défaut.
6. Corriger ce qui ne va pas directement dans le tableau.
7. Cliquer :
   - **📋 Copier (TSV)** → coller dans Google Sheets (1 colonne par
     onglet, l'ordre des colonnes est l'en-tête).
   - **⬇️ Télécharger CSV (;)** → ouvrir dans Sheets via
     « Données → Scinder le texte en colonnes → point-virgule ».

## Conventions appliquées automatiquement

| Syn (id) | Règle |
| -------- | ----- |
| 1 (NETS) | shaharit = petiha (le plus tôt), répliqué dim→ven ; pas de minha/arvit ; pas de Chabbat |
| 5 (Collel Na'halat Moché) | mi/ar tardifs en semaine, pas d'arvit Chabbat |
| 6 (Achkenaze École Juive) | pas d'arvit Chabbat |
| 11 (Beth Menahem Sépharade) | shab_ar fixe à `22h00` |
| 13 (Neveh Chalom) | shab_ar toujours vide |
| 17 (Mizrahi) | shab_ar fixe à `22h09` |
| 25 (Rav Hyda) | shab_ar fixe à `21h00` |
| 34 (Beth Hamidrach) | absente du PDF → valeurs fixes pré-remplies |

Pas d'arvit Chabbat (`shab_ar` vide) : ids **1, 5, 6, 10, 13, 26, 27, 29,
31, 32, 33**.

Règles générales :

- 1 à 3 valeurs par cellule jour → `sh` / `mi` / `ar` dans l'ordre.
- « Suivi » seul après une minha → `ar = mi + 20 min`.
- « Suivi Xh » → `ar = Xh`.
- Plages `Xh - Yh` → restent en `sh`.
- Format normalisé `7h05` (sans zéro inutile, `h` minuscule).
- Si une syn n'est pas trouvée dans le PDF : ses cellules sont vidées
  (sauf id 34) et listée dans les ⚠️.

## Sécurité

- L'Edge Function vérifie le JWT Supabase de l'appelant et rejette si
  `email !== noamamsellem@gmail.com`.
- La clé Anthropic est lue depuis `Deno.env.get("ANTHROPIC_API_KEY")` —
  jamais dans le bundle JS du client.
- L'app vérifie aussi `isOwner()` avant d'afficher le bouton, pour éviter
  d'exposer le flux aux autres utilisateurs.

## Dépannage

| Symptôme | Cause probable | Fix |
| -------- | -------------- | --- |
| 401/403 lors de l'upload | Pas connecté, ou mauvais compte | Se déconnecter, se reconnecter avec `noamamsellem@gmail.com` |
| 500 "ANTHROPIC_API_KEY missing" | Secret pas configuré | `supabase secrets set ANTHROPIC_API_KEY=…` puis redéployer |
| 502 "Anthropic API error" | Quota dépassé ou clé invalide | Vérifier la clé dans la console Anthropic |
| Aucune syn matchée | OCR du PDF a échoué | Vérifier que le PDF est lisible (pas une photo trop floue) |
| Plein de ⚠️ "Suivi sans minha" | Anthropic n'a pas lu la cellule | Corriger manuellement dans le tableau (toutes les cellules sont éditables) |

## Phase 2 (non implémentée)

Écriture directe dans le Google Sheet via service account. À considérer
si le copier/coller devient pénible. Voir la note dans le spec.
