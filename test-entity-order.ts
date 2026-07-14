/**
 * Test to verify the htmlUnescape entity decoding order.
 * The finding claims that decoding &amp; last violates standard practice
 * and could fail on &amp;lt; sequences.
 */

// Current implementation: decode &amp; LAST
function htmlUnescapeCurrent(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Alternative: decode &amp; FIRST (as the finding suggests)
function htmlUnescapeAltOrder(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Test cases
const testCases = [
  // Simple entities
  { input: '&quot;hello&quot;', expected: '"hello"', desc: 'simple quote' },
  { input: '&lt;tag&gt;', expected: '<tag>', desc: 'simple lt/gt' },
  { input: '&amp;', expected: '&', desc: 'simple ampersand' },

  // Double-encoded: &amp;lt; should decode to &lt; (literal text)
  // This represents the HTML-encoded form of the literal text "&lt;"
  { input: '&amp;lt;', expected: '&lt;', desc: 'double-encoded &amp;lt;' },
  { input: '&amp;quot;', expected: '&quot;', desc: 'double-encoded &amp;quot;' },
  { input: '&amp;amp;', expected: '&amp;', desc: 'double-encoded &amp;amp;' },

  // Complex cases
  { input: 'text&amp;more', expected: 'text&more', desc: 'ampersand in text' },
  { input: '&lt;&amp;gt;', expected: '<&gt;', desc: 'mixed: &lt; then &amp;gt;' },
];

console.log('=== htmlUnescape Order Analysis ===\n');

for (const test of testCases) {
  const current = htmlUnescapeCurrent(test.input);
  const altOrder = htmlUnescapeAltOrder(test.input);

  const currentPass = current === test.expected ? '✓' : '✗';
  const altPass = altOrder === test.expected ? '✓' : '✗';

  console.log(`Test: ${test.desc}`);
  console.log(`  Input:           ${test.input}`);
  console.log(`  Expected:        ${test.expected}`);
  console.log(`  Current order:   ${current} ${currentPass}`);
  console.log(`  Alt order (&amp; first): ${altOrder} ${altPass}`);

  if (current !== altOrder) {
    console.log(`  ⚠️  DIFFERENCE DETECTED`);
  }
  console.log();
}

// Verify against the actual test fixture
console.log('=== Verify Against Actual Fixture ===\n');

// From fixtures: the uuid portion is: \\&quot;82a1732b\\\\u002Dbee7\\\\u002D40f6\\\\u002D9e61\\\\u002D19db22c3a6be\\&quot;
// After htmlUnescape, this should become: \"82a1732b\\u002Dbee7\\u002D40f6\\u002D9e61\\u002D19db22c3a6be\"
// (backslashes stay, &quot; becomes ", unicode escapes are processed later)

const fixtureSnippet = '\\&quot;82a1732b\\\\u002Dbee7\\\\u002D40f6\\\\u002D9e61\\\\u002D19db22c3a6be\\&quot;';
console.log(`Fixture snippet: ${fixtureSnippet}`);
console.log(`After htmlUnescapeCurrent: ${htmlUnescapeCurrent(fixtureSnippet)}`);
console.log(`After htmlUnescapeAltOrder: ${htmlUnescapeAltOrder(fixtureSnippet)}`);
