import { parseResults } from './src/sites/pj';
import { PJ_RESULT_LINK } from './tests/fixtures';

// Test Issue 2: parseResults with } in value
const htmlWithBrace = PJ_RESULT_LINK.replace(
  'En el caso, solo los argumentos.',
  'See {section 5} for details',
);

const rows = parseResults(htmlWithBrace, 0);
console.log('Parsed rows:', rows.length);
if (rows.length > 0) {
  console.log('UUID:', rows[0].uuid);
  console.log('Sumilla:', JSON.stringify(rows[0].fields.sumilla));
  console.log('Full fields:', JSON.stringify(rows[0].fields, null, 2));
} else {
  console.log('ERROR: No rows parsed (regex failed to match)');
}
