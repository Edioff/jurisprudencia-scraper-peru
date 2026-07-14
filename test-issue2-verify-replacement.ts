import { PJ_RESULT_LINK } from './tests/fixtures';

const original = PJ_RESULT_LINK;
const modified = original.replace(
  'En el caso, solo los argumentos.',
  'Items: {a, b, c}, final note',
);

console.log('Original contains:', original.includes('En el caso, solo los argumentos.') ? 'YES' : 'NO');
console.log('Modified contains original:', modified.includes('En el caso, solo los argumentos.') ? 'YES' : 'NO');
console.log('Modified contains new:', modified.includes('Items: {a, b, c}, final note') ? 'YES' : 'NO');
console.log('\nOriginal length:', original.length);
console.log('Modified length:', modified.length);
console.log('Difference:', modified.length - original.length);

// Show the actual change
console.log('\nOriginal snippet:');
const idx = original.indexOf('En el caso');
console.log(original.substring(idx - 20, idx + 50));

console.log('\nModified snippet:');
const idx2 = modified.indexOf('Items:');
console.log(modified.substring(idx2 - 20, idx2 + 50));
