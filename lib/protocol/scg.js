'use strict';

const crypto = require('crypto');

function normalizeTimestampSeconds(timestamp = Date.now()) {
  if (timestamp instanceof Date) return Math.floor(timestamp.getTime() / 1000);
  if (!Number.isFinite(Number(timestamp))) throw new Error('timestamp must be numeric');
  const value = Number(timestamp);
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function buildScgAuthPlaintext(opts = {}) {
  const scAuthCode = String(opts.scAuthCode || '');
  const vmId = String(opts.vmId || '');
  if (!scAuthCode) throw new Error('scAuthCode is required');
  if (!vmId) throw new Error('vmId is required');

  const credential = Buffer.from(scAuthCode, 'utf8');
  if (credential.length > 0xffff) throw new Error('scAuthCode is too long');

  const suffix = Buffer.from(`|${vmId}`, 'utf8');
  const out = Buffer.alloc(13 + credential.length + suffix.length);
  out.writeUInt16BE(0x0002, 0);
  out.writeBigUInt64BE(BigInt(normalizeTimestampSeconds(opts.timestamp)), 2);
  out.writeUInt8(0x03, 10);
  out.writeUInt16BE(credential.length, 11);
  credential.copy(out, 13);
  suffix.copy(out, 13 + credential.length);
  return out;
}

function aes128CtrEncrypt(plaintext, opts = {}) {
  const key = Buffer.from(opts.key || []);
  const iv = Buffer.from(opts.iv || []);
  if (key.length !== 16) throw new Error('AES-128-CTR key must be 16 bytes');
  if (iv.length !== 16) throw new Error('AES-128-CTR iv must be 16 bytes');
  const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
  return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
}

function buildScgAuthCiphertext(opts = {}) {
  return aes128CtrEncrypt(buildScgAuthPlaintext(opts), opts);
}

function buildScgAuthPacket(opts = {}) {
  const ciphertext = buildScgAuthCiphertext(opts);
  return Buffer.concat([Buffer.from([0x01, ciphertext.length & 0xff]), ciphertext]);
}

function parseScgAuthResponse(input, opts = {}) {
  const buffer = Buffer.from(input || []);
  if (buffer.length < 1) throw new Error('SCG auth response is empty');
  const ok = buffer.readUInt8(0) === 0x00;
  const out = {
    ok,
    code: buffer.readUInt8(0),
    raw: buffer,
  };
  if (opts.sessionOffset !== undefined) {
    const offset = Number(opts.sessionOffset);
    const length = Number(opts.sessionLength || 3);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('sessionOffset must be a non-negative integer');
    if (!Number.isInteger(length) || length <= 0) throw new Error('sessionLength must be a positive integer');
    if (buffer.length < offset + length) throw new Error('SCG auth response is too short for session_id');
    out.sessionIdBytes = buffer.subarray(offset, offset + length);
    out.sessionId = BigInt(`0x${out.sessionIdBytes.toString('hex') || '0'}`);
  }
  return out;
}

module.exports = {
  normalizeTimestampSeconds,
  buildScgAuthPlaintext,
  aes128CtrEncrypt,
  buildScgAuthCiphertext,
  buildScgAuthPacket,
  parseScgAuthResponse,
};
