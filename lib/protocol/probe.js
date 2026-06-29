'use strict';

const { normalizeProtocolConnectInfo } = require('./connect-info');
const { probeCagTcpTls } = require('./cag-tls');
const { readCemProbeConfig } = require('./cem');

function classifyProtocolRoute(auth = {}) {
  const scgIp = String(auth.scgIp || '').trim();
  const scgTcpPort = Number(auth.scgTcpPort || auth.scgPort || 0);
  const cagIp = String(auth.cagIp || '').trim();
  const cagPort = Number(auth.cagPort || 0);
  const hasScg = Boolean(scgIp && Number.isInteger(scgTcpPort) && scgTcpPort > 0);
  const hasCag = Boolean(cagIp && Number.isInteger(cagPort) && cagPort > 0);
  if (hasScg && scgTcpPort === 10800) {
    return {
      route: 'blog-scg',
      source: 'scg',
      host: scgIp,
      port: scgTcpPort,
      protocolAligned: true,
      reason: 'getFirmAuth returned SCG TCP 10800, matching the blog route',
    };
  }
  if (hasScg) {
    return {
      route: 'scg-other',
      source: 'scg',
      host: scgIp,
      port: scgTcpPort,
      protocolAligned: false,
      reason: 'getFirmAuth returned SCG, but not the blog TCP 10800 endpoint',
    };
  }
  if (hasCag) {
    return {
      route: 'linux-cag',
      source: 'cag',
      host: cagIp,
      port: cagPort,
      protocolAligned: false,
      reason: 'getFirmAuth returned Linux/ZTE CAG instead of the blog SCG route',
    };
  }
  return {
    route: 'unknown',
    source: '',
    host: '',
    port: 0,
    protocolAligned: false,
    reason: 'getFirmAuth did not return a usable SCG or CAG endpoint',
  };
}

function createProtocolProbeReport(opts = {}) {
  const auth = opts.auth || {};
  const route = classifyProtocolRoute(auth);
  let connectInfo = null;
  try {
    const normalized = normalizeProtocolConnectInfo(auth);
    connectInfo = {
      vmId: normalized.vmId,
      host: normalized.host,
      port: normalized.port,
      source: normalized.source,
      vmcIp: normalized.vmcIp,
      vmcPort: normalized.vmcPort,
      accessCredentialPresent: Boolean(normalized.scAuthCode),
      accessCredentialLength: String(normalized.scAuthCode || '').length,
      accessCredentialSource: normalized.credentialSource,
      scAuthCodePresent: Boolean(auth.scAuthCode),
      vmPasswordAsCredential: !auth.scAuthCode && Boolean(auth.vmPassword),
      bizCodePresent: Boolean(normalized.bizCode),
      connectIdPresent: Boolean(normalized.connectId),
    };
  } catch (err) {
    connectInfo = { error: err.message };
  }
  const cem = readCemProbeConfig(opts.env || process.env);
  return {
    userServiceId: opts.userServiceId || '',
    vmId: auth.vmId || auth.vmID || '',
    spuCode: auth.spuCode || '',
    route,
    connectInfo,
    authMaterial: {
      scAuthCode: Boolean(auth.scAuthCode),
      bizCode: Boolean(auth.bizCode),
      connectId: Boolean(auth.connectId),
      vmUserName: Boolean(auth.vmUserName),
      vmPassword: Boolean(auth.vmPassword),
    },
    safe: {
      sdkStarted: false,
      desktopConnectSent: false,
      spiceAuthSent: false,
    },
    cemProbe: {
      configured: cem.configured,
      missing: cem.missing,
      oauthPath: cem.oauthPath,
      connectInfoPath: cem.connectInfoPath,
    },
  };
}

async function probeProtocolRoute(opts = {}) {
  const report = createProtocolProbeReport(opts);
  if (opts.tlsProbe !== false && report.route.source === 'cag') {
    report.cagTcpTls = await probeCagTcpTls({
      host: report.route.host,
      port: report.route.port,
      timeoutMs: opts.timeoutMs || 5000,
    });
  }
  return report;
}

module.exports = {
  classifyProtocolRoute,
  createProtocolProbeReport,
  probeProtocolRoute,
};
