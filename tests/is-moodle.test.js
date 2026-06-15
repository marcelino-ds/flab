import { describe, it, expect, afterEach } from 'vitest';
import { isMoodle, detectPlatform } from '../src/content/platform.js';

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('isMoodle — deteksi via penanda DOM', () => {
  it('true bila ada elemen .que', () => {
    document.body.innerHTML = '<div class="que multichoice"></div>';
    expect(isMoodle()).toBe(true);
  });

  it('true bila ada #responseform', () => {
    document.body.innerHTML = '<form id="responseform"></form>';
    expect(isMoodle()).toBe(true);
  });

  it('true bila ada [id^="question-"]', () => {
    document.body.innerHTML = '<div id="question-123"></div>';
    expect(isMoodle()).toBe(true);
  });

  it('true bila body class mengandung path-mod-quiz', () => {
    document.body.className = 'path-mod-quiz pagelayout-incourse';
    expect(isMoodle()).toBe(true);
  });

  it('true bila body class mengandung format- (course format Moodle)', () => {
    document.body.className = 'format-topics';
    expect(isMoodle()).toBe(true);
  });

  it('false untuk halaman biasa tanpa penanda Moodle', () => {
    document.body.innerHTML = '<div class="content"><p>Halaman biasa</p></div>';
    document.body.className = 'home dark-theme';
    expect(isMoodle()).toBe(false);
  });

  it('detectPlatform: moodle bila isMoodle true, generic bila tidak', () => {
    document.body.innerHTML = '<div class="que"></div>';
    expect(detectPlatform()).toBe('moodle');
    document.body.innerHTML = '<p>bukan moodle</p>';
    document.body.className = '';
    expect(detectPlatform()).toBe('generic');
  });
});

// Catatan: jalur deteksi via location.pathname ('/mod/quiz/') tidak diunit-test di
// sini karena happy-dom tidak mengizinkan set location.pathname secara bersih;
// jalur itu diverifikasi di browser nyata. Penanda DOM + body class sudah mencakup
// mayoritas kasus dan deterministik di sini.
