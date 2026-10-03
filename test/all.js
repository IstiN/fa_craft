'use strict';
// Single-process runner: all suites register on node:test, then the process
// drains them. Coverage sources load from .nyc-src/ when present (npm run cover).
require('./harness.js');

const suites = [
  'ut_worldgen',
  'ut_eventlog',
  'ut_physics',
  'ut_raycast',
  'ut_mesh',
  'ut_fx',
  'ut_craft',
  'ut_survival',
  'ut_daynight',
  'ut_inputmap',
  'ut_version',
  'it_game',
  'it_persistence',
  'it_localonly',
];
suites.forEach((s) => require('./' + s + '.test.js'));

process.on('exit', () => {
  try {
    if (global.__coverage__) {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '..', '.nyc_output');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'coverage-final.json'), JSON.stringify(global.__coverage__));
    }
  } catch (e) { /* coverage dump must never fail the run */ }
});
