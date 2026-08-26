// Supabase Edge Function — parse-bulletin
// ============================================================================
// Deux modes :
//
//   mode: "bulletin"  (défaut, ADMIN uniquement)
//       Reçoit le PDF « Kol Villeurbanne » et renvoie la bannière Chabbat +
//       le tableau brut des horaires, cellule par cellule, sans interprétation.
//
//   mode: "horaires"  (§8.4, tout compte connecté)
//       Reçoit UNE photo (panneau d'horaires, feuille affichée, capture) ou UN
//       PDF concernant UNE synagogue, et renvoie les 15 colonnes du Sheet avec
//       un score de confiance par champ et la liste de ce qui reste ambigu.
//
// La clé API ne quitte JAMAIS le serveur : elle est lue depuis les secrets
// Supabase et n'apparaît ni dans index.html, ni dans le dépôt, ni dans un commit.
//
// Fournisseur d'IA : AI_PROVIDER = "anthropic" (défaut) | "gemini".
//   - anthropic → ANTHROPIC_API_KEY, modèle ANTHROPIC_MODEL
//   - gemini    → GEMINI_API_KEY, modèle GEMINI_MODEL (palier gratuit)
// Le reste du code est identique : seul l'appel réseau change.
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PROVIDER = (Deno.env.get("AI_PROVIDER") || "anthropic").toLowerCase();
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const ADMIN_EMAIL = "noamamsellem@gmail.com";
const MAX_BYTES = 10 * 1024 * 1024;          // 10 Mo (§8.4)
const IMPORTS_PER_HOUR = 3;                  // garde-fou (§8.4)
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf",
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const BULLETIN_PROMPT = `Tu reçois le PDF "Kol Villeurbanne". Extrais UNIQUEMENT en JSON, sans aucun texte autour.

1. La bannière Chabbat : \`allumage\`, \`coucher_soleil\`, \`fin_chabbat\`, \`rt\` (format "22h30").
2. Le tableau "Horaires des Offices" : pour CHAQUE ligne de synagogue, renvoie \`{ nom, adresse, vendredi, chabbat, dimanche, lundi_jeudi, mardi_mercredi }\` où chaque jour est un tableau ordonné des cellules LUES telles quelles (ex: ["6h45","19h15","Suivi"], ou ["8h00 - 9h00","19h35","Suivi 19h30"]). Garde "Suivi", les plages "Xh-Yh", et les mots tels qu'écrits. NE calcule rien, NE complète rien.

Format : { "banniere": {...}, "synagogues": [ {...}, ... ] }

⚠️ Le tableau s'étale sur 2-3 pages. Lis-les toutes. Les colonnes sont : Vendredi | Chabbat | Dimanche | Lundi/Jeudi | Mardi/Mercredi.`;

const HORAIRES_PROMPT = `Tu reçois la photo ou le PDF des horaires de prière d'UNE seule synagogue.

Réponds UNIQUEMENT par du JSON strict, sans texte autour, sans bloc de code.

Format exact :
{
  "horaires": {
    "ven_sh": null, "ven_mi": null, "ven_ar": null,
    "shab_sh": null, "shab_mi": null, "shab_ar": null,
    "dim_sh": null, "dim_mi": null, "dim_ar": null,
    "lj_sh": null,  "lj_mi": null,  "lj_ar": null,
    "mm_sh": null,  "mm_mi": null,  "mm_ar": null
  },
  "confiance": { "ven_sh": 0.0 },
  "ambigus": ["texte de ce qui n'est pas lisible ou interprétable"]
}

Règles de lecture :
- Colonnes : ven = vendredi, shab = chabbat, dim = dimanche, lj = lundi et jeudi, mm = mardi et mercredi.
- Lignes : sh = Shaharit (matin), mi = Minha (après-midi), ar = Arvit (soir).
- Format des heures : "7h00", "13h15", "19h35". Conserve "Suivi" tel quel si c'est écrit.
- Mets null pour tout créneau absent. N'INVENTE JAMAIS une heure.
- "confiance" : un nombre entre 0 et 1 pour CHAQUE champ non nul, reflétant ta certitude de lecture.
- "ambigus" : liste tout ce que tu n'as pas su lire avec certitude (rature, flou, ambiguïté de colonne).
- Si le document ne contient pas de tableau d'horaires de prière, renvoie {"erreur":"pas_un_tableau_horaires"}.`;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
    return JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function extractJson(text: string): any {
  try { return JSON.parse(text); } catch { /* suite */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* suite */ } }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* suite */ }
  }
  return null;
}

function base64Bytes(b64: string): number {
  const padding = (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return Math.floor(b64.length * 3 / 4) - padding;
}

// Garde-fou : 3 imports par utilisateur et par heure (§8.4).
// S'appuie sur la table public.ai_usage ; si elle est absente, on laisse passer
// plutôt que de bloquer un utilisateur légitime, mais on le signale.
async function checkRateLimit(userId: string): Promise<{ ok: boolean; detail?: string }> {
  if (!SUPABASE_URL || !SERVICE_ROLE || !userId) return { ok: true, detail: "rate-limit non appliqué" };
  const since = new Date(Date.now() - 3600_000).toISOString();
  try {
    const url = `${SUPABASE_URL}/rest/v1/ai_usage?user_id=eq.${userId}&created_at=gte.${since}&select=id`;
    const res = await fetch(url, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, Prefer: "count=exact" },
    });
    if (!res.ok) return { ok: true, detail: "rate-limit indisponible" };
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length >= IMPORTS_PER_HOUR) return { ok: false };
    await fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ user_id: userId }),
    });
    return { ok: true };
  } catch {
    return { ok: true, detail: "rate-limit indisponible" };
  }
}

// ---------------------------------------------------------------------------
// Appels aux fournisseurs — même entrée, même sortie
// ---------------------------------------------------------------------------
async function callAnthropic(prompt: string, b64: string, mime: string): Promise<string> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY manquante côté serveur");
  const block = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: mime, data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  return (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("\n");
}

async function callGemini(prompt: string, b64: string, mime: string): Promise<string> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY manquante côté serveur");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8000 },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p: any) => p.text || "").join("\n");
}

function callModel(prompt: string, b64: string, mime: string): Promise<string> {
  return PROVIDER === "gemini" ? callGemini(prompt, b64, mime) : callAnthropic(prompt, b64, mime);
}

// ---------------------------------------------------------------------------
// §8.4 — règles métier appliquées CÔTÉ SERVEUR, jamais laissées à l'IA
// ---------------------------------------------------------------------------
const NO_SHAB_AR_IDS = new Set([1, 5, 6, 10, 13, 26, 27, 29, 31, 32, 33]);
const FIXED_SHAB_AR: Record<number, string> = { 11: "22h00", 17: "22h09", 25: "21h00" };
const FIELDS = [
  "ven_sh", "ven_mi", "ven_ar", "shab_sh", "shab_mi", "shab_ar",
  "dim_sh", "dim_mi", "dim_ar", "lj_sh", "lj_mi", "lj_ar", "mm_sh", "mm_mi", "mm_ar",
];

function toMinutes(s: string): number | null {
  const m = String(s).trim().match(/^(\d{1,2})\s*[h:]\s*(\d{0,2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2] || "0", 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function fromMinutes(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, "0")}h${String(n % 60).padStart(2, "0")}`;
}

// Fourchettes plausibles : au-delà, la valeur est marquée ambiguë, jamais appliquée.
const PLAUSIBLE: Record<string, [number, number]> = {
  sh: [5 * 60, 10 * 60 + 30],
  mi: [11 * 60 + 30, 21 * 60],
  ar: [16 * 60, 23 * 60 + 30],
};

function applyBusinessRules(
  horaires: Record<string, string | null>,
  confiance: Record<string, number>,
  synId: number | null,
  rite: string,
  finChabbat: string | null,
) {
  const out: Record<string, string | null> = { ...horaires };
  const ambigus: string[] = [];

  for (const f of FIELDS) {
    let v = out[f];
    if (v == null || v === "") { out[f] = null; continue; }
    v = String(v).trim();

    // « Suivi » → arvit = minha + 20 min ; « Suivi 20h30 » → 20h30.
    if (/^suivi/i.test(v)) {
      const explicit = v.match(/(\d{1,2}\s*[h:]\s*\d{0,2})/);
      if (explicit) {
        out[f] = explicit[1].replace(/\s/g, "").replace(":", "h");
      } else if (f.endsWith("_ar")) {
        const minha = out[f.replace(/_ar$/, "_mi")];
        const mm = minha ? toMinutes(minha) : null;
        if (mm == null) { ambigus.push(`${f} : « Suivi » sans minha lisible`); out[f] = null; continue; }
        out[f] = fromMinutes(mm + 20);
      } else {
        ambigus.push(`${f} : « Suivi » hors colonne Arvit`);
        out[f] = null; continue;
      }
      v = out[f] as string;
    }

    // Plage « 8h00 - 9h00 » : on retient la première heure et on signale.
    const range = v.match(/^(\d{1,2}\s*[h:]\s*\d{0,2})\s*[-–]\s*(\d{1,2}\s*[h:]\s*\d{0,2})$/);
    if (range) {
      out[f] = range[1].replace(/\s/g, "").replace(":", "h");
      ambigus.push(`${f} : plage « ${v} » — première heure retenue, à confirmer`);
      v = out[f] as string;
    }

    const mins = toMinutes(v);
    if (mins == null) { ambigus.push(`${f} : « ${v} » illisible`); out[f] = null; continue; }

    const kind = f.slice(-2);
    const [lo, hi] = PLAUSIBLE[kind] || [0, 1439];
    if (mins < lo || mins > hi) {
      ambigus.push(`${f} : ${v} hors plage plausible — non appliqué`);
      out[f] = null;
      continue;
    }
    out[f] = fromMinutes(mins);
  }

  // shab_ar = sortie de Chabbat de la semaine, jamais minha + 20.
  if (finChabbat && toMinutes(finChabbat) != null) {
    out.shab_ar = fromMinutes(toMinutes(finChabbat)!);
  }
  // Exceptions fixes, prioritaires sur tout le reste.
  if (synId != null && FIXED_SHAB_AR[synId]) out.shab_ar = FIXED_SHAB_AR[synId];
  if (synId != null && NO_SHAB_AR_IDS.has(synId)) out.shab_ar = null;
  // Rite Habad : pas d'arvit de Chabbat.
  if (String(rite).toLowerCase() === "habad") out.shab_ar = null;
  // Collel Na'halat Moché (id 5) : dim_ar = tzeit, pas de shab_ar.
  if (synId === 5) out.shab_ar = null;

  // Confiance faible → décoché par défaut côté client, jamais appliqué en aveugle.
  for (const f of FIELDS) {
    const c = confiance?.[f];
    if (out[f] != null && typeof c === "number" && c < 0.75) {
      ambigus.push(`${f} : confiance faible (${c.toFixed(2)})`);
    }
  }
  return { horaires: out, ambigus };
}

// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return jsonResponse({ error: "Missing bearer token" }, 401);

  const payload = decodeJwt(token);
  const email = (payload && typeof payload.email === "string") ? payload.email.toLowerCase() : "";
  const userId = (payload && typeof payload.sub === "string") ? payload.sub : "";
  if (!email) return jsonResponse({ error: "Jeton invalide" }, 401);

  let body: any;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const mode = body?.mode === "horaires" ? "horaires" : "bulletin";

  // -------------------------------------------------------------- bulletin --
  if (mode === "bulletin") {
    if (email !== ADMIN_EMAIL) return jsonResponse({ error: "Forbidden" }, 403);
    const pdf = body?.pdf_base64;
    if (!pdf || typeof pdf !== "string" || pdf.length < 100) {
      return jsonResponse({ error: "Missing or invalid pdf_base64" }, 400);
    }
    if (base64Bytes(pdf) > MAX_BYTES) return jsonResponse({ error: "Fichier trop volumineux (max 10 Mo)" }, 413);
    try {
      const raw = await callModel(BULLETIN_PROMPT, pdf, "application/pdf");
      return jsonResponse({ raw_text: raw, parsed: extractJson(raw), provider: PROVIDER });
    } catch (e) {
      return jsonResponse({ error: "Erreur du fournisseur d'IA", detail: String(e) }, 502);
    }
  }

  // -------------------------------------------------------------- horaires --
  // Ouvert à tout compte connecté : c'est le point d'entrée §8.4 de l'app.
  const file = body?.file_base64;
  const mime = String(body?.mime || "");
  if (!file || typeof file !== "string" || file.length < 100) {
    return jsonResponse({ error: "Missing or invalid file_base64" }, 400);
  }
  if (!ALLOWED_MIME.has(mime)) {
    return jsonResponse({ error: `Type de fichier non accepté : ${mime || "inconnu"}` }, 415);
  }
  if (base64Bytes(file) > MAX_BYTES) {
    return jsonResponse({ error: "Fichier trop volumineux (max 10 Mo)" }, 413);
  }

  const rl = await checkRateLimit(userId);
  if (!rl.ok) {
    return jsonResponse({ error: `Limite atteinte : ${IMPORTS_PER_HOUR} imports par heure. Réessayez plus tard.` }, 429);
  }

  let raw: string;
  try {
    raw = await callModel(HORAIRES_PROMPT, file, mime);
  } catch (e) {
    return jsonResponse({ error: "Erreur du fournisseur d'IA", detail: String(e) }, 502);
  }

  const parsed = extractJson(raw);
  if (!parsed || parsed.erreur === "pas_un_tableau_horaires") {
    // Aucune écriture : on le dit clairement plutôt que d'inventer (§8.4).
    return jsonResponse({
      error: "document_illisible",
      message: "Je n'ai pas réussi à lire ce document — voulez-vous saisir manuellement ?",
      raw_text: raw,
    }, 422);
  }

  const synId = Number.isFinite(body?.syn_id) ? Number(body.syn_id) : null;
  const { horaires, ambigus } = applyBusinessRules(
    parsed.horaires || {},
    parsed.confiance || {},
    synId,
    String(body?.rite || ""),
    body?.fin_chabbat ? String(body.fin_chabbat) : null,
  );

  return jsonResponse({
    provider: PROVIDER,
    horaires,
    confiance: parsed.confiance || {},
    ambigus: [...(parsed.ambigus || []), ...ambigus],
    raw_text: raw,
    rate_limit_note: rl.detail || null,
  });
});
