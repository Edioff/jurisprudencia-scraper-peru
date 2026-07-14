// Test the backslash replacement regex
const testStr = 'RichFaces.ajax(\\"test\\"';
console.log('Test string:', JSON.stringify(testStr));
console.log('Contains \\\" ?', testStr.includes('\\"') ? 'YES' : 'NO');

const result = testStr.replace(/\+"/g, '"');
console.log('After replace:', JSON.stringify(result));

// Check what the actual fixture has
import { PJ_RESULT_LINK } from './tests/fixtures';

function htmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const text = htmlUnescape(PJ_RESULT_LINK);

// Find the exact sequence
const idx = text.indexOf('RichFaces.ajax(');
const snippet = text.substring(idx, idx + 30);
console.log('\nFixture snippet from RichFaces.ajax:');
console.log(JSON.stringify(snippet));

// Check character by character
console.log('\nCharacter codes around RichFaces.ajax(:');
for (let i = 0; i < 20 && idx + i < text.length; i++) {
  const char = text[idx + i];
  const code = char.charCodeAt(0);
  console.log(`  [${i}] = ${JSON.stringify(char)} (code ${code})`);
}
