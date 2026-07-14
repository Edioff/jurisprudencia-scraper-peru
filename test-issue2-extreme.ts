import { parseResults } from './src/sites/pj';
import { PJ_RESULT_LINK } from './tests/fixtures';

// Extreme Issue 2: parseResults with }, inside value
const htmlWithBraceComma = PJ_RESULT_LINK.replace(
  'En el caso, solo los argumentos.',
  'Items: {a, b, c}, final note',
);

const rows = parseResults(htmlWithBraceComma, 0);
console.log('Parsed rows:', rows.length);
if (rows.length > 0) {
  console.log('Sumilla:', JSON.stringify(rows[0].fields.sumilla));
} else {
  console.log('ERROR: No rows parsed (regex failed to match)');
  // Let's debug the raw HTML to see what the regex is trying to match
  const text = htmlWithBraceComma
    .replace(/&quot;/g, '"')
    .replace(/\+"/g, '"')
    .replace(/\+u002[dD]/g, '-')
    .replace(/\+\//g, '/');
  const linkRe = /RichFaces\.ajax\("(formBuscador:repeat:(\d+):[^"]+)",event,\{"parameters":\{(.*?)\}\s*,/g;
  const m = linkRe.exec(text);
  if (m) {
    console.log('Regex DID match!');
    console.log('Captured params body:', m[3].substring(0, 200));
  } else {
    console.log('Regex did NOT match');
    console.log('Text snippet:', text.substring(0, 500));
  }
}
