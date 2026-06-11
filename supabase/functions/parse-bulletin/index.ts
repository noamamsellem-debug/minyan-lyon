// Supabase Edge Function — parse-bulletin
// Reçoit un PDF du bulletin "Kol Villeurbanne" en base64, vérifie que
// l'appelant est l'admin autorisé (via le JWT Supabase), puis demande à
// l'API Anthropic d'extraire les horaires des offices au format JSON.
// La clé ANTHROPIC_API_KEY reste côté serveur — elle n'est jamais
// exposée au navigateur.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ALLOWED_EMAIL = "noamamsellem@gmail.com";
const MODEL = "claude-opus-4-8";

const EXTRACTION_PROMPT = `Tu reçois le PDF "Kol Villeurbanne". Extrais UNIQUEMENT en JSON, sans aucun texte autour.

1. La bannière Chabbat : \`allumage\`, \`coucher_soleil\`, \`fin_chabbat\`, \`rt\` (format "22h30").
2. Le tableau "Horaires des Offices" : pour CHAQUE ligne de synagogue, renvoie \`{ nom, adresse, vendredi, chabbat, dimanche, lundi_jeudi, mardi_mercredi }\` où chaque jour est un tableau ordonné des cellules LUES telles quelles (ex: ["6h45","19h15","Suivi"], ou ["8h00 - 9h00","19h35","Suivi 19h30"]). Garde "Suivi", les plages "Xh-Yh", et les mots tels qu'écrits. NE calcule rien, NE complète rien.

Format : { "banniere": {...}, "synagogues": [ {...}, ... ] }

⚠️ Le tableau s'étale sur 2-3 pages. Lis-les toutes. Les colonnes sont : Vendredi | Chabbat | Dimanche | Lundi/Jeudi | Mardi/Mercredi.`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractJson(text: string): unknown {
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!ANTHROPIC_KEY) return jsonResponse({ error: "Server misconfigured: ANTHROPIC_API_KEY missing" }, 500);

  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return jsonResponse({ error: "Missing bearer token" }, 401);

  const payload = decodeJwt(token);
  const email = (payload && typeof payload.email === "string") ? payload.email.toLowerCase() : "";
  if (email !== ALLOWED_EMAIL) return jsonResponse({ error: "Forbidden" }, 403);

  let body: { pdf_base64?: string };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const pdf = body?.pdf_base64;
  if (!pdf || typeof pdf !== "string" || pdf.length < 100) {
    return jsonResponse({ error: "Missing or invalid pdf_base64" }, 400);
  }

  const anthropicBody = {
    model: MODEL,
    max_tokens: 8000,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
        { type: "text", text: EXTRACTION_PROMPT },
      ],
    }],
  };

  let apiRes: Response;
  try {
    apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (e) {
    return jsonResponse({ error: "Network error calling Anthropic", detail: String(e) }, 502);
  }

  const text = await apiRes.text();
  if (!apiRes.ok) return jsonResponse({ error: "Anthropic API error", status: apiRes.status, detail: text }, 502);

  let data: { content?: Array<{ type: string; text?: string }> };
  try { data = JSON.parse(text); }
  catch { return jsonResponse({ error: "Bad Anthropic response", detail: text }, 502); }

  const raw = (data.content || []).filter(c => c.type === "text").map(c => c.text || "").join("\n");
  const parsed = extractJson(raw);

  return jsonResponse({ raw_text: raw, parsed });
});
