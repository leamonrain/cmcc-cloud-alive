#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CANDIDATES = [
  path.join(process.cwd(), 'index-CMvLHynQ.js'),
  path.join(process.cwd(), 'home.vue'),
  '/opt/yidongyun/client/opt/chuanyun-vdi-client/resources/app.asar',
];

function readIfExists(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function findRegexEvidence(source, regex, label, file) {
  const out = [];
  let match;
  while ((match = regex.exec(source)) !== null) {
    out.push({
      label,
      file,
      line: lineNumber(source, match.index),
      match: match[0].slice(0, 240),
    });
    if (!regex.global) break;
  }
  return out;
}

function collectEvidence(file, source) {
  return [
    ...findRegexEvidence(source, /HEART_BEAT:\s*["']\/cc\/cloudPc\/heartbeat\/v2["']/g, 'ordinary-heartbeat-constant-v2', file),
    ...findRegexEvidence(source, /TIME_ZONE_HEART_BEAT:\s*["']\/timeZone\/heartbeat\/v1["']/g, 'time-zone-heartbeat-is-separate-v1', file),
    ...findRegexEvidence(source, /url:\s*(?:modules\.URL\.HEART_BEAT|this\.\$CONSTANTS\.URL\.HEART_BEAT)[\s\S]{0,120}?userServiceId/g, 'ordinary-heartbeat-sends-userServiceId', file),
    ...findRegexEvidence(source, /if\s*\([^)]*d2?\.code\s*==\s*(?:modules\.STATUS\.YUN_OTHER_LOGIN|this\.\$CONSTANTS\.STATUS\.YUN_OTHER_LOGIN)[\s\S]{0,360}?return/g, 'heartbeat-stops-on-4043-only', file),
    ...findRegexEvidence(source, /setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,160}heartbeat\([^)]*userServiceId[\s\S]{0,120}time\)/g, 'heartbeat-reschedules-after-non-4043', file),
    ...findRegexEvidence(source, /cloudPcheartbeatTime["']?\s*,\s*info\.cloudPcheartbeatTime\s*\*\s*1e3/g, 'official-settings-heartbeat-interval', file),
    ...findRegexEvidence(source, /heartbeat\([^)]*item\.id[\s\S]{0,80}cloudPcheartbeatTime\)/g, 'connect-success-starts-ordinary-heartbeat', file),
    ...findRegexEvidence(source, /GET_FIRM_AUTH:\s*["']\/cc\/getFirmAuth\/v1["']/g, 'ordinary-connect-auth-before-sdk-worker', file),
    ...findRegexEvidence(source, /mainApi\.connectWorker\(\{\s*userServiceId:[\s\S]{0,160}\.\.\.d2?\.data\s*\}\)/g, 'official-client-worker-after-getFirmAuth', file),
  ];
}

function summarize(evidence) {
  const labels = new Set(evidence.map((item) => item.label));
  return {
    ordinaryHeartbeatV2: labels.has('ordinary-heartbeat-constant-v2'),
    timeZoneV1Separate: labels.has('time-zone-heartbeat-is-separate-v1'),
    sendsOnlyUserServiceId: labels.has('ordinary-heartbeat-sends-userServiceId'),
    stopsOnOtherLogin4043: labels.has('heartbeat-stops-on-4043-only'),
    reschedulesAfterNon4043: labels.has('heartbeat-reschedules-after-non-4043'),
    officialIntervalFound: labels.has('official-settings-heartbeat-interval'),
    connectSuccessStartsHeartbeat: labels.has('connect-success-starts-ordinary-heartbeat'),
    getFirmAuthFeedsOfficialWorker: labels.has('ordinary-connect-auth-before-sdk-worker') &&
      labels.has('official-client-worker-after-getFirmAuth'),
  };
}

function main(argv = process.argv.slice(2)) {
  const files = argv.length ? argv : DEFAULT_CANDIDATES;
  const scanned = [];
  const evidence = [];
  for (const file of files) {
    const source = readIfExists(file);
    if (!source) continue;
    scanned.push(file);
    evidence.push(...collectEvidence(file, source));
  }
  const summary = summarize(evidence);
  const ok = summary.ordinaryHeartbeatV2 &&
    summary.timeZoneV1Separate &&
    summary.sendsOnlyUserServiceId &&
    summary.stopsOnOtherLogin4043 &&
    summary.reschedulesAfterNon4043;
  console.log(JSON.stringify({
    ok,
    scope: 'family ordinary cloud PC source audit',
    scanned,
    summary,
    evidence,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
