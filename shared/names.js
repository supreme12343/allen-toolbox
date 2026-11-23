// File-name intelligence: decide whether a title is meaningful, derive one from page text,
// and turn it into a safe file name.

const RANDOM = [
  /^untitled$/i, /^document(\s*\d+)?$/i, /^no\s*title$/i, /^title$/i,
  /^microsoft\s+(word|powerpoint|excel)/i, /^canvas$/i, /^scan(ned)?\s*document$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\{?[0-9a-f]{16,}\}?$/i, /^[A-Za-z0-9+/=_-]{24,}$/,
  /^(allen(\s+(overseas|career institute|digital))?)$/i, /^\d{1,6}$/, /^[\W_]+$/,
  /^(unspecified|anonymous|unknown|none|null|n\/a|pdf|new document|blank)$/i,
  /^(pdfium|reportlab|wkhtmltopdf|pdf\s*creator|cairo|skia|chrome|libreoffice|openoffice|word|acrobat)\b/i,
];

export function meaningful(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 140) return false;
  if (RANDOM.some((r) => r.test(t))) return false;
  if (!/[A-Za-z]{3}/.test(t)) return false;
  if (/^[a-z0-9]+$/i.test(t) && t.length > 18) return false;
  if (!/\s/.test(t) && t.length > 34) return false;
  if (t.length >= 16 && !/\s/.test(t) && (t.match(/[aeiouAEIOU]/g) || []).length < 2) return false;
  return true;
}

export function dispositionFilename(cd) {
  if (!cd) return null;
  const star = /filename\*\s*=\s*(?:UTF-8)?'[^']*'([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  const raw = star ? star[1] : plain ? plain[1] : null;
  if (!raw) return null;
  let v = raw.trim().replace(/^"|"$/g, '');
  if (star) { try { v = decodeURIComponent(v); } catch (e) {} }
  return v;
}

export function fromContentDisposition(cd) {
  let v = dispositionFilename(cd);
  if (!v) return null;
  v = v.replace(/\.(pdf|docx?)$/i, '').replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return meaningful(v) ? v : null;
}

const JUNK = [/career institute/i, /all rights reserved/i, /copyright/i, /www\.|https?:|@/i,
  /^page\s*\d+(\s*(of|\/)\s*\d+)?$/i, /^\d{1,3}$/, /^[\W_]+$/];

/** Group pdf.js text items into visual lines (top to bottom, left to right). */
export function linesFrom(tc) {
  const rows = new Map();
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() || !it.transform) continue;
    const y = Math.round(it.transform[5] / 2) * 2;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], s: it.str });
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0])
    .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((o) => o.s).join(' ').replace(/\s+/g, ' ').trim());
}

/** "Physics - DPP 03" style name from the first lines of a document. */
export function deriveName(lines) {
  const good = [];
  for (const raw of lines) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < 3 || s.length > 100 || JUNK.some((r) => r.test(s))) continue;
    if (!good.includes(s)) good.push(s);
    if (good.length >= 12) break;
  }
  if (!good.length) return null;
  const find = (re) => good.find((l) => re.test(l));
  const subject = find(/\b(physics|chemistry|mathematics|maths|math|biology|botany|zoology|english|reasoning|aptitude|science)\b/i);
  const marker = find(/\b(chapter|module|topic|exercise|assignment|dpp|daily\s*practice|practice|worksheet|revision|notes|part|lecture|unit|test|paper|solution|sheet|set)\b/i);
  const parts = [];
  const add = (s) => { if (s && !parts.some((p) => p.toLowerCase() === s.toLowerCase())) parts.push(s); };
  add(subject);
  if (marker !== subject) add(marker);
  if (!parts.length) add(good[0]);
  if (parts.length === 1) {
    const second = good.find((l) => l !== parts[0] && l.length <= 60 && !/^(date|time|duration|marks|max\.?|total)\b/i.test(l));
    if (second && parts[0].length + second.length < 85) add(second);
  }
  const out = parts.join(' - ').slice(0, 120);
  return meaningful(out) ? out : null;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:[ .]*\.|[ .]*$)/i;
const SUFFIX = /\.(pdf|docx?|ts|mts|mp4|m4v|m4a|m4s|aac|mp3|webm|weba|mov|mkv|ogg|oga|opus|wav|flac|bin)$/i;

/** Safe base name (no extension). Returns null if nothing usable is left. */
export function safeBase(title, { strict = true } = {}) {
  let base = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').replace(/\s+/g, ' ').replace(/^[\s._-]+|[\s._-]+$/g, '');
  while (SUFFIX.test(base)) base = base.replace(SUFFIX, '').replace(/[\s.]+$/g, '');
  base = base.slice(0, 120).replace(/[\s.]+$/g, '');
  if (RESERVED.test(base)) base = '_' + base;
  if (strict ? !meaningful(base) : base.length < 1) return null;
  return base;
}

export function safeFilename(name) {
  let value = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 180).replace(/[\s.]+$/g, '');
  if (RESERVED.test(value)) value = '_' + value;
  return value || null;
}
