import { PJ_RESULT_LINK } from './tests/fixtures';

// First 100 chars of the fixture
console.log('Original fixture (first 200 chars):');
console.log(JSON.stringify(PJ_RESULT_LINK.substring(0, 200)));

// Step 1: htmlUnescape
function htmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const afterHtmlUnescape = htmlUnescape(PJ_RESULT_LINK);
console.log('\nAfter htmlUnescape (first 200 chars):');
console.log(JSON.stringify(afterHtmlUnescape.substring(0, 200)));

// Step 2: replace backslash-quote
const afterBackslashReplace = afterHtmlUnescape.replace(/\+"/g, '"');
console.log('\nAfter backslash-quote replace (first 200 chars):');
console.log(JSON.stringify(afterBackslashReplace.substring(0, 200)));

// Check if we have the right pattern now
console.log('\nLooking for "RichFaces.ajax(" in each stage:');
console.log('Original:', PJ_RESULT_LINK.includes('RichFaces.ajax(') ? 'YES' : 'NO');
console.log('After htmlUnescape:', afterHtmlUnescape.includes('RichFaces.ajax(') ? 'YES' : 'NO');
console.log('After backslash replace:', afterBackslashReplace.includes('RichFaces.ajax(') ? 'YES' : 'NO');
