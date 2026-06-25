// Kontrak prompt + parsing jawaban — SATU sumber kebenaran untuk kedua jalur:
// jalur tab (injector menyetir web UI) dan jalur API (background fetch langsung).
//
// Desain prompt: model BOLEH menalar dulu seperlunya (langkah penuh untuk soal
// hitungan), lalu WAJIB menutup dengan satu blok JSON. Memaksa "JSON only, no
// reasoning" ATAU membatasi reasoning terlalu pendek terbukti menurunkan akurasi
// pada soal yang butuh langkah (koding, matematika, MCQ multi-langkah). Extractor
// selalu mengambil blok JSON TERAKHIR, jadi reasoning di depan aman.

// Bentuk JSON jawaban yang diharapkan dari model.
export const ANSWER_SHAPE = '{ "jawaban": "<teks/array/kode>", "index_pilihan": <nomor> }';

// Aturan pengisian per tipe soal. Dipakai apa adanya di jalur tab (ditempel ke
// prompt) dan sebagai instruksi sistem di jalur API.
export function buildAnswerRules() {
  return `Aturan pengisian "jawaban" & "index_pilihan":
- PILIHAN GANDA (1 jawaban) → Opsi sudah DIBERI NOMOR di daftar "Opsi". "index_pilihan": nomor opsi benar PERSIS dari daftar (1/2/3/...). "jawaban": salin teks opsi itu apa adanya. NOMOR penentu utama.
- PILIHAN GANDA MULTI-SELECT (pilih satu atau lebih) → "jawaban": ["teks opsi 1", "teks opsi 2"] (salin persis dari daftar Opsi), "index_pilihan": 0.
- TRUE/FALSE → "jawaban": "True" atau "False", "index_pilihan": nomor opsi sesuai daftar (biasanya 1 atau 2).
- ISIAN SINGKAT / NUMERIK / CLOZE → "jawaban": jawaban presisi. Untuk NUMERIK: tulis ANGKA saja (mis. "42" atau "3.14"), tanpa satuan/teks kecuali soal memintanya, gunakan titik untuk desimal, jangan dibulatkan kecuali diminta. Jika ADA LEBIH DARI SATU kotak isian, WAJIB array of strings sesuai urutan kotak: ["isi 1", "isi 2"]. Jika 1 kotak, string biasa. "index_pilihan": 0.
- MENJODOHKAN/MATCH → "jawaban": array of strings, satu per baris SESUAI URUTAN baris yang diberikan. Tiap elemen = teks pilihan yang benar untuk baris itu (salin PERSIS dari daftar "Pilihan yang tersedia"). "index_pilihan": 0.
- KODING/CODING → "jawaban": SELURUH kode program LENGKAP dari baris pertama sampai terakhir (gunakan \\n untuk baris baru), "index_pilihan": 0. Jika ada kode template, SERTAKAN juga template tersebut — jangan dihapus.
- ESSAY → "jawaban": jawaban lengkap, "index_pilihan": 0.
PENTING: Untuk pilihan ganda 1 jawaban, "index_pilihan" HARUS cocok dengan nomor opsi di daftar "Opsi" dan "jawaban" HARUS sama dengan teks opsi pada nomor itu.`;
}

// Jalur TAB: ditempel ke akhir prompt yang dikirim ke web UI. Model boleh menalar
// singkat, lalu menutup dengan satu blok JSON yang akan diekstrak.
export function buildAutoSolveRules() {
  return `

Selesaikan soal di atas. Kerjakan langkah demi langkah bila perlu — untuk soal HITUNGAN/MATEMATIKA, tuliskan langkah perhitungan secara penuh dan hitung ulang (verifikasi) sebelum menyimpulkan. Jangan terburu-buru ke jawaban.
SETELAH selesai menalar, WAJIB akhiri jawabanmu dengan TEPAT SATU blok JSON berikut sebagai baris terakhir — tanpa teks apa pun sesudahnya:
\`\`\`json
${ANSWER_SHAPE}
\`\`\`
${buildAnswerRules()}
Blok JSON harus menjadi bagian PALING AKHIR dari responsmu.`;
}

// Jalur API: instruksi sistem. Di sini kita bisa memaksa JSON-only karena model API
// mendukung response schema / JSON mode, jadi tak perlu menalar di teks bebas.
export function buildApiSystemInstruction() {
  return `Kamu adalah mesin penjawab soal kuis. Balas HANYA dengan satu objek JSON valid berbentuk ${ANSWER_SHAPE}.
${buildAnswerRules()}`;
}
