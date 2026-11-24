'use strict';
// Thin wrapper around adb.exe. Everything is run with execFile/spawn and an
// argument array, so nothing typed in the page is ever interpreted by a
// Windows shell. Text that reaches the phone's shell is quoted with shq().

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* keep looking */ }
  }
  return null;
}

function locate() {
  const adbCandidates = [
    path.join(TOOLS, 'platform-tools', 'adb.exe'),
    path.join(TOOLS, 'scrcpy', 'adb.exe'),
  ];
  let adb = adbCandidates.find((p) => fs.existsSync(p)) || findOnPath('adb.exe');
  // The scrcpy *server* must match the protocol version this bridge speaks,
  // so only the copy fetched by setup.ps1 is used.
  let server = path.join(TOOLS, 'scrcpy', 'scrcpy-server');
  if (!fs.existsSync(server)) server = null;
  let serverVersion = '5.0.1';
  try {
    const v = JSON.parse(fs.readFileSync(path.join(TOOLS, 'versions.json'), 'utf8').replace(/^﻿/, ''));
    if (v && v.scrcpy) serverVersion = String(v.scrcpy);
  } catch (e) { /* default */ }
  return { adb, server, serverVersion };
}

const paths = locate();
const ENV = Object.assign({}, process.env, { ADB_MDNS_OPENSCREEN: '1' });

function run(args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    if (!paths.adb) return resolve({ code: -1, stdout: '', stderr: 'adb not found' });
    const full = opts.serial ? ['-s', opts.serial].concat(args) : args;
    execFile(paths.adb, full, {
      timeout: opts.timeout || 15000,
      maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
      encoding: opts.binary ? 'buffer' : 'utf8',
      windowsHide: true,
      env: ENV,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || (opts.binary ? Buffer.alloc(0) : ''),
        stderr: String(stderr || ''),
        timedOut: !!(err && err.killed),
      });
    });
  });
}

// Run a command line in the phone's shell.
function shell(serial, command, opts) {
  return run(['shell', command], Object.assign({ serial }, opts || {}));
}

function spawnAdb(args, serial) {
  const full = serial ? ['-s', serial].concat(args) : args;
  return spawn(paths.adb, full, { windowsHide: true, env: ENV });
}

// Quote one argument for the Android shell.
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function isWifiSerial(serial) {
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial) || /_adb-tls-connect\._tcp/.test(serial);
}

async function devices() {
  const r = await run(['devices', '-l'], { timeout: 8000 });
  if (r.code !== 0) return null;
  const list = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(device|unauthorized|offline|authorizing|connecting)\b(.*)$/.exec(line);
    if (!m) continue;
    const model = /model:(\S+)/.exec(m[3]);
    list.push({
      serial: m[1],
      state: m[2],
      model: model ? model[1].replace(/_/g, ' ') : '',
      transport: isWifiSerial(m[1]) ? 'wifi' : 'usb',
    });
  }
  return list;
}

// Phones announcing Wireless debugging on the local network.
async function mdns() {
  const r = await run(['mdns', 'services'], { timeout: 6000 });
  const out = [];
  if (r.code !== 0) return out;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(_adb-tls-(?:connect|pairing)\._tcp)\.?\s+(\d+\.\d+\.\d+\.\d+):(\d+)/.exec(line);
    if (m) out.push({ name: m[1], kind: m[2].indexOf('pairing') >= 0 ? 'pairing' : 'connect', host: m[3], port: Number(m[4]) });
  }
  return out;
}

// Default gateways of this PC. If the phone is the gateway, the PC is on the phone's hotspot.
function gateways() {
  return new Promise((resolve) => {
    execFile('route', ['print', '-4', '0.0.0.0'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const set = [];
      if (!err) {
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s/.exec(line);
          if (m && set.indexOf(m[1]) < 0) set.push(m[1]);
        }
      }
      resolve(set);
    });
  });
}

module.exports = { ROOT, TOOLS, paths, run, shell, spawnAdb, shq, devices, mdns, gateways, isWifiSerial };
