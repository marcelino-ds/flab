// Deteksi & ekstraksi gambar soal + komposit canvas untuk dikirim ke AI.

// Gambar bermakna: bukan icon/sprite/spacer dan minimal 50x50. Satu sumber kebenaran
// agar detect & extract tidak divergen.
export function isMeaningfulImage(img) {
  const src = (img.src || '').toLowerCase();
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  const isIcon = src.includes('icon') || src.includes('sprite') ||
                 src.includes('data:image/svg') || src.includes('1x1') ||
                 src.includes('pixel') || src.includes('blank') ||
                 src.includes('spacer') || src.includes('bullet');
  return !isIcon && w > 50 && h > 50;
}

// Cek teks soal (.qtext) DAN pilihan jawaban (.answer) karena gambar bisa ada di opsi
export function detectQuestionImages(activeQueEl) {
  if (!activeQueEl) return false;
  const searchAreas = [
    activeQueEl.querySelector('.qtext'),
    activeQueEl.querySelector('.answer'),
    activeQueEl.querySelector('.formulation'),
  ].filter(Boolean);

  for (const area of searchAreas) {
    for (const img of area.querySelectorAll('img[src]')) {
      if (isMeaningfulImage(img)) return true;
    }
  }
  return false;
}

// Extract all meaningful img elements (untuk composite canvas). Dedup by src.
export function extractQuestionImages(activeQueEl) {
  const found = [];
  const seenSrcs = new Set();

  if (!activeQueEl) return found;

  // Hanya cek .qtext dan .answer — jangan .formulation karena itu parent dari keduanya
  // (akan menyebabkan gambar terhitung 2x jika .formulation ikut discan)
  const areas = [
    activeQueEl.querySelector('.qtext'),
    activeQueEl.querySelector('.answer'),
  ].filter(Boolean);

  for (const area of areas) {
    for (const img of area.querySelectorAll('img[src]')) {
      const src = img.src || '';
      if (isMeaningfulImage(img) && !seenSrcs.has(src)) {
        seenSrcs.add(src);
        found.push(img);
      }
    }
  }

  return found;
}

// Stitch beberapa img jadi 1 komposit canvas. Layout: 1 kolom jika <=2 gambar,
// 2-kolom grid jika lebih. Tiap gambar diberi label A/B/C/D.
export async function stitchImages(imgElements) {
  const LABEL_OPTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const COLS = imgElements.length <= 2 ? 1 : 2;
  const COL_W = 440;          // lebar per kolom (px)
  const PAD = 12;              // padding antar gambar
  const LABEL_H = 30;         // tinggi area label di atas gambar
  const BG = '#f4f4f4';
  const ACCENT = '#2563eb';   // warna label badge

  // Kumpulkan dimensi tiap gambar
  const items = imgElements.map((imgEl, i) => {
    const w = imgEl.naturalWidth || imgEl.width || COL_W;
    const h = imgEl.naturalHeight || imgEl.height || 200;
    const scale = Math.min(1, COL_W / w);
    return { imgEl, sw: Math.round(w * scale), sh: Math.round(h * scale), label: LABEL_OPTS[i] || String(i + 1) };
  }).filter(it => it.sw > 0 && it.sh > 0);

  if (items.length === 0) return null;

  const rows = Math.ceil(items.length / COLS);

  // Hitung tinggi tiap baris (ambil gambar tertinggi di baris itu)
  const rowHeights = [];
  for (let r = 0; r < rows; r++) {
    let maxH = 0;
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      if (idx < items.length) maxH = Math.max(maxH, items[idx].sh + LABEL_H);
    }
    rowHeights.push(maxH);
  }

  const totalW = COLS * COL_W + (COLS - 1) * PAD;
  const totalH = rowHeights.reduce((a, b) => a + b, 0) + (rows - 1) * PAD;

  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, totalW, totalH);

  try {
    let y = 0;
    for (let r = 0; r < rows; r++) {
      let x = 0;
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        if (idx >= items.length) break;
        const { imgEl, sw, sh, label } = items[idx];

        // Label badge
        ctx.fillStyle = ACCENT;
        ctx.fillRect(x, y, COL_W, LABEL_H);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 15px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Pilihan ${label}`, x + 10, y + 20);

        // Gambar
        ctx.drawImage(imgEl, x, y + LABEL_H, sw, sh);

        // Border tipis
        ctx.strokeStyle = '#d1d5db';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, COL_W, sh + LABEL_H);

        x += COL_W + PAD;
      }
      y += rowHeights[r] + PAD;
    }

    return canvas.toDataURL('image/png');
  } catch (e) {
    // CORS error saat drawImage — canvas tainted
    console.warn('[FLAB] stitchImages: canvas tainted (CORS), will fallback.', e);
    return null;
  }
}
