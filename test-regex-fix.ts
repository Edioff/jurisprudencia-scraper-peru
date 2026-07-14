const backslash = String.fromCharCode(92);
const quote = String.fromCharCode(34);
const testStr = `test${backslash}${quote}string${backslash}${backslash}${quote}more`;

console.log('Test string:', JSON.stringify(testStr));
console.log('Contains backslash-quote:', testStr.includes(backslash + quote) ? 'YES' : 'NO');

// Current (buggy) pattern
const buggyPattern = /\+"/g;
console.log('\nBuggy pattern /\\+"/');
console.log('Pattern source:', buggyPattern.source);
const buggyResult = testStr.replace(buggyPattern, '"');
console.log('After replace:', JSON.stringify(buggyResult));
console.log('Still has backslash-quote:', buggyResult.includes(backslash + quote) ? 'YES' : 'NO');

// Fixed pattern (with proper escaping)
const fixedPattern = /\\+"/g;
console.log('\nFixed pattern /\\\\+"/');
console.log('Pattern source:', fixedPattern.source);
const fixedResult = testStr.replace(fixedPattern, '"');
console.log('After replace:', JSON.stringify(fixedResult));
console.log('Still has backslash-quote:', fixedResult.includes(backslash + quote) ? 'YES' : 'NO');
