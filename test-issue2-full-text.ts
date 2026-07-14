import { PJ_RESULT_LINK } from './tests/fixtures';

const modified = PJ_RESULT_LINK.replace(
  'En el caso, solo los argumentos.',
  'Items: {a, b, c}, final note',
);

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

// Extract just the RichFaces.ajax call
const startIdx = text.indexOf('RichFaces.ajax(');
const endIdx = text.indexOf(');', startIdx) + 2;
const ajaxCall = text.substring(startIdx, endIdx);

console.log('Full RichFaces.ajax call:');
console.log(ajaxCall);
console.log('\n---\n');

// Now test the regex
const linkRe = /RichFaces\.ajax\("(formBuscador:repeat:(\d+):[^"]+)",event,\{"parameters":\{(.*?)\}\s*,/;
const m = linkRe.exec(ajaxCall);
console.log('Direct regex test:', m ? 'MATCH' : 'NO MATCH');

// Test with exec global
const linkReGlobal = /RichFaces\.ajax\("(formBuscador:repeat:(\d+):[^"]+)",event,\{"parameters":\{(.*?)\}\s*,/g;
const m2 = linkReGlobal.exec(text);
console.log('With global flag:', m2 ? 'MATCH' : 'NO MATCH');
