/**
 * Test cases for potential correctness issues in PJ adapter parsing.
 * These are edge cases that could fail with certain server data.
 */

import { parseResults, harvestForm, generalSearchButton } from './src/sites/pj';
import { PJ_RESULT_LINK, PJ_INICIO_FORM } from './tests/fixtures';

// ============================================================================
// ISSUE 1: htmlUnescape order (amp should be LAST to prevent double-decode)
// ============================================================================

/**
 * If a field value contains literal `&lt;` text (e.g. "Use &lt; for less-than"),
 * the HTML encodes it as `&amp;lt;`. After htmlUnescape, this becomes `&lt;` again,
 * which is correct. But if &amp; is decoded BEFORE &lt;, we get double-decoding:
 *
 * Input: "&amp;lt;"  (means: literal "&lt;" text)
 * After decode &amp; first:  "&lt;"
 * After decode &lt;:         "<"  (WRONG - double decoded)
 *
 * Current order (amp LAST) has the opposite problem in theory, but in practice
 * it works because the regex patterns don't interact. However, it violates the
 * standard HTML entity decoding order.
 */
function testHtmlUnescapeOrder() {
  // Simulate a field containing "&lt;" in the original text
  const htmlWithDoubleEncoded = `
RichFaces.ajax(&quot;formBuscador:repeat:0:j_idt491&quot;,event,{&quot;parameters&quot;:{
  &quot;uuid&quot;:&quot;82a1732b-bee7-40f6-9e61-19db22c3a6be&quot;,
  &quot;sumilla&quot;:&quot;Usage: &amp;lt;input&gt; tag&quot;
} ,&quot;incId&quot;:&quot;1&quot;} )
  `.trim();

  const rows = parseResults(htmlWithDoubleEncoded, 0);
  if (rows.length > 0) {
    console.log(
      'Issue 1 test: sumilla =',
      JSON.stringify(rows[0].fields.sumilla),
    );
    // Expected: "Usage: &lt;input&gt; tag" (literal ampersand-lt, not <)
    // If double-decoded: "Usage: <input> tag" (which would be wrong)
  }
}

// ============================================================================
// ISSUE 2: parseResults regex breaks on '}' inside JSON values
// ============================================================================

/**
 * The regex `(.*?)\}\s*,` assumes the closing `}` of the parameters object
 * comes before any `}` inside a field value. If a sumilla mentions something
 * like "See {section 5}", the regex will terminate early:
 *
 * Pattern: RichFaces.ajax("...",event,{"parameters":{(.*?)}...
 * Input:   RichFaces.ajax("...",event,{"parameters":{"uuid":"X","sumilla":"See {section 5}"} ,...
 * Match:   The (.*?) matches minimally: "uuid":"X","sumilla":"See {section 5
 * Then expects `}\s*,` but finds `"` instead → NO MATCH
 */
function testParseResultsWithBraceInValue() {
  const htmlWithBrace = PJ_RESULT_LINK.replace(
    'En el caso, solo los argumentos.',
    'See {section 5} for details',
  );

  const rows = parseResults(htmlWithBrace, 0);
  console.log('Issue 2 test: parsed', rows.length, 'rows');
  // Expected: 1 row with sumilla containing the brace
  // Actual: likely 0 rows because regex fails to match
}

// ============================================================================
// ISSUE 3: parseJsfParams assumes quotes don't appear in values after unescape
// ============================================================================

/**
 * After parseResults unescapes `\\"` → `"`, the parseJsfParams regex
 * `/"([^"]+)":"([^"]*)"/ will break if a value contains quotes.
 *
 * For example, if the server sends:
 *   \"key\":\"value with \\"quotes\\" inside\"
 * After unescape:
 *   "key":"value with "quotes" inside"
 * The regex `/"([^"]+)":"([^"]*)"` matches:
 *   - key = "key"
 *   - value = "value with " (stops at first embedded quote)
 *
 * This would require the PJ server to NOT escape embedded quotes in JSON,
 * which would be a server-side bug, but is still worth testing.
 */
function testParseJsfParamsWithQuotesInValue() {
  const htmlWithQuotes = PJ_RESULT_LINK.replace(
    'Admisibilidad del recurso de casación',
    'Que dice: "Nope" is not allowed',
  );

  const rows = parseResults(htmlWithQuotes, 0);
  console.log('Issue 3 test: parsed', rows.length, 'rows');
  if (rows.length > 0) {
    console.log(
      'Issue 3 test: palabras =',
      JSON.stringify(rows[0].fields.palabras),
    );
    // Expected: "Que dice: "Nope" is not allowed"
    // Actual: likely "Que dice: " (truncated at first embedded quote)
  }
}

// ============================================================================
// ISSUE 4: generalSearchButton assumes specific button structure
// ============================================================================

/**
 * The regex `/\{((?:\\'[^']*\\':\\'[^']*\\',?)+)\}/g` assumes:
 *   - Buttons use backslash-escaped single quotes: \'key\':\'value\'
 *   - No embedded single quotes in keys/values
 *   - Keys and values match `[^']*`
 *
 * If the server changes the button structure or adds new parameters,
 * the detection may fail or select the wrong button.
 */
function testGeneralSearchButtonStructure() {
  try {
    const params = generalSearchButton(PJ_INICIO_FORM);
    console.log('Issue 4 test: found button with forward =', params['forward']);
    // Expected: "buscar"
  } catch (e) {
    console.log('Issue 4 test: failed to find button:', (e as Error).message);
  }
}

// ============================================================================
// ISSUE 5: harvestForm may not handle edge cases in attribute extraction
// ============================================================================

/**
 * The attr() regex `\\b${name}="([^"]*)` uses [^"]* which stops at the first
 * quote. If an attribute value contains unescaped quotes (invalid HTML), it breaks.
 *
 * Also, the regex assumes the attribute is in the opening tag and is quoted.
 * Unquoted attributes (e.g. checked) or attributes with different quotes are not
 * handled.
 */
function testHarvestFormEdgeCases() {
  // Test unquoted attribute (invalid but might appear)
  const formWithUnquoted = `
<form id="formBuscador">
  <input type="hidden" name="test" value />
  <input type="checkbox" name="chk" checked />
</form>
  `.trim();

  try {
    const fields = harvestForm(formWithUnquoted, 'formBuscador');
    console.log('Issue 5 test: parsed fields:', Object.keys(fields));
    // The value-less input might be handled differently by different parsers
  } catch (e) {
    console.log('Issue 5 test: failed:', (e as Error).message);
  }
}

// ============================================================================
// Run all tests
// ============================================================================

console.log('\n=== Testing PJ Adapter Parsing Issues ===\n');
console.log('Issue 1: htmlUnescape order');
testHtmlUnescapeOrder();
console.log('\nIssue 2: parseResults with } in value');
testParseResultsWithBraceInValue();
console.log('\nIssue 3: parseJsfParams with quotes in value');
testParseJsfParamsWithQuotesInValue();
console.log('\nIssue 4: generalSearchButton structure');
testGeneralSearchButtonStructure();
console.log('\nIssue 5: harvestForm edge cases');
testHarvestFormEdgeCases();
