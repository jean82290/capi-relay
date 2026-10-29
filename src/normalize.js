// Normalization and SHA-256 hashing of customer information, following
// Meta's "customer information parameters" rules. Contact information is
// hashed before it is stored or sent; network identifiers (IP, user agent,
// fbp, fbc) are never hashed, as Meta requires.

import { createHash } from 'node:crypto';

const SHA256_HEX = /^[a-f0-9]{64}$/i;

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const stripPunct = (s) => s.replace(/[\p{P}\p{S}]/gu, '');
const stripSpaces = (s) => s.replace(/\s+/gu, '');

function normalizePhone(raw, defaultCountryCode) {
  const trimmed = raw.trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  const hadTrunkZero = !international && /^\D*0/.test(trimmed);
  const digits = trimmed.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (international || !defaultCountryCode) return digits;
  // A national number (leading trunk 0, or too short to contain a country code)
  // gets the configured country calling code prepended.
  if (hadTrunkZero || digits.length <= 10) return defaultCountryCode + digits;
  return digits;
}

function normalizeDob(raw) {
  const m = raw.trim().match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})$/);
  if (!m) return '';
  const [, y, mo, d] = m;
  const year = Number(y);
  if (year < 1900 || year > new Date().getUTCFullYear()) return '';
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  return `${y}${mo}${d}`;
}

const NORMALIZERS = {
  em: (v) => {
    const s = v.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
  },
  ph: (v, opts) => normalizePhone(v, opts.defaultPhoneCountryCode),
  fn: (v) => stripSpaces(stripPunct(v.trim().toLowerCase())),
  ln: (v) => stripSpaces(stripPunct(v.trim().toLowerCase())),
  ct: (v) => stripSpaces(stripPunct(v.trim().toLowerCase())).replace(/\d/g, ''),
  st: (v) => stripSpaces(stripPunct(v.trim().toLowerCase())),
  zp: (v) => {
    const s = v.trim().toLowerCase();
    const us = s.match(/^(\d{5})(?:-?\d{4})$/);
    if (us) return us[1];
    return stripSpaces(s.replace(/-/g, ''));
  },
  country: (v) => {
    const s = v.trim().toLowerCase();
    return /^[a-z]{2}$/.test(s) ? s : '';
  },
  db: (v) => normalizeDob(v),
  ge: (v) => {
    const s = v.trim().toLowerCase().charAt(0);
    return s === 'f' || s === 'm' ? s : '';
  },
  external_id: (v) => v.trim(),
};

export const HASHED_KEYS = Object.keys(NORMALIZERS);
const PLAIN_STRING_KEYS = ['client_ip_address', 'client_user_agent', 'fbc', 'fbp', 'subscription_id'];
const PLAIN_ID_KEYS = ['fb_login_id', 'lead_id'];

function toList(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && v !== '');
}

// Returns a user_data object ready for Meta. Unknown keys are dropped.
export function normalizeUserData(input, opts = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;

  for (const key of HASHED_KEYS) {
    const values = toList(input[key]).slice(0, 10);
    const hashed = [];
    for (const raw of values) {
      const str = String(raw);
      if (SHA256_HEX.test(str.trim())) {
        hashed.push(str.trim().toLowerCase()); // already hashed by the caller
        continue;
      }
      const normalized = NORMALIZERS[key](str, opts);
      if (normalized) hashed.push(sha256(normalized));
    }
    const unique = [...new Set(hashed)];
    if (unique.length) out[key] = unique;
  }

  for (const key of PLAIN_STRING_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 512);
  }
  for (const key of PLAIN_ID_KEYS) {
    const v = input[key];
    // Kept as a numeric string: these IDs can exceed JavaScript's safe integer range.
    if (v !== undefined && v !== null && /^\d{1,30}$/.test(String(v))) out[key] = String(v);
  }
  return out;
}
