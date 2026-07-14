import { PJ_RESULT_LINK } from './tests/fixtures';

// Find the location after "RichFaces.ajax(" and print 50 characters with codes
const idx = PJ_RESULT_LINK.indexOf('RichFaces.ajax(');
const prefix = 'RichFaces.ajax('.length;
console.log('Characters right after "RichFaces.ajax(":');
for (let i = 0; i < 50; i++) {
  const char = PJ_RESULT_LINK[idx + prefix + i];
  if (!char) break;
  const code = char.charCodeAt(0);
  const repr = code === 34 ? 'QUOTE' : code === 92 ? 'BACKSLASH' : code === 38 ? 'AMPERSAND' : char;
  console.log(`[${i}]: code ${code} = ${repr}`);
}
