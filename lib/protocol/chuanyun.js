'use strict';

const CHUANYUN_HEAD_SIZE = 24;
const CHUANYUN_VERSION = 0x01;

const ChuanyunFrameType = Object.freeze({
  DATA: 1,
  CONTROL: 2,
  SERVER_CLOSE: 3,
});

const ChuanyunChannel = Object.freeze({
  MAIN: 1,
  DISPLAY: 2,
});

function assertUInt8(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must be uint8`);
  }
}

function normalizeUInt64(value, name) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`${name} must be uint64`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be uint64`);
  return BigInt(value);
}

function encodeChuanyunHead(opts = {}) {
  const type = opts.type ?? ChuanyunFrameType.DATA;
  const payloadLength = opts.payloadLength ?? Buffer.byteLength(opts.payload || Buffer.alloc(0));
  const sessionId = normalizeUInt64(opts.sessionId ?? 0, 'sessionId');
  const channelId = normalizeUInt64(opts.channelId ?? ChuanyunChannel.MAIN, 'channelId');

  assertUInt8(type, 'type');
  if (!Number.isInteger(payloadLength) || payloadLength < 0 || payloadLength > 0xffff) {
    throw new Error('payloadLength must be uint16');
  }

  const out = Buffer.alloc(CHUANYUN_HEAD_SIZE);
  out.writeUInt8(CHUANYUN_VERSION, 0);
  out.writeUInt8(type, 1);
  out.writeUInt16LE(payloadLength, 2);
  out.writeUInt32LE(0, 4);
  out.writeBigUInt64LE(sessionId, 8);
  out.writeBigUInt64LE(channelId, 16);
  return out;
}

function decodeChuanyunHead(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < CHUANYUN_HEAD_SIZE) {
    throw new Error(`ChuanyunHead requires ${CHUANYUN_HEAD_SIZE} bytes`);
  }
  const version = buffer.readUInt8(0);
  if (version !== CHUANYUN_VERSION) {
    throw new Error(`unsupported ChuanyunHead version: ${version}`);
  }
  return {
    version,
    type: buffer.readUInt8(1),
    payloadLength: buffer.readUInt16LE(2),
    reserved: buffer.readUInt32LE(4),
    sessionId: buffer.readBigUInt64LE(8),
    channelId: buffer.readBigUInt64LE(16),
  };
}

function encodeChuanyunFrame(opts = {}) {
  const payload = Buffer.from(opts.payload || Buffer.alloc(0));
  const head = encodeChuanyunHead({ ...opts, payloadLength: payload.length });
  return Buffer.concat([head, payload]);
}

function decodeChuanyunFrame(input) {
  const buffer = Buffer.from(input);
  const head = decodeChuanyunHead(buffer);
  const frameLength = CHUANYUN_HEAD_SIZE + head.payloadLength;
  if (buffer.length < frameLength) {
    throw new Error(`Chuanyun frame incomplete: need ${frameLength}, got ${buffer.length}`);
  }
  return {
    head,
    payload: buffer.subarray(CHUANYUN_HEAD_SIZE, frameLength),
    rest: buffer.subarray(frameLength),
  };
}

module.exports = {
  CHUANYUN_HEAD_SIZE,
  CHUANYUN_VERSION,
  ChuanyunFrameType,
  ChuanyunChannel,
  encodeChuanyunHead,
  decodeChuanyunHead,
  encodeChuanyunFrame,
  decodeChuanyunFrame,
};
