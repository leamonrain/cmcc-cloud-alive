#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
  cachedCloudList,
  heartbeat,
  importLegacyState,
  isHeartbeatAccepted,
  listClouds,
  loadState,
  maskState,
  smsLogin,
  smsSend,
  tokenCheck,
} = require('../lib/family-api');

function usage() {
  console.log(`Usage:
  cmcc-cloud-alive sms-send <phone>
  cmcc-cloud-alive sms-login <phone> <code>
  cmcc-cloud-alive list
  cmcc-cloud-alive list-cache
  cmcc-cloud-alive heartbeat <userServiceId>
  cmcc-cloud-alive heartbeat-loop <userServiceId> [--interval-ms 30000]
  cmcc-cloud-alive token-check
  cmcc-cloud-alive import-legacy-state
  cmcc-cloud-alive state
  cmcc-cloud-alive analyze-cag <pcap> [--limit N]
  cmcc-cloud-alive analyze-loopback <pcap>
  cmcc-cloud-alive test

This project is the protocol-level implementation workspace. It does not start
the official SDK client.`);
}

function runNodeScript(script, args) {
  const scriptPath = path.join(__dirname, '..', 'scripts', script);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

function printCloudList(list) {
  if (!list.length) {
    console.log('no cloud PC found');
    return;
  }
  list.forEach((item, i) => {
    console.log(`${i}: userServiceId=${item.userServiceId} vmName=${item.vmName || item.cloudPcName || ''} spuCode=${item.spuCode || ''} sku=${item.skuName || ''}`);
  });
}

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] === undefined ? fallback : args[index + 1];
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveCachedUserServiceId(value) {
  if (value) return value;
  const cached = cachedCloudList();
  if (cached[0]?.userServiceId) return cached[0].userServiceId;
  const fresh = await listClouds();
  if (fresh[0]?.userServiceId) return fresh[0].userServiceId;
  throw new Error('no userServiceId found; run list first or pass one explicitly');
}

async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = argv.slice(1);
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'sms-send') {
    const response = await smsSend(args[0]);
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (cmd === 'sms-login') {
    await smsLogin(args[0], args[1]);
    console.log('login ok');
    return;
  }
  if (cmd === 'list') {
    printCloudList(await listClouds());
    return;
  }
  if (cmd === 'list-cache') {
    printCloudList(cachedCloudList());
    return;
  }
  if (cmd === 'heartbeat') {
    const userServiceId = await resolveCachedUserServiceId(args[0]);
    const response = await heartbeat(userServiceId);
    console.log(JSON.stringify({
      ok: true,
      acceptedByClientLogic: isHeartbeatAccepted(response),
      userServiceId,
      code: response.code,
      msg: response.msg,
      businessCode: response.businessCode || '',
    }, null, 2));
    return;
  }
  if (cmd === 'heartbeat-loop') {
    const userServiceId = await resolveCachedUserServiceId(args[0]?.startsWith('--') ? '' : args[0]);
    const intervalMs = Math.max(5000, Number(readOption(args, '--interval-ms', 30000)));
    let stopped = false;
    process.on('SIGINT', () => { stopped = true; });
    process.on('SIGTERM', () => { stopped = true; });
    console.log(`heartbeat loop started: userServiceId=${userServiceId} intervalMs=${intervalMs}`);
    let count = 0;
    while (!stopped) {
      count++;
      const started = Date.now();
      const response = await heartbeat(userServiceId);
      console.log(`[${formatTime()}] [${count}] heartbeat accepted=${isHeartbeatAccepted(response)} code=${response.code} msg=${response.msg || ''} businessCode=${response.businessCode || ''}`);
      const elapsed = Date.now() - started;
      await wait(Math.max(0, intervalMs - elapsed));
    }
    console.log('heartbeat loop stopped');
    return;
  }
  if (cmd === 'token-check') {
    console.log(JSON.stringify(await tokenCheck(), null, 2));
    return;
  }
  if (cmd === 'import-legacy-state') {
    const state = importLegacyState();
    console.log(`imported legacy state to ${state._stateFile}`);
    return;
  }
  if (cmd === 'state') {
    const state = loadState();
    console.log(JSON.stringify({
      source: state._stateSource,
      stateFile: state._stateFile,
      state: maskState(state),
    }, null, 2));
    return;
  }
  if (cmd === 'analyze-cag') return runNodeScript('analyze-cag-transport.js', args);
  if (cmd === 'analyze-loopback') return runNodeScript('analyze-loopback-spice.js', args);
  if (cmd === 'test') return runNodeScript('../tests/protocol-codec.test.js', []);
  usage();
  process.exit(2);
}

main().catch((err) => {
  console.error(err.message);
  if (err.response) console.error(JSON.stringify(err.response, null, 2));
  process.exit(1);
});
