/**
 * Standalone project verification script for the task-agent sandbox.
 * Usage: node verify-project.js
 *
 * Reads index.html, validates HTML/JS structure, checks syntax,
 * runs a minimal runtime test, and verifies expected features.
 * Outputs JSON: { passed: bool, reason: string, ... }
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Read the project file ──────────────────────────────────────────────
let html;
try {
  html = fs.readFileSync('index.html', 'utf-8');
} catch (e) {
  process.stdout.write(JSON.stringify({ passed: false, reason: 'Cannot read index.html: ' + e.message }));
  process.exit(1);
}

// ── HTML validation ────────────────────────────────────────────────────
const errors = [];
const hasDoctype = /<!DOCTYPE\s+html/i.test(html);
if (!hasDoctype) errors.push('Missing <!DOCTYPE html>');

function countTags(tag, text) {
  const open = (text.match(new RegExp('<' + tag + '[\\s>]', 'gi')) || []).length;
  const close = (text.match(new RegExp('</' + tag + '>', 'gi')) || []).length;
  return { open, close };
}

const divs = countTags('div', html);
if (divs.open !== divs.close) {
  errors.push('Mismatched <div> tags: ' + divs.open + ' open, ' + divs.close + ' closed');
}

const spans = countTags('span', html);
if (spans.open !== spans.close) {
  errors.push('Mismatched <span> tags');
}

const hasCanvas = /<canvas/i.test(html) || /getContext\s*\(/i.test(html);
const hasScript = /<script[^>]*>([\s\S]*?)<\/script>/i.test(html);
const hasStyle = /<style/i.test(html);

if (!hasScript) errors.push('No <script> block found');

// ── Extract JavaScript ─────────────────────────────────────────────────
let allJs = '';
const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let match;
while ((match = scriptRegex.exec(html)) !== null) {
  if (match[1].trim().length > 10) {
    allJs += match[1].trim() + '\n;\n';
  }
}

if (allJs.length < 50) {
  process.stdout.write(JSON.stringify({ passed: false, reason: 'No meaningful JavaScript found (< 50 chars)' }));
  process.exit(1);
}

// ── JS syntax check ────────────────────────────────────────────────────
fs.writeFileSync('_check.js', allJs);
try {
  execSync('node --check _check.js 2>&1', { timeout: 10000 });
} catch (e) {
  const msg = (e.stderr ? e.stderr.toString() : e.message)
    .split('\n').filter(function(l) { return l.trim(); }).slice(0, 3).join(' | ');
  process.stdout.write(JSON.stringify({ passed: false, reason: 'JavaScript syntax error: ' + msg.slice(0, 300) }));
  process.exit(1);
}

// ── Basic runtime check (minimal mocks — only catches crashes) ─────────
const runtimeWrapper = [
  '// Minimal DOM/canvas mocks — prevent ReferenceErrors only',
  'globalThis.document = {',
  '  getElementById: function() { return {',
  "    getContext: function() { return {",
  "      fillStyle: '', strokeStyle: '', font: '', textAlign: '',",
  '      fillRect: function() {}, clearRect: function() {}, fillText: function() {},',
  '      strokeRect: function() {}, arc: function() {}, fill: function() {}, stroke: function() {},',
  '      beginPath: function() {}, closePath: function() {}, moveTo: function() {}, lineTo: function() {},',
  '    }; },',
  "    addEventListener: function() {}, textContent: '', style: {},",
  '  }; },',
  '  querySelector: function() { return null; }, querySelectorAll: function() { return []; },',
  '  addEventListener: function() {}, body: { appendChild: function() {}, addEventListener: function() {} },',
  '  createElement: function() { return { style: {}, addEventListener: function() {} }; },',
  '};',
  'globalThis.window = globalThis;',
  'globalThis.addEventListener = function() {};',
  'globalThis.requestAnimationFrame = function(fn) { if (typeof fn === "function") fn(0); return 1; };',
  'globalThis.cancelAnimationFrame = function() {};',
  'globalThis.setInterval = function(fn) { if (typeof fn === "function") fn(); return 1; };',
  'globalThis.clearInterval = function() {};',
  'globalThis.setTimeout = function(fn) { if (typeof fn === "function") fn(); return 1; };',
  '',
  'try {',
].join('\n');

const runtimeFooter = [
  '} catch (e) {',
  "  process.stdout.write(JSON.stringify({ passed: false, reason: 'Runtime error: ' + String(e.message || e).slice(0, 300) }));",
  '  process.exit(1);',
  '}',
].join('\n');

fs.writeFileSync('_runtime.js', runtimeWrapper + '\n' + allJs + '\n' + runtimeFooter);

try {
  execSync('node _runtime.js 2>&1', { timeout: 10000 });
} catch (e) {
  const out = ((e.stderr ? e.stderr.toString() : '') + (e.stdout ? e.stdout.toString() : '') + (e.message || ''));
  const lines = out.split('\n').filter(function(l) { return l.trim(); });
  const msg = lines.pop() || '';
  // Try to parse JSON error from our script
  try {
    const parsed = JSON.parse(msg);
    if (!parsed.passed) {
      process.stdout.write(JSON.stringify({ passed: false, reason: parsed.reason }));
      process.exit(1);
    }
  } catch (_) { /* not JSON, fall through */ }
  process.stdout.write(JSON.stringify({ passed: false, reason: 'Runtime check failed: ' + msg.slice(0, 300) }));
  process.exit(1);
}

// ── Feature checks ─────────────────────────────────────────────────────
const missing = [];
const combined = (html + ' ' + allJs).toLowerCase();

if (!hasCanvas) missing.push('No canvas element or getContext() call');
if (!/keydown|keyup|keypress|addeventlistener\s*\(\s*["']key/i.test(combined)) {
  missing.push('No keyboard event handling');
}
if (!/requestanimationframe|setinterval|settimeout/.test(allJs.toLowerCase())) {
  missing.push('No animation loop (requestAnimationFrame/setInterval/setTimeout)');
}
if (!/score/i.test(combined)) missing.push('No score tracking');
if (!/collision|collide|game\s*over|gameover/i.test(combined)) {
  missing.push('No collision or game-over detection');
}

if (missing.length > 0) {
  process.stdout.write(JSON.stringify({ passed: false, reason: 'Missing features: ' + missing.join(', ') }));
  process.exit(1);
}

// ── All checks passed ──────────────────────────────────────────────────
process.stdout.write(JSON.stringify({
  passed: true,
  reason: 'Valid HTML/JS project: syntax OK, all features present',
  details: {
    html_size: html.length,
    js_size: allJs.length,
    has_canvas: hasCanvas,
    has_style: hasStyle,
    elements: (html.match(/<\/?\w+/g) || []).length
  }
}));
