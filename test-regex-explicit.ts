// Build the string explicitly
const backslash = String.fromCharCode(92);
const quote = String.fromCharCode(34);
const testStr = `RichFaces.ajax(${backslash}${quote}formBuscador)`;

console.log('Test string:', JSON.stringify(testStr));
console.log('Contains backslash-quote:', testStr.includes(backslash + quote) ? 'YES' : 'NO');

// Test the regex
const result = testStr.replace(/\+"/g, '"');
console.log('After /\\+"/g replace:', JSON.stringify(result));

// Now with the fixture
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
const hasBackslashQuote = text.includes(backslash + quote);
console.log('\nFixture after htmlUnescape contains backslash-quote:', hasBackslashQuote ? 'YES' : 'NO');

const text2 = text.replace(/\+"/g, '"');
const stillHasBackslashQuote = text2.includes(backslash + quote);
console.log('After replace, still has backslash-quote:', stillHasBackslashQuote ? 'YES' : 'NO');
