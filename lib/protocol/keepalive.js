'use strict';

const {
  ProtocolStage,
  applyProtocolEvent,
  createProtocolProgress,
} = require('./events');
const { normalizeProtocolConnectInfo } = require('./connect-info');
const { probeCagTcpTls } = require('./cag-tls');

function createProtocolUnsupportedError() {
  const missing = [
    'validated CEM getConnectInfo chain or Linux getFirmAuth equivalence notes',
    'Linux ZTE CAG UDP ZTEC handshake and tunnel sequence semantics',
    'SCG AES-128-CTR auth packet for the blog 10800 variant when applicable',
    'TLS/SPICE stream carried inside the observed ZTE CAG tunnel',
    'ChuanyunHead or ZTE CAG framed SPICE main/display handshakes',
    'DISPLAY_INIT send and SURFACE_CREATE/DRAW_COPY/MARK verification',
    'SET_ACK and PING/PONG response loop',
  ];
  const err = new Error(`protocol keepalive is not implemented yet; missing: ${missing.join(', ')}`);
  err.code = 'YDY_PROTOCOL_NOT_IMPLEMENTED';
  err.missing = missing;
  return err;
}

async function keepaliveProtocol(opts = {}, runOpts = {}) {
  const logger = runOpts.logger || console;
  let progress = createProtocolProgress();
  logger.log('[protocol] mode selected; SDK client will not be started');
  logger.log(`[protocol] success requires ${ProtocolStage.DISPLAY_INIT_SENT} plus display surface/screen messages`);
  const connectInfo = normalizeProtocolConnectInfo(opts.auth || {});
  logger.log(`[protocol] connect target: ${connectInfo.source} ${connectInfo.host}:${connectInfo.port} vmId=${connectInfo.vmId}`);
  logger.log(`[protocol] auth material present: scAuthCode=${Boolean(connectInfo.scAuthCode)} bizCode=${Boolean(connectInfo.bizCode)} connectId=${Boolean(connectInfo.connectId)}`);
  if (connectInfo.source === 'cag') {
    const tlsInfo = await probeCagTcpTls({
      host: connectInfo.host,
      port: connectInfo.port,
      timeoutMs: opts.probeTimeoutMs || 5000,
    });
    progress = applyProtocolEvent(progress, ProtocolStage.TLS_OK);
    logger.log(`[protocol] CAG TCP TLS ok: protocol=${tlsInfo.protocol} cipher=${tlsInfo.cipher?.name || ''} subjectCN=${tlsInfo.peerSubject?.CN || ''}`);
    logger.log('[protocol] TCP TLS probe is transport evidence only; it is not keepalive success');
  }
  logger.log(`[protocol] progress: ${JSON.stringify(progress)}`);
  throw createProtocolUnsupportedError();
}

module.exports = {
  keepaliveProtocol,
  createProtocolUnsupportedError,
};
