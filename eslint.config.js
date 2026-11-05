'use strict';

/*
 * Safe-rendering lint gate (plan sections 8.3 and 22.6, stage 3).
 *
 * Every HTML string must reach the DOM through renderInto(element, html) in
 * js/app.js, after the caller has escaped each value with esc() or toInt().
 * These selectors fail the build if a new render path writes innerHTML
 * directly, injects markup through insertAdjacentHTML, or reaches for eval /
 * new Function. The one allowed innerHTML write is the audited sink in
 * renderInto, which carries an inline disable with its justification.
 *
 * Run with `npm run lint`; Validate runs it on every push and pull request.
 */

const restricted = [
  {
    selector: "AssignmentExpression > MemberExpression[property.name='innerHTML']",
    message: 'Write HTML through renderInto(element, html) in js/app.js so every value goes through esc() or toInt().'
  },
  {
    selector: "AssignmentExpression > MemberExpression[property.name='outerHTML']",
    message: 'Do not replace an element through outerHTML; render its parent with renderInto() instead.'
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'Do not inject HTML with insertAdjacentHTML; build the markup and pass it to renderInto().'
  },
  {
    selector: "CallExpression[callee.name='eval']",
    message: 'eval() is not allowed in this codebase.'
  },
  {
    selector: "NewExpression[callee.name='Function']",
    message: 'new Function() is not allowed in this codebase.'
  }
];

module.exports = [
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script'
    },
    rules: {
      'no-restricted-syntax': ['error', ...restricted]
    }
  },
  {
    files: ['js/domain/**/*.js'],
    languageOptions: {
      sourceType: 'module'
    }
  }
];
