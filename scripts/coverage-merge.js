'use strict';
// Merge per-process raw __coverage__ dumps (.nyc_output/*.json) into the
// Istanbul-format coverage/coverage-final.json that crap4js consumes.
const fs = require('fs');
const path = require('path');
const libCoverage = require('istanbul-lib-coverage');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, '.nyc_output');
const map = libCoverage.createCoverageMap({});
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    map.merge(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
}
const outDir = path.join(root, 'coverage');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'coverage-final.json'), JSON.stringify(map.toJSON()));
console.log('coverage-merge: ' + map.files().length + ' files');
