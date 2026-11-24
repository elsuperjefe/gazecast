'use strict';
// Controls the GazeCast browser window (minimise, restore, maximise, full screen)
// through a small PowerShell helper, because a web page cannot minimise itself.

const { execFile } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'window.ps1');
const ACTIONS = ['minimize', 'restore', 'maximize', 'zoom', 'fullscreen', 'find'];

function fail(message) { const e = new Error(message); e.friendly = true; return e; }

// Resolves { ok: true } or rejects with a friendly Error. Never throws synchronously.
function control(action, pid) {
  return new Promise((resolve, reject) => {
    if (ACTIONS.indexOf(action) < 0) return reject(fail('Unknown window action.'));
    if (process.platform !== 'win32') return reject(fail('Window buttons only work on Windows.'));
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCRIPT, '-Action', action];
    if (Number.isInteger(pid) && pid > 0) args.push('-ProcId', String(pid));
    execFile('powershell.exe', args, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '').trim();
      if (/\bOK\b/.test(out)) return resolve({ ok: true });
      if (/NOTFOUND/.test(out)) return reject(fail('The GazeCast window could not be found. Use the keyboard instead: F11 for full screen, Alt+F4 to close.'));
      reject(fail('Windows did not let GazeCast change its window. Use the keyboard instead: F11 for full screen, Alt+F4 to close.'));
    });
  });
}

module.exports = { control };
