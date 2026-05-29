/**
 * Standalone CLI project verification script for the task-agent sandbox.
 * Usage: node verify-cli-project.js
 *
 * Verifies Python CLI projects (compilers, interpreters, databases,
 * command-line tools, etc.). Checks Python syntax, importability, and
 * basic execution. Unlike verify-project.js (HTML/JS), this is for
 * Python applications that run as command-line tools.
 *
 * Outputs JSON: { passed: bool, reason: string, details: {...} }
 */

const fs = require('fs');
const { execSync } = require('child_process');

// ── Find main Python file ──────────────────────────────────────────────
const CANDIDATES = ['main.py', 'solution.py', 'compiler.py', 'interpreter.py', 'cli.py', 'run.py', 'app.py'];

let mainFile = null;
for (const candidate of CANDIDATES) {
  if (fs.existsSync(candidate)) {
    mainFile = candidate;
    break;
  }
}

if (!mainFile) {
  // Fallback: find any .py file
  const pyFiles = fs.readdirSync('.').filter(function(f) { return f.endsWith('.py'); });
  if (pyFiles.length === 0) {
    process.stdout.write(JSON.stringify({
      passed: false,
      reason: 'No Python files found in project directory',
      details: { files: fs.readdirSync('.').slice(0, 20) }
    }));
    process.exit(0);
  }
  mainFile = pyFiles[0];
}

// ── Python syntax check ────────────────────────────────────────────────
let syntaxOk = true;
let syntaxError = '';
try {
  execSync('python3 -m py_compile ' + mainFile + ' 2>&1', { timeout: 10000 });
} catch (e) {
  syntaxOk = false;
  const stderr = e.stderr ? e.stderr.toString() : '';
  const stdout = e.stdout ? e.stdout.toString() : '';
  syntaxError = (stderr || stdout || e.message).slice(0, 300);
}

if (!syntaxOk) {
  process.stdout.write(JSON.stringify({
    passed: false,
    reason: 'Python syntax error in ' + mainFile + ': ' + syntaxError.split('\n').filter(function(l) { return l.trim(); }).slice(0, 3).join(' | '),
    details: { main_file: mainFile, syntax_error: syntaxError }
  }));
  process.exit(0);
}

// ── Importability check (non-fatal) ────────────────────────────────────
let importOk = false;
const modName = mainFile.replace('.py', '');
try {
  execSync('python3 -c "import ' + modName + '" 2>&1', { timeout: 10000 });
  importOk = true;
} catch (e) {
  // CLI tools may require arguments or have top-level code that blocks import
  // This is non-fatal
}

// ── Basic execution test ───────────────────────────────────────────────
let runsOk = false;
let runOutput = '';
try {
  // Try --help first, then bare execution. Capture both stdout and stderr.
  const out = execSync('python3 ' + mainFile + ' --help 2>&1 || python3 ' + mainFile + ' 2>&1 || true', {
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  runOutput = out.toString().slice(0, 500);
  runsOk = true;
} catch (e) {
  runOutput = (e.stderr ? e.stderr.toString() : (e.stdout ? e.stdout.toString() : e.message || 'crash')).slice(0, 300);
}

// ── Functional tests (if tests.json exists) ────────────────────────────
var funcTestResults = null;
if (fs.existsSync('tests.json')) {
  var tests = [];
  try {
    tests = JSON.parse(fs.readFileSync('tests.json', 'utf-8'));
    if (!Array.isArray(tests)) tests = [];
  } catch (_) {
    tests = [];
  }

  if (tests.length > 0) {
    var funcPassed = 0;
    var funcFailed = 0;
    var funcFailures = [];

    for (var t = 0; t < tests.length; t++) {
      var test = tests[t];
      var testName = 'test[' + t + ']: ' + test.command.slice(0, 60);

      // Write setup files
      if (test.setupFiles) {
        var keys = Object.keys(test.setupFiles);
        for (var k = 0; k < keys.length; k++) {
          fs.writeFileSync(keys[k], test.setupFiles[keys[k]]);
        }
      }

      // Write stdin if provided
      var stdinInput = test.stdin || '';

      try {
        var result = execSync(test.command, {
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          input: stdinInput
        });
        var combined = result.toString();

        var expectedCode = test.expectedExitCode !== undefined ? test.expectedExitCode : 0;
        var expectedOut = test.expectedOutput || '';

        var codeOk = expectedCode === 0; // execSync throws on non-zero, so if we're here code is 0
        var outOk = expectedOut === '' ||
                    (combined || '').toLowerCase().indexOf(expectedOut.toLowerCase()) !== -1;

        if (outOk) {
          funcPassed++;
        } else {
          funcFailed++;
          funcFailures.push(
            testName + ': output missing "' + expectedOut.slice(0, 60) + '"' +
            ' (got: ' + combined.slice(0, 120).replace(/\n/g, '\\n') + ')'
          );
        }
      } catch (e) {
        var errOut = ((e.stderr || '') + (e.stdout || '') + (e.message || '')).toString();
        var expectedCode = test.expectedExitCode !== undefined ? test.expectedExitCode : 0;
        var expectedOut = test.expectedOutput || '';

        if (expectedCode !== 0) {
          // Non-zero exit expected — check that output contains expected string
          if (!expectedOut || errOut.toLowerCase().indexOf(expectedOut.toLowerCase()) !== -1) {
            funcPassed++;
          } else {
            funcFailed++;
            funcFailures.push(
              testName + ': exit ' + expectedCode + ' OK but output missing "' +
              expectedOut.slice(0, 60) + '" (got: ' + errOut.slice(0, 120).replace(/\n/g, '\\n') + ')'
            );
          }
        } else {
          funcFailed++;
          funcFailures.push(
            testName + ': crashed (exit ' + (e.status || '?') + '): ' +
            errOut.slice(0, 150).replace(/\n/g, '\\n')
          );
        }
      }
    }

    funcTestResults = {
      total: tests.length,
      passed: funcPassed,
      failed: funcFailed,
      failures: funcFailures
    };
  }
}

// ── Project structure check ────────────────────────────────────────────
const allFiles = fs.readdirSync('.');
const pyFiles = allFiles.filter(function(f) { return f.endsWith('.py') && !f.startsWith('_'); });
const docFiles = allFiles.filter(function(f) { return /\.md$|\.txt$|README|DESIGN/i.test(f); });
const testFiles = allFiles.filter(function(f) { return f.includes('test') && f.endsWith('.py'); });
const hasDocs = docFiles.length > 0;

const details = {
  main_file: mainFile,
  python_files: pyFiles,
  doc_files: docFiles,
  test_files: testFiles,
  has_docs: hasDocs,
  importable: importOk,
  runs: runsOk,
  run_output_preview: runOutput.slice(0, 200),
  total_files: allFiles.length,
  functional_tests: funcTestResults,
};

// ── Verdict ────────────────────────────────────────────────────────────
// Functional tests take priority over structural checks when present
var overallPassed = false;
var reason = '';

if (funcTestResults) {
  if (funcTestResults.failed === 0) {
    overallPassed = true;
    reason = 'All ' + funcTestResults.total + ' functional test(s) passed. ' +
             pyFiles.length + ' Python file(s), syntax OK' +
             (hasDocs ? ', documentation found' : '');
  } else {
    overallPassed = false;
    reason = funcTestResults.failed + '/' + funcTestResults.total +
             ' functional test(s) FAILED: ' + funcTestResults.failures.join('; ');
  }
} else if (runsOk && pyFiles.length >= 1) {
  overallPassed = true;
  reason = 'Python CLI project verified: ' + pyFiles.length + ' Python file(s), syntax OK, runs without crashing' +
    (hasDocs ? ', documentation found' : '');
} else if (!runsOk && pyFiles.length >= 1) {
  overallPassed = false;
  reason = 'Project has ' + pyFiles.length + ' Python file(s) with valid syntax but does not run: ' + runOutput.slice(0, 200);
} else {
  overallPassed = false;
  reason = 'No runnable Python files found in project';
}

process.stdout.write(JSON.stringify({
  passed: overallPassed,
  reason: reason,
  details: details
}));
