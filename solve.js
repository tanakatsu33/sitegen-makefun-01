// sitegen-makefun: a fast, dependency-free drop-in for makefun-site 1.0.0's build(input).
// run(input) returns, byte for byte, what makefun-site 1.0.0 returns. Every cache lives inside one run() call;
// the module-level values below are immutable constants only.

import { setFlagsFromString } from 'node:v8';

// V8 tuning (main.ts: "an entry may tune V8's flags too"). A build runs once per case in a short-lived process on
// one CPU, where TurboFan's compiles of the big Markdown functions cost more than they ever win back; Maglev's code is
// ready far sooner and fast enough. Set before any of this module's functions run.
setFlagsFromString('--max-opt=2');

// ------------------------------------------------------------------ immutable tables

/** Char codes a backslash escapes in inline Markdown: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE = (() => {
  const t = new Uint8Array(128);
  for (const ch of '\\`*_[]()#+-.!>') t[ch.charCodeAt(0)] = 1;
  return t;
})();

const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WS = /\s/;

// Global regexes below are only ever used with lastIndex set right before each use (no state survives a call).
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const WORD_RE = /\S+/g;
const WORDS16_RE = /\s*\S+(?:\s+\S+){15}/y;
/** A newline before a line that may end a paragraph (blank, fence, heading or thematic break), or before the end. */
const PARA_END_RE = /\n(?=[ \t\n`#*-]|$)/g;
/** Inside a paragraph, a line that opens or ends on a space or tab (so needs trimming). */
const NEEDS_TRIM_RE = /[ \t]\n|\n[ \t]/;
/** A closing fence line, from the newline before it. */
const FENCE_CLOSE_NL_RE = /\n```[ \t]*(?=\n|$)/g;
const SPECIAL_RE = /[\\`*[]/g;
const STAR_RE = /[\\*]/g;
const BRACKET_RE = /[\\\]]/g;
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39);/g;
const FLAT_RE = /^/;

/**
 * `s`, flattened in place: a regex needs a flat subject, so V8 turns a concatenation tree into one flat string. Done
 * on strings that are reused or kept (memoized fragments, page bodies, finished pages), it saves re-walking rope
 * nodes later and lets them die young instead of being copied by the scavenger.
 */
function flat(s) {
  FLAT_RE.test(s);
  return s;
}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

const KIND_KEYS = Object.freeze({ page: Object.freeze(['page']), index: Object.freeze(['posts', 'pager']), tag: Object.freeze(['tag']), tags: Object.freeze([]) });
const DYN_NAMES = Object.freeze(['page', 'posts', 'pager', 'tag']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.hasOwn;

// ------------------------------------------------------------------ text

const escOne = (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');

/** HTML escape: native scan; the string itself when nothing needs escaping, else one flat result. */
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, escOne) : s;
}

const unescOne = (m) => (m === '&amp;' ? '&' : m === '&lt;' ? '<' : m === '&gt;' ? '>' : m === '&quot;' ? '"' : "'");

/** The inverse of esc (exact, since every & in escaped text opens one of its five entities). */
function unesc(s) {
  return s.indexOf('&') === -1 ? s : s.replace(ENTITY_RE, unescOne);
}

function slugifyRaw(text) {
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  let runStart = -1;
  const n = plain.length;
  // Build from runs of kept characters; lowercase A-Z per run.
  for (let i = 0; i < n; i++) {
    const c = plain.charCodeAt(i);
    const keep = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
    if (!keep) {
      if (runStart !== -1) {
        out += plain.slice(runStart, i);
        runStart = -1;
      }
      gap = out.length > 0;
      continue;
    }
    if (runStart === -1) {
      if (gap) out += '-';
      gap = false;
      runStart = i;
    }
  }
  if (runStart !== -1) out += plain.slice(runStart);
  out = out.toLowerCase();
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * Words: runs of non-\s characters, counted natively 16 at a time. WORDS16_RE is sticky: from 0 or a word's end it
 * takes the whitespace before and then exactly 16 whole words (each \S+ must run up to whitespace or the end, since
 * \s+ follows it), so its matches tile the words from the left; the fewer than 16 left are counted one by one.
 */
function countWords(s) {
  let w = 0;
  let pos = 0;
  WORDS16_RE.lastIndex = 0;
  while (WORDS16_RE.test(s)) {
    w += 16;
    pos = WORDS16_RE.lastIndex;
  }
  WORD_RE.lastIndex = pos;
  while (WORD_RE.test(s)) w++;
  return w;
}

// ------------------------------------------------------------------ front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * { data, start } (the body is text.slice(start)) or { error }. Scans by offsets: the first line must be exactly
 * "---" and the front matter closes at the next line exactly "---".
 */
function parseFrontMatter(text) {
  const len = text.length;
  if (!(text.startsWith('---') && (len === 3 || text.charCodeAt(3) === 10))) return { error: 'no front matter' };
  let close = -1;
  let p = 3;
  while (true) {
    p = text.indexOf('\n---', p);
    if (p === -1) break;
    const q = p + 4;
    if (q === len || text.charCodeAt(q) === 10) {
      close = p + 1;
      break;
    }
    p = q;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = 4;
  for (let lineNo = 2; ls < close; lineNo++) {
    const le = text.indexOf('\n', ls);
    const line = text.slice(ls, le);
    ls = le + 1;
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, start: close + 4 };
}

// ------------------------------------------------------------------ markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** heading match [depth, text] or null */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : m;
}

/** Whether src[a, b) is spaces and tabs only. */
function blankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the line src[a, b) ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraphAt(src, a, b) {
  if (a === b) return true;
  const c = src.charCodeAt(a);
  if (c === 32 || c === 9) return blankRange(src, a, b);
  if (c === 96) return FENCE_OPEN.test(src.slice(a, b));
  if (c === 35) return headingOf(src.slice(a, b)) !== null;
  if (c === 45 || c === 42) return HR.test(src.slice(a, b));
  return false;
}

// The inline scanners below run on HTML-escaped text. Entities (&amp; &lt; &gt; &quot; &#39;) hold none of the
// characters they look for, so every search finds what it finds in the raw text; the one escapable character that
// escaping changes is '>', so a raw "\>" appears as "\&gt;".

const isEscapable = (d) => d < 128 && ESCAPABLE[d] === 1;

/** findUnescaped(s, ']', from) of the reference. */
function findBracket(s, from) {
  const n = s.length;
  let j = from;
  while (j < n) {
    BRACKET_RE.lastIndex = j;
    if (!BRACKET_RE.test(s)) return -1;
    j = BRACKET_RE.lastIndex - 1;
    if (s.charCodeAt(j) === 93) return j;
    j += j + 1 < n && isEscapable(s.charCodeAt(j + 1)) ? 2 : 1;
  }
  return -1;
}

/** findUnescaped(s, '**', from) of the reference. */
function findDoubleStar(s, from) {
  const n = s.length;
  let j = from;
  while (j <= n - 2) {
    STAR_RE.lastIndex = j;
    if (!STAR_RE.test(s)) return -1;
    j = STAR_RE.lastIndex - 1;
    if (j > n - 2) return -1;
    if (s.charCodeAt(j) === 92) {
      j += isEscapable(s.charCodeAt(j + 1)) ? 2 : 1;
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) return j;
    j++;
  }
  return -1;
}

/** findSingleStar of the reference. */
function findSingleStar(s, from) {
  const n = s.length;
  let j = from;
  while (j < n) {
    STAR_RE.lastIndex = j;
    if (!STAR_RE.test(s)) return -1;
    j = STAR_RE.lastIndex - 1;
    if (s.charCodeAt(j) === 92) {
      j += j + 1 < n && isEscapable(s.charCodeAt(j + 1)) ? 2 : 1;
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j += 2;
      continue;
    }
    return j;
  }
  return -1;
}

/** Inline Markdown of the escaped text `s`, jumping between the characters that matter (\ ` * [). */
function inline(s, link) {
  let out = '';
  let i = 0;
  let start = 0;
  const n = s.length;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    if (!SPECIAL_RE.test(s)) break;
    i = SPECIAL_RE.lastIndex - 1;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (isEscapable(d)) {
          out += s.slice(start, i);
          start = i + 1;
          i += 2;
          continue;
        }
        if (d === 38 && s.startsWith('gt;', i + 2)) {
          out += s.slice(start, i);
          start = i + 1;
          i += 5;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += s.slice(start, i) + '<code>' + s.slice(i + 1, j) + '</code>';
        i = j + 1;
        start = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          out += s.slice(start, i) + '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>';
          i = j + 2;
          start = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += s.slice(start, i) + '<em>' + inline(s.slice(i + 1, j), link) + '</em>';
        i = j + 1;
        start = i;
      } else i++;
      continue;
    }
    // c === '['
    const k = findBracket(s, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS.test(target)) {
      out += s.slice(start, i) + '<a href="' + link(target) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
      i = m + 1;
      start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

/**
 * The escaped body `src` rendered as Markdown: { html, toc, excerpt }. Lines are walked by offsets (src[ls, le)),
 * as the reference walks src.split('\n'); fenced code is sliced straight out of the escaped text.
 */
function renderMarkdown(src, link, slugify) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  const len = src.length;
  let ls = 0;
  while (ls <= len) {
    let le = src.indexOf('\n', ls);
    if (le === -1) le = len;
    if (ls === le) {
      ls = le + 1;
      continue;
    }
    const c = src.charCodeAt(ls);
    if ((c === 32 || c === 9) && blankRange(src, ls, le)) {
      ls = le + 1;
      continue;
    }
    if (c === 96) {
      const fence = FENCE_OPEN.exec(src.slice(ls, le));
      if (fence !== null) {
        const codeStart = le + 1;
        let body;
        FENCE_CLOSE_NL_RE.lastIndex = le;
        if (le < len && FENCE_CLOSE_NL_RE.test(src)) {
          const closeEnd = FENCE_CLOSE_NL_RE.lastIndex;
          const closeStart = src.lastIndexOf('\n', closeEnd - 1) + 1;
          body = src.slice(codeStart, closeStart);
          ls = closeEnd + 1;
        } else {
          body = codeStart > len ? '' : src.slice(codeStart) + '\n';
          ls = len + 1;
        }
        const lang = fence[1];
        html += (lang === '' ? '<pre><code>' : '<pre><code class="language-' + lang + '">') + body + '</code></pre>\n';
        continue;
      }
    }
    if (c === 35) {
      const h = headingOf(src.slice(ls, le));
      if (h !== null) {
        const depth = h[1].length;
        const text = h[2];
        const id = uniqueSlug(slugify(unesc(text)), ids);
        const ih = inline(text, link);
        html += '<h' + depth + ' id="' + id + '">' + ih + '</h' + depth + '>\n';
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: ih });
        ls = le + 1;
        continue;
      }
    }
    if ((c === 45 || c === 42) && HR.test(src.slice(ls, le))) {
      html += '<hr>\n';
      ls = le + 1;
      continue;
    }
    if (c === 38 && src.startsWith('&gt;', ls)) {
      let text = null;
      while (ls <= len) {
        if (!(src.charCodeAt(ls) === 38 && src.startsWith('&gt;', ls))) break;
        let e = src.indexOf('\n', ls);
        if (e === -1) e = len;
        let a = ls + 4;
        if (a < e && src.charCodeAt(a) === 32) a++;
        const t = trimLine(src.slice(a, e));
        if (t !== '') text = text === null ? t : text + '\n' + t;
        ls = e + 1;
      }
      html += text === null ? '<blockquote>\n</blockquote>\n' : '<blockquote>\n<p>' + inline(text, link) + '</p>\n</blockquote>\n';
      continue;
    }
    let m = null;
    let isOrdered = false;
    if ((c === 45 || c === 42) && src.charCodeAt(ls + 1) === 32) m = BULLET.exec(src.slice(ls, le));
    if (m === null && c >= 48 && c <= 57) {
      m = ORDERED.exec(src.slice(ls, le));
      isOrdered = m !== null;
    }
    if (m !== null) {
      const start = isOrdered ? Number(m[1]) : 1;
      const re = isOrdered ? ORDERED : BULLET;
      let items = '';
      let cur = trimLine(isOrdered ? m[2] : m[1]);
      ls = le + 1;
      while (ls <= len) {
        let e = src.indexOf('\n', ls);
        if (e === -1) e = len;
        const lc = src.charCodeAt(ls);
        let mm = null;
        if (isOrdered ? lc >= 48 && lc <= 57 : (lc === 45 || lc === 42) && src.charCodeAt(ls + 1) === 32) mm = re.exec(src.slice(ls, e));
        if (mm !== null) {
          items += '<li>' + inline(cur, link) + '</li>\n';
          cur = trimLine(isOrdered ? mm[2] : mm[1]);
        } else if (lc === 32 && src.charCodeAt(ls + 1) === 32 && CONTINUED.test(src.slice(ls, e))) {
          cur += '\n' + trimLine(src.slice(ls, e));
        } else break;
        ls = e + 1;
      }
      items += '<li>' + inline(cur, link) + '</li>\n';
      const tag = isOrdered ? 'ol' : 'ul';
      html += (isOrdered && start !== 1 ? '<ol start="' + start + '">\n' : '<' + tag + '>\n') + items + '</' + tag + '>\n';
      continue;
    }
    // A paragraph: this line and the next ones up to one that ends it. Only lines opening on one of [ \t\n`#*-] (or
    // the empty end) can end it, so the regex jumps between those candidates. When no line needs trimming, the
    // paragraph's text is one slice of src.
    const pStart = ls;
    let pEnd = len;
    let p = le;
    while (p < len) {
      PARA_END_RE.lastIndex = p;
      if (!PARA_END_RE.test(src)) break;
      const q = PARA_END_RE.lastIndex - 1;
      let e = src.indexOf('\n', q + 1);
      if (e === -1) e = len;
      if (endsParagraphAt(src, q + 1, e)) {
        pEnd = q;
        break;
      }
      p = q + 1;
    }
    ls = pEnd + 1;
    let text = src.slice(pStart, pEnd);
    const c0 = text.charCodeAt(0);
    const c1 = text.charCodeAt(text.length - 1);
    if (c0 === 32 || c0 === 9 || c1 === 32 || c1 === 9 || NEEDS_TRIM_RE.test(text)) text = text.split('\n').map(trimLine).join('\n');
    const ih = inline(text, link);
    if (excerpt === null) excerpt = ih;
    html += '<p>' + ih + '</p>\n';
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates (parse: as the reference)

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ------------------------------------------------------------------ template runtime helpers

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function step(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}

// ------------------------------------------------------------------ template compiler
//
// Each (template, include depth, loop-frame names, root kind) becomes one generated JS function. Lookups resolve
// statically (frames innermost first, `loop` before the element, then the root vars of the kind). Each unit's
// dependencies are tracked: a unit that depends on nothing but the run's constant roots (site, tags, recent) is
// rendered once per run; one that depends only on one outer loop element is memoized by that element.

class TemplateCompileLimit extends Error {}

// Compilation visits even unreachable branches, unlike the reference renderer. Fall back to its scope-chain
// interpreter when expansion is too large or V8 cannot compile the generated function (e.g. deeply nested ifs).
function compileTemplates(templates, needs, consts) {
  try {
    return compileTemplatesFast(templates, needs, consts);
  } catch (err) {
    if (!(err instanceof TemplateCompileLimit || err instanceof RangeError || err instanceof SyntaxError)) throw err;
  }
  const lookup = (scope, path) => {
    while (scope !== null && !hasOwn(scope.vars, path[0])) scope = scope.parent;
    if (scope === null) return undefined;
    let v = scope.vars[path[0]];
    for (let k = 1; k < path.length; k++) v = step(v, path[k]);
    return v;
  };
  function render(nodes, scope, depth) {
    let out = '';
    for (const n of nodes) {
      switch (n.kind) {
        case 'text': out += n.text; break;
        case 'var': out += esc(textOf(lookup(scope, n.path))); break;
        case 'raw': out += textOf(lookup(scope, n.path)); break;
        case 'if': {
          const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
          if (branch !== null) out += render(branch, scope, depth);
          break;
        }
        case 'for': {
          const xs = lookup(scope, n.path);
          if (!Array.isArray(xs)) break;
          xs.forEach((x, k) => {
            const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
            out += render(n.body, { vars, parent: scope }, depth);
          });
          break;
        }
        case 'include': {
          const t = templates.get(n.name);
          if (t !== undefined && depth < INCLUDE_DEPTH) out += render(t, scope, depth + 1);
          break;
        }
      }
    }
    return out;
  }
  const out = new Map();
  for (const [name, kind] of needs) {
    const nodes = templates.get(name);
    if (nodes !== undefined) out.set(kind + '\u0000' + name, (R) => render(nodes, {
      vars: { site: consts.SITE, tags: consts.TAGS, recent: consts.RECENT, ...R }, parent: null,
    }, 0));
  }
  return out;
}

function compileTemplatesFast(templates, needs, consts) {
  let budget = 100000;
  const decls = [];
  const fns = [];
  const shared = new Map();
  const perKind = new Map();
  let nextId = 0;
  let nextMemo = 0;

  const union = (a, b) => {
    if (b.size === 0) return a;
    if (a.size === 0) return b;
    const s = new Set(a);
    for (const x of b) s.add(x);
    return s;
  };
  const EMPTY = new Set();
  const DYN = new Set(['D']);

  function expr(path, frames, kind) {
    const first = path[0];
    let base;
    let deps = EMPTY;
    let uk = false;
    let rest = 1;
    const nf = frames.length;
    if (first === 'loop' && nf > 0) {
      const j = nf - 1;
      deps = frames[j].md;
      if (path.length === 1) base = `({index:k${j}+1,first:k${j}===0,last:k${j}===n${j}-1,length:n${j}})`;
      else {
        const p = path[1];
        rest = 2;
        if (p === 'index') base = `(k${j}+1)`;
        else if (p === 'first') base = `(k${j}===0)`;
        else if (p === 'last') base = `(k${j}===n${j}-1)`;
        else if (p === 'length') base = `n${j}`;
        else base = 'undefined';
      }
    } else {
      let j = nf - 1;
      while (j >= 0 && frames[j].name !== first) j--;
      if (j >= 0) {
        base = `e${j}`;
        deps = frames[j].ed;
      } else if (first === 'site') base = 'SITE';
      else if (first === 'tags') base = 'TAGS';
      else if (first === 'recent') base = 'RECENT';
      else if (DYN_NAMES.includes(first)) {
        uk = true;
        if (KIND_KEYS[kind].includes(first)) {
          base = `R.${first}`;
          deps = DYN;
        } else base = 'undefined';
      } else base = 'undefined';
    }
    if (base === 'undefined') return { code: 'undefined', deps, uk };
    for (let k = rest; k < path.length; k++) base = `g(${base},${JSON.stringify(path[k])})`;
    return { code: base, deps, uk };
  }

  function frameArgs(n) {
    let s = 'R';
    for (let j = 0; j < n; j++) s += `,e${j},k${j},n${j}`;
    return s;
  }

  function memoWrap(r) {
    if (r.deps.size !== 0 || r.code.length < 40) return r.code;
    const id = nextMemo++;
    decls.push(`let c${id};`);
    return `if(c${id}===undefined){let o='';${r.code}c${id}=F(o);}o+=c${id};`;
  }

  function genList(nodes, frames, depth, kind, nesting = 0) {
    // V8 may defer compiling a generated unit until its first call, beyond the catch above. Keep its lexical
    // nesting shallow enough that lazy compilation cannot overflow before an outer false branch is checked.
    if (nesting > 64) throw new TemplateCompileLimit();
    budget -= nodes.length + frames.length;
    if (budget < 0) throw new TemplateCompileLimit();
    let code = '';
    let deps = EMPTY;
    let uk = false;
    for (const n of nodes) {
      switch (n.kind) {
        case 'text':
          code += `o+=${JSON.stringify(n.text)};`;
          break;
        case 'var':
        case 'raw': {
          const r = expr(n.path, frames, kind);
          deps = union(deps, r.deps);
          uk = uk || r.uk;
          if (r.code !== 'undefined') code += n.kind === 'var' ? `o+=E(T(${r.code}));` : `o+=T(${r.code});`;
          break;
        }
        case 'if': {
          const r = expr(n.path, frames, kind);
          const a = genList(n.then, frames, depth, kind, nesting + 1);
          const b = n.else === null ? null : genList(n.else, frames, depth, kind, nesting + 1);
          let d = union(r.deps, a.deps);
          if (b !== null) d = union(d, b.deps);
          const u = r.uk || a.uk || (b !== null && b.uk);
          const c = `if(${n.not ? '!' : ''}B(${r.code})){${a.code}}` + (b !== null && b.code !== '' ? `else{${b.code}}` : '');
          code += memoWrap({ code: c, deps: d });
          deps = union(deps, d);
          uk = uk || u;
          break;
        }
        case 'for': {
          const r = expr(n.path, frames, kind);
          const j = frames.length;
          // The element varies per iteration: mark it frame-local ('F'+j) so nothing inside the loop body is
          // cached across iterations; the mark is dropped once the loop closes.
          const fd = union(r.deps, new Set(['F' + j]));
          const inner = frames.concat([{ name: n.name, ed: fd, md: fd }]);
          const body = genList(n.body, inner, depth, kind, nesting + 1);
          let bd = body.deps;
          if (bd.has('F' + j)) {
            bd = new Set(bd);
            bd.delete('F' + j);
          }
          const d = union(r.deps, bd);
          const c = `{const a${j}=${r.code};if(Array.isArray(a${j})){const n${j}=a${j}.length;for(let k${j}=0;k${j}<n${j};k${j}++){const e${j}=a${j}[k${j}];${body.code}}}}`;
          code += memoWrap({ code: c, deps: d });
          deps = union(deps, d);
          uk = uk || r.uk || body.uk;
          break;
        }
        case 'include': {
          if (!templates.has(n.name) || depth >= INCLUDE_DEPTH) break;
          const u = unit(n.name, depth + 1, frames.map((f) => f.name), kind);
          for (const x of u.deps) {
            if (x === 'D') deps = union(deps, DYN);
            else {
              const fj = frames[Number(x.slice(1))];
              deps = union(deps, x[0] === 'E' ? fj.ed : fj.md);
            }
          }
          uk = uk || u.uk;
          code += `o+=u${u.id}(${frameArgs(frames.length)});`;
          break;
        }
      }
    }
    return { code, deps, uk };
  }

  function unit(name, depth, names, kind) {
    const key = name + '\u0000' + depth + '\u0000' + names.join('\u0000');
    let u = shared.get(key);
    if (u !== undefined) return u;
    const kk = kind + '\u0000' + key;
    u = perKind.get(kk);
    if (u !== undefined) return u;
    const frames = names.map((nm, j) => ({ name: nm, ed: new Set(['E' + j]), md: new Set(['M' + j]) }));
    const r = genList(templates.get(name), frames, depth, kind);
    const id = nextId++;
    u = { id, deps: r.deps, uk: r.uk };
    const params = frameArgs(names.length);
    let single = null;
    if (r.deps.size === 1) {
      const x = r.deps.values().next().value;
      if (x[0] === 'E') single = x.slice(1);
    }
    if (r.deps.size === 0) {
      decls.push(`let C${id};`);
      fns.push(`function u${id}(${params}){if(C${id}===undefined){let o='';${r.code}C${id}=F(o);}return C${id};}`);
    } else if (single !== null) {
      decls.push(`const M${id}=new Map();`);
      fns.push(`function u${id}(${params}){let r=M${id}.get(e${single});if(r===undefined){let o='';${r.code}r=F(o);M${id}.set(e${single},r);}return r;}`);
    } else fns.push(`function u${id}(${params}){let o='';${r.code}return o;}`);
    if (r.uk) perKind.set(kk, u);
    else shared.set(key, u);
    return u;
  }

  const tops = new Map();
  for (const [name, kind] of needs) {
    if (!templates.has(name)) continue;
    tops.set(kind + '\u0000' + name, unit(name, 0, [], kind).id);
  }
  let names = '';
  for (let k = 0; k < nextId; k++) names += (k === 0 ? '' : ',') + `u${k}`;
  const src = `"use strict";const E=H.E,T=H.T,B=H.B,g=H.g,F=H.F,SITE=H.SITE,TAGS=H.TAGS,RECENT=H.RECENT;${decls.join('')}\n${fns.join('\n')}\nreturn {${names}};`;
  const all = new Function('H', src)(consts);
  const out = new Map();
  for (const [k, id] of tops) out.set(k, all[`u${id}`]);
  return out;
}

// ------------------------------------------------------------------ build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

export function run(input) {
  const slugMemo = new Map();
  const slugify = (text) => {
    let s = slugMemo.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugMemo.set(text, s);
    }
    return s;
  };

  // templates
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // sources
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.start = fm.start;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // markdown
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  /** A link's escaped href from the escaped target `et` in directory `dir`, or null when it names nothing. */
  const resolveHref = (dir, et) => {
    const target = unesc(et);
    const c = target.charCodeAt(0);
    if (c === 47 || c === 35 || SCHEME.test(target)) return et;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null) {
      const t = bySource.get(path);
      if (t !== undefined) return esc(`${t.url}${frag}`);
      if (staticPaths.has(path)) return esc(`${base}/${path}${frag}`);
    }
    return null;
  };
  // Hrefs depend on the directory and the target only: resolved once per pair in this run.
  const hrefsByDir = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    let hrefs = hrefsByDir.get(dir);
    if (hrefs === undefined) {
      hrefs = new Map();
      hrefsByDir.set(dir, hrefs);
    }
    const link = (et) => {
      let h = hrefs.get(et);
      if (h === undefined) {
        h = resolveHref(dir, et);
        hrefs.set(et, h);
      }
      if (h === null) {
        broken.add(`broken-link ${s.path} -> ${unesc(et)}`);
        return et;
      }
      return h;
    };
    const body = s.text.slice(s.start);
    const md = renderMarkdown(esc(body), link, slugify);
    s.html = flat(md.html);
    s.toc = md.toc;
    s.excerpt = flat(md.excerpt);
    s.date = s.data.date ?? '';
    s.dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
    s.minutes = Math.max(1, Math.ceil(countWords(body) / 200));
    s.text = null;
  }

  // collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const names = s.data.tags;
    const res = [];
    if (names === undefined) return res;
    const seen = new Set();
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      res.push(name, slug);
    }
    return res;
  };
  for (const p of posts) {
    const refs = [];
    const own = ownTags(p);
    for (let k = 0; k < own.length; k += 2) {
      const name = own[k];
      const slug = own[k + 1];
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      refs.push(tag);
    }
    p.tagRefs = refs;
  }
  for (const s of sources) {
    if (s.post) continue;
    const refs = [];
    const own = ownTags(s);
    for (let k = 0; k < own.length; k += 2) refs.push(bySlug.get(own[k + 1]) ?? { name: own[k], slug: own[k + 1], url: '', posts: [] });
    s.tagRefs = refs;
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // layouts
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.date,
    date_long: s.dateLong,
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.minutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.date, date_long: s.dateLong });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  const needs = [];
  const layoutSet = new Set();
  for (const s of sources) layoutSet.add(s.layout);
  for (const l of layoutSet) needs.push([l, 'page']);
  needs.push(['index', 'index'], ['tag', 'tag'], ['tags', 'tags']);
  const tops = compileTemplates(templates, needs, { E: esc, T: textOf, B: truthy, g: step, F: flat, SITE: site, TAGS: allTags, RECENT: recent });
  const render = (name, kind, R) => {
    const f = tops.get(kind + '\u0000' + name);
    return f === undefined ? null : flat(f(R));
  };

  const output = {};
  for (const s of sources) {
    const page = cardOf(s);
    page.slug = s.slug;
    page.content = s.html;
    page.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    page.newer = linkOf(s.newer ?? null);
    page.older = linkOf(s.older ?? null);
    page.is_post = s.post;
    output[`${s.outDir}/index.html`] = render(s.layout, 'page', { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', 'index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', 'tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', 'tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${sources.length - posts.length} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
