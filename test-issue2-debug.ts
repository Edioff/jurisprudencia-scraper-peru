import { parseResults } from './src/sites/pj';
import { PJ_RESULT_LINK } from './tests/fixtures';

const htmlWithBraceComma = PJ_RESULT_LINK.replace(
  'En el caso, solo los argumentos.',
  'Items: {a, b, c}, final note',
);

// Manual extraction to see what's happening
const text = htmlWithBraceComma
  .replace(/&quot;/g, '"')
  .replace(/\+"/g, '"')
  .replace(/\+u002[dD]/g, '-')
  .replace(/\+\//g, '/');

console.log('Text contains:', text.includes('Items: {a, b, c}, final note') ? 'YES' : 'NO');

const linkRe = /RichFaces\.ajax\("(formBuscador:repeat:(\d+):[^"]+)",event,\{"parameters":\{(.*?)\}\s*,/g;
const m = linkRe.exec(text);

if (m) {
  console.log('\nRegex matched!');
  console.log('Captured params body:');
  console.log(m[3]);
  console.log('\nAfter captured body, next chars:', JSON.stringify(text.substring(m.index + m[0].length, m.index + m[0].length + 30)));
} else {
  console.log('Regex did NOT match');
}

// Now check what parseResults returns
const rows = parseResults(htmlWithBraceComma, 0);
console.log('\nparseResults returned', rows.length, 'rows');
if (rows.length > 0) {
  console.log('Captured fields:', Object.keys(rows[0].fields));
  console.log('All fields:', JSON.stringify(rows[0].fields, null, 2));
}
