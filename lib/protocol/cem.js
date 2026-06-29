'use strict';

const crypto = require('crypto');
const os = require('os');

const DEFAULT_CEM_OAUTH_PATH = '/gzs/auth/oauth/token';

function normalizePemPublicKey(publicKeyBody) {
  const input = String(publicKeyBody || '').trim();
  if (!input) throw new Error('CEM public key is required');
  if (input.includes('BEGIN PUBLIC KEY')) return input;
  return `-----BEGIN PUBLIC KEY-----\n${input.replace(/\s+/g, '')}\n-----END PUBLIC KEY-----`;
}

function encryptCemPayload(data, publicKeyBody) {
  const publicKey = normalizePemPublicKey(publicKeyBody);
  const raw = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  const chunks = [];
  for (let offset = 0; offset < raw.length; offset += 117) {
    chunks.push(crypto.publicEncrypt({
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, raw.subarray(offset, offset + 117)));
  }
  return `{rsa}${Buffer.concat(chunks).toString('base64')}`;
}

function createCemHeaders(opts = {}) {
  const clientId = String(opts.clientId || '').trim();
  const terminalSn = String(opts.terminalSn || opts.deviceId || '').trim();
  if (!clientId) throw new Error('gzs-client-id is required');
  if (!terminalSn) throw new Error('sc-terminal-sn is required');
  const headers = {
    'gzs-client-id': clientId,
    'gzs-timestamp': String(opts.timestamp || Date.now()),
    'sc-terminal-sn': terminalSn,
    'sc-network-type': String(opts.networkType || 2),
    'sc-unit-type': String(opts.unitType || os.hostname() || 'Linux'),
  };
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
  return headers;
}

function readCemProbeConfig(env = process.env) {
  const config = {
    baseUrl: env.YDY_CEM_BASE_URL || '',
    oauthPath: env.YDY_CEM_OAUTH_PATH || DEFAULT_CEM_OAUTH_PATH,
    connectInfoPath: env.YDY_CEM_CONNECT_INFO_PATH || '',
    clientId: env.YDY_CEM_CLIENT_ID || '',
    publicKey: env.YDY_CEM_PUBLIC_KEY || '',
  };
  const missing = [];
  if (!config.baseUrl) missing.push('YDY_CEM_BASE_URL');
  if (!config.clientId) missing.push('YDY_CEM_CLIENT_ID');
  if (!config.publicKey) missing.push('YDY_CEM_PUBLIC_KEY');
  if (!config.connectInfoPath) missing.push('YDY_CEM_CONNECT_INFO_PATH');
  return {
    ...config,
    configured: missing.length === 0,
    missing,
  };
}

module.exports = {
  DEFAULT_CEM_OAUTH_PATH,
  normalizePemPublicKey,
  encryptCemPayload,
  createCemHeaders,
  readCemProbeConfig,
};
