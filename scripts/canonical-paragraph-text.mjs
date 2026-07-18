import { createHash } from 'node:crypto';

export function canonicalParagraphBody(value) {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+([，。；：！？、])/g, '$1')
    .trim();
}

export function isCanonicalParagraphBody(value) {
  if (value.length < 24 || value.length > 2200) return false;
  const meaningful = (value.match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
  return meaningful / value.length > 0.55 && !/^(目\s*录|contents?)$/i.test(value);
}

export function canonicalParagraphBodySha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
