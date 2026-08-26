#!/usr/bin/env node
// ============================================================================
// Minyan Lyon — §8.6 · migration one-shot Google Sheets → Supabase
// ============================================================================
// Importe l'onglet des synagogues publié en CSV dans les tables `synagogues`
// et `horaires`, EN PRÉSERVANT LES id : ce sont les clés de tout le système de
// versions (contributions, vérifications, référents).
//
//   node scripts/import-sheets.mjs --dry-run     # n'écrit rien, montre le plan
//   node scripts/import-sheets.mjs               # applique
//
// Variables d'environnement requises pour l'écriture :
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=eyJ...      (jamais committée, jamais côté client)
//
// Le script est idempotent : relancé, il met à jour les lignes existantes
// (upsert sur id) et n'en supprime aucune.
// ============================================================================

const SHEET_CSV =
  process.env.SHEET_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRZHKnTM1IHkAR77WG-YM8ZANU-QoFtC77SQ2s-LV-A0CUAELi7l-jf6OEjoPx1g7pz6mQccdhWhujs/pub?gid=0&single=true&output=csv';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DRY = process.argv.includes('--dry-run');

// Colonnes du Sheet, dans l'ordre.
const HEADER = [
  'id', 'name', 'addr', 'rite', 'zone', 'lat', 'lng',
  'ven_sh', 'ven_mi', 'ven_ar',
  'shab_sh', 'shab_mi', 'shab_ar',
  'dim_sh', 'dim_mi', 'dim_ar',
  'lj_sh', 'lj_mi', 'lj_ar',
  'mm_sh', 'mm_mi', 'mm_ar',
];
const HORAIRE_COLS = HEADER.slice(7);

// Synagogues retirées du site à la demande de la communauté : la ligne reste
// dans le Sheet et est importée, mais l'app ne l'affiche pas (§6).
const HIDDEN = [/cerj/i];

// Plage plausible pour l'agglomération lyonnaise (§6 : deux longitudes ont
// déjà été corrompues en dates dans le Sheet).
const LAT_RANGE = [45.0, 46.2];
const LNG_RANGE = [4.0, 5.5];

function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  for (const line of lines) {
    const cols = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += c;
    }
    cols.push(cur);
    rows.push(cols);
  }
  return rows;
}

function coord(raw, range, label) {
  const v = parseFloat(String(raw).replace(',', '.'));
  if (Number.isFinite(v) && v >= range[0] && v <= range[1]) return v;
  warnings.push(`${label} invalide : ${JSON.stringify(raw)} → laissé à null, à corriger dans le Sheet`);
  return null;
}

const warnings = [];

async function main() {
  console.log(`→ Lecture du Sheet…`);
  const res = await fetch(SHEET_CSV, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Sheet inaccessible : HTTP ${res.status}`);
  const rows = parseCSV(await res.text());
  if (rows.length < 2) throw new Error('Sheet vide ou illisible');

  const synagogues = [];
  const horaires = [];
  const seen = new Set();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || !r[1]) continue;
    const id = parseInt(r[0], 10);
    if (!Number.isFinite(id)) { warnings.push(`ligne ${i + 1} : id « ${r[0]} » illisible — ignorée`); continue; }
    if (seen.has(id)) { warnings.push(`id ${id} en double — seule la première ligne est conservée`); continue; }
    seen.add(id);

    const name = r[1].trim();
    synagogues.push({
      id,
      name,
      addr: (r[2] || '').trim() || null,
      rite: (r[3] || 'sefarde').trim(),
      zone: (r[4] || 'villeurb').trim(),
      lat: coord(r[5], LAT_RANGE, `lat de « ${name} » (id ${id})`),
      lng: coord(r[6], LNG_RANGE, `lng de « ${name} » (id ${id})`),
      hidden: HIDDEN.some(re => re.test(name)),
    });

    const h = { syn_id: id };
    HORAIRE_COLS.forEach((col, k) => {
      const v = (r[7 + k] || '').trim();
      h[col] = v || null;
    });
    horaires.push(h);
  }

  console.log(`→ ${synagogues.length} synagogues, ${horaires.length} lignes d'horaires.`);
  const hidden = synagogues.filter(s => s.hidden).map(s => `${s.id} ${s.name}`);
  if (hidden.length) console.log(`→ Masquées à l'affichage (importées quand même) : ${hidden.join(', ')}`);
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} avertissement(s) :`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }

  if (DRY) {
    console.log('\n--dry-run : aucune écriture. Exemple de ligne :');
    console.log(JSON.stringify({ synagogue: synagogues[0], horaire: horaires[0] }, null, 2));
    return;
  }
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis pour écrire (ou utilisez --dry-run)');
  }

  await upsert('synagogues', synagogues.map(({ hidden, ...s }) => s), 'id');
  await upsert('horaires', horaires, 'syn_id');
  console.log('\n✅ Import terminé. Les id du Sheet ont été préservés à l\'identique.');
}

async function upsert(table, rows, conflictCol) {
  console.log(`→ Upsert de ${rows.length} lignes dans « ${table} »…`);
  // Par paquets de 100 : au-delà, PostgREST rejette les payloads trop longs.
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCol}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`${table} : HTTP ${res.status} — ${await res.text()}`);
  }
}

main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
