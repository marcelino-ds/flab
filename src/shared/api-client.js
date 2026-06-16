// Jalur API: panggil LLM langsung via fetch (tanpa membuka tab/menyetir web UI).
// Dipakai background saat Mode API aktif & API key tersedia untuk provider terpilih.
//
// Kenapa terpisah dari injector: jalur API kebal terhadap perubahan DOM situs,
// bisa memaksa JSON mode + temperature 0 (deterministik), dan tak ada cold-load
// SPA per soal. Jalur tab tetap ada sebagai fallback gratis tanpa API key.

import { buildApiSystemInstruction, buildAnswerRules, ANSWER_SHAPE } from './solve-contract.js';

// Bentuk hasil yang dikembalikan ke pemanggil — identik dengan output jalur tab.
// { jawaban: string|string[], index_pilihan: number }

// Pisahkan dataURL "data:image/png;base64,XXXX" jadi { mime, base64 }.
function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

// Normalisasi objek JSON model → bentuk { jawaban, index_pilihan } yang dipakai filler.
function normalizeAnswer(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const jawaban = Array.isArray(obj.jawaban) ? obj.jawaban : String(obj.jawaban ?? '').trim();
  const index_pilihan = Number(obj.index_pilihan ?? 0);
  const isEmpty = Array.isArray(jawaban) ? jawaban.length === 0 : !jawaban;
  if (isEmpty) return null;
  return { jawaban, index_pilihan };
}

// Cari objek JSON pertama yang valid dalam teks bebas (jaga-jaga model membungkus
// JSON dengan teks/markdown walau diminta JSON murni).
function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* lanjut ke ekstraksi */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* lanjut */ } }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* gagal */ } }
  return null;
}

// Bangun prompt user: instruksi tambahan + soal (teks) / penanda gambar.
function buildUserPrompt(payload) {
  const extra = payload.prompt ? payload.prompt + '\n\n' : '';
  if (payload.type === 'solve_image') {
    return extra + 'Selesaikan soal pada gambar berikut.';
  }
  return extra + 'Berikut soalnya:\n\n' + (payload.text || '');
}

// ── Gemini (Google AI Studio / Generative Language API) ─────────────────────────
async function callGemini(apiCfg, key, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiCfg.model}:generateContent?key=${encodeURIComponent(key)}`;
  const parts = [{ text: buildUserPrompt(payload) }];
  if (payload.type === 'solve_image') {
    const img = splitDataUrl(payload.dataUrl);
    if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
  }
  const body = {
    systemInstruction: { parts: [{ text: buildApiSystemInstruction() }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  return parseJsonLoose(text);
}

// ── OpenAI (ChatGPT) ────────────────────────────────────────────────────────────
async function callOpenAI(apiCfg, key, payload) {
  const userContent = payload.type === 'solve_image'
    ? [{ type: 'text', text: buildUserPrompt(payload) }, { type: 'image_url', image_url: { url: payload.dataUrl } }]
    : buildUserPrompt(payload);
  const body = {
    model: apiCfg.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildApiSystemInstruction() },
      { role: 'user', content: userContent },
    ],
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return parseJsonLoose(data?.choices?.[0]?.message?.content ?? '');
}

// ── Anthropic (Claude) ──────────────────────────────────────────────────────────
async function callAnthropic(apiCfg, key, payload) {
  const content = [{ type: 'text', text: buildUserPrompt(payload) }];
  if (payload.type === 'solve_image') {
    const img = splitDataUrl(payload.dataUrl);
    if (img) content.unshift({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
  }
  // Anthropic tak punya JSON mode; arahkan via system + prefill "{" agar output JSON.
  const body = {
    model: apiCfg.model,
    max_tokens: 4096,
    temperature: 0,
    system: buildApiSystemInstruction() + `\nBalas HANYA JSON ${ANSWER_SHAPE}. ${buildAnswerRules()}`,
    messages: [
      { role: 'user', content },
      { role: 'assistant', content: '{' },
    ],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = data?.content?.map(c => c.text).join('') ?? '';
  // Prefill "{" tidak ikut di respons → rekonstruksi sebelum parse.
  return parseJsonLoose(raw.trim().startsWith('{') ? raw : '{' + raw);
}

const CALLERS = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic };

// Panggil provider via API. Mengembalikan { jawaban, index_pilihan } atau melempar.
export async function solveViaApi(provider, key, payload) {
  const apiCfg = provider?.api;
  if (!apiCfg) throw new Error(`Provider ${provider?.id} tak punya konfigurasi API`);
  const caller = CALLERS[apiCfg.kind];
  if (!caller) throw new Error(`Jenis API tak dikenal: ${apiCfg.kind}`);
  const obj = await caller(apiCfg, key, payload);
  const norm = normalizeAnswer(obj);
  if (!norm) throw new Error('Respons API tak berisi jawaban valid');
  return norm;
}

// Ekspor helper internal untuk pengujian unit.
export const __test = { splitDataUrl, normalizeAnswer, parseJsonLoose, buildUserPrompt };
