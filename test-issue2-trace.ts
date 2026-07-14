import { PJ_RESULT_LINK } from './tests/fixtures';

const modified = PJ_RESULT_LINK.replace(
  'En el caso, solo los argumentos.',
  'Items: {a, b, c}, final note',
);

// Replicate parseResults logic step by step
function htmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const text = htmlUnescape(modified)
  .replace(/\+"/g, '"')
  .replace(/\+u002[dD]/g, '-')
  .replace(/\+\//g, '/');

console.log('After unescaping, text contains "Items:":', text.includes('Items:') ? 'YES' : 'NO');
console.log('Snippet around Items:');
const idx = text.indexOf('Items:');
console.log(text.substring(idx - 30, idx + 60));

const linkRe = /RichFaces\.ajax\("(formBuscador:repeat:(\d+):[^"]+)",event,\{"parameters":\{(.*?)\}\s*,/g;
const m = linkRe.exec(text);

console.log('\nRegex match result:', m ? 'MATCHED' : 'NO MATCH');

if (m) {
  console.log('Group 3 (params):', m[3].substring(0, 150));
} else {
  // Show what the regex is looking for
  console.log('\nLooking for pattern: RichFaces\.ajax("formBuscador:repeat:...","event",{"parameters":{...}\s*,');
  console.log('\nSearching for: } ,  (closing brace, space, comma)');
  const braceCommaIdx = text.lastIndexOf('} ,');
  console.log('Last occurrence of "} ,": position', braceCommaIdx);
  if (braceCommaIdx > 0) {
    console.log('Text around last "} ,":');
    console.log(JSON.stringify(text.substring(braceCommaIdx - 50, braceCommaIdx + 50)));
  }
}
