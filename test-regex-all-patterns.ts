const backslash = String.fromCharCode(92);
const slash = '/';

// Test pattern 1: /\+u002[dD]/g
console.log('Pattern 1: Replace backslash-u002d/D');
const test1 = `${backslash}u002Dtest${backslash}u002dmore`;
console.log('  Input:', JSON.stringify(test1));

const buggy1 = test1.replace(/\+u002[dD]/g, '-');
console.log('  Buggy /\\+u002[dD]/g:', JSON.stringify(buggy1));
console.log('  Result unchanged:', test1 === buggy1 ? 'YES' : 'NO');

const fixed1 = test1.replace(/\\+u002[dD]/g, '-');
console.log('  Fixed /\\\\+u002[dD]/g:', JSON.stringify(fixed1));
console.log('  Result changed:', test1 !== fixed1 ? 'YES' : 'NO');

// Test pattern 2: /\+\//g
console.log('\nPattern 2: Replace backslash-slash');
const test2 = `${backslash}${slash}test${backslash}${slash}more`;
console.log('  Input:', JSON.stringify(test2));

const buggy2 = test2.replace(/\+\//g, '/');
console.log('  Buggy /\\+\//g result:', JSON.stringify(buggy2));
console.log('  Result unchanged:', test2 === buggy2 ? 'YES' : 'NO');

const fixed2 = test2.replace(/\\+\//g, '/');
console.log('  Fixed /\\\\+\//g result:', JSON.stringify(fixed2));
console.log('  Result changed:', test2 !== fixed2 ? 'YES' : 'NO');
