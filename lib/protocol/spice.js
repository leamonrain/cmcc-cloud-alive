'use strict';

const SPICE_MAGIC = Buffer.from('REDQ', 'ascii');
const SPICE_LINK_HEADER_SIZE = 16;
const SPICE_LINK_MESS_BASE_SIZE = 18;
const SPICE_LINK_REPLY_BASE_SIZE = 178;
const MINI_HEADER_SIZE = 6;
const DATA_HEADER_SIZE = 18;
const SPICE_TICKET_PUBKEY_BYTES = 162;
const SPICE_LINK_ERR_OK = 0;

const SpiceChannel = Object.freeze({
  MAIN: 1,
  DISPLAY: 2,
});

const SpiceMessage = Object.freeze({
  SET_ACK: 0x0003,
  PING: 0x0004,
  PONG: 0x0005,
  ACK_SYNC: 0x0006,
  ACK: 0x0007,
  MAIN_INIT: 0x0067,
  CHANNELS_LIST: 0x0068,
  MARK: 0x0066,
  DISPLAY_INIT: 0x0065,
  DRAW_COPY: 0x0130,
  SURFACE_CREATE: 0x013a,
});

const SpiceCommonCapability = Object.freeze({
  MINI_HEADER: 3,
});

function assertUInt8(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must be uint8`);
  }
}

function assertUInt16(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${name} must be uint16`);
  }
}

function assertUInt32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} must be uint32`);
  }
}

function encodeCapabilityWords(bits = []) {
  const words = [];
  for (const bit of bits) {
    if (!Number.isInteger(bit) || bit < 0) throw new Error('capability bit must be a non-negative integer');
    const wordIndex = Math.floor(bit / 32);
    while (words.length <= wordIndex) words.push(0);
    words[wordIndex] |= (1 << (bit % 32)) >>> 0;
  }
  const out = Buffer.alloc(words.length * 4);
  words.forEach((word, i) => out.writeUInt32LE(word >>> 0, i * 4));
  return out;
}

function decodeCapabilityWords(input, wordCount, offset = 0) {
  const buffer = Buffer.from(input);
  const count = Number(wordCount || 0);
  if (!Number.isInteger(count) || count < 0) throw new Error('wordCount must be a non-negative integer');
  if (buffer.length < offset + count * 4) throw new Error('capability data is incomplete');
  const words = [];
  const bits = [];
  for (let i = 0; i < count; i++) {
    const word = buffer.readUInt32LE(offset + i * 4);
    words.push(word);
    for (let bit = 0; bit < 32; bit++) {
      if (word & (1 << bit)) bits.push(i * 32 + bit);
    }
  }
  return { words, bits };
}

function encodeSpiceLinkHeader(size, opts = {}) {
  assertUInt32(size, 'size');
  const out = Buffer.alloc(SPICE_LINK_HEADER_SIZE);
  SPICE_MAGIC.copy(out, 0);
  out.writeUInt32LE(opts.majorVersion ?? 2, 4);
  out.writeUInt32LE(opts.minorVersion ?? 2, 8);
  out.writeUInt32LE(size, 12);
  return out;
}

function decodeSpiceLinkHeader(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < SPICE_LINK_HEADER_SIZE) {
    throw new Error(`SPICE link header requires ${SPICE_LINK_HEADER_SIZE} bytes`);
  }
  const magic = buffer.subarray(0, 4);
  if (!magic.equals(SPICE_MAGIC)) {
    throw new Error(`unsupported SPICE link magic: ${magic.toString('hex')}`);
  }
  return {
    magic,
    majorVersion: buffer.readUInt32LE(4),
    minorVersion: buffer.readUInt32LE(8),
    size: buffer.readUInt32LE(12),
  };
}

function encodeSpiceLinkMess(opts = {}) {
  const connectionId = opts.connectionId ?? 0;
  const channelType = opts.channelType ?? SpiceChannel.MAIN;
  const channelId = opts.channelId ?? 0;
  const commonCaps = Buffer.from(opts.commonCaps || encodeCapabilityWords([SpiceCommonCapability.MINI_HEADER]));
  const channelCaps = Buffer.from(opts.channelCaps || Buffer.alloc(0));
  assertUInt32(connectionId, 'connectionId');
  assertUInt8(channelType, 'channelType');
  assertUInt8(channelId, 'channelId');
  if (commonCaps.length % 4 !== 0) throw new Error('commonCaps length must be a multiple of 4');
  if (channelCaps.length % 4 !== 0) throw new Error('channelCaps length must be a multiple of 4');

  const bodySize = SPICE_LINK_MESS_BASE_SIZE + commonCaps.length + channelCaps.length;
  const capsOffset = SPICE_LINK_MESS_BASE_SIZE;
  const body = Buffer.alloc(SPICE_LINK_MESS_BASE_SIZE);
  body.writeUInt32LE(connectionId, 0);
  body.writeUInt8(channelType, 4);
  body.writeUInt8(channelId, 5);
  body.writeUInt32LE(commonCaps.length / 4, 6);
  body.writeUInt32LE(channelCaps.length / 4, 10);
  body.writeUInt32LE(capsOffset, 14);
  return Buffer.concat([encodeSpiceLinkHeader(bodySize, opts), body, commonCaps, channelCaps]);
}

function decodeSpiceLinkMess(input) {
  const buffer = Buffer.from(input);
  const link = decodeSpiceLinkHeader(buffer);
  const total = SPICE_LINK_HEADER_SIZE + link.size;
  if (buffer.length < total) throw new Error(`SPICE link message incomplete: need ${total}, got ${buffer.length}`);
  const body = buffer.subarray(SPICE_LINK_HEADER_SIZE, total);
  if (body.length < SPICE_LINK_MESS_BASE_SIZE) throw new Error('SPICE link message body is too short');
  const numCommonCaps = body.readUInt32LE(6);
  const numChannelCaps = body.readUInt32LE(10);
  const capsOffset = body.readUInt32LE(14);
  const commonCaps = decodeCapabilityWords(body, numCommonCaps, capsOffset);
  const channelCaps = decodeCapabilityWords(body, numChannelCaps, capsOffset + numCommonCaps * 4);
  return {
    header: link,
    connectionId: body.readUInt32LE(0),
    channelType: body.readUInt8(4),
    channelId: body.readUInt8(5),
    numCommonCaps,
    numChannelCaps,
    capsOffset,
    commonCaps,
    channelCaps,
    rest: buffer.subarray(total),
  };
}

function readDerObjectLength(buffer, offset = 0) {
  if (buffer.length < offset + 2) throw new Error('DER object is too short');
  if (buffer[offset] !== 0x30) throw new Error(`DER object must start with SEQUENCE, got 0x${buffer[offset].toString(16)}`);
  const firstLength = buffer[offset + 1];
  if ((firstLength & 0x80) === 0) return 2 + firstLength;
  const lengthBytes = firstLength & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4) throw new Error('unsupported DER length encoding');
  if (buffer.length < offset + 2 + lengthBytes) throw new Error('DER length is incomplete');
  let length = 0;
  for (let i = 0; i < lengthBytes; i++) length = (length << 8) | buffer[offset + 2 + i];
  return 2 + lengthBytes + length;
}

function tryDecodeReplyCapabilities(body, offset) {
  if (body.length < offset + 12) {
    return {
      numCommonCaps: 0,
      numChannelCaps: 0,
      capsOffset: 0,
      commonCaps: { words: [], bits: [] },
      channelCaps: { words: [], bits: [] },
      opaqueTail: body.subarray(offset),
    };
  }
  const numCommonCaps = body.readUInt32LE(offset);
  const numChannelCaps = body.readUInt32LE(offset + 4);
  const capsOffset = body.readUInt32LE(offset + 8);
  const wordsLength = (numCommonCaps + numChannelCaps) * 4;
  if (capsOffset >= body.length || body.length < capsOffset + wordsLength) {
    return {
      numCommonCaps: 0,
      numChannelCaps: 0,
      capsOffset,
      commonCaps: { words: [], bits: [] },
      channelCaps: { words: [], bits: [] },
      opaqueTail: body.subarray(offset),
    };
  }
  return {
    numCommonCaps,
    numChannelCaps,
    capsOffset,
    commonCaps: decodeCapabilityWords(body, numCommonCaps, capsOffset),
    channelCaps: decodeCapabilityWords(body, numChannelCaps, capsOffset + numCommonCaps * 4),
    opaqueTail: body.subarray(offset, capsOffset),
  };
}

function decodeSpiceLinkReply(input) {
  const buffer = Buffer.from(input);
  const link = decodeSpiceLinkHeader(buffer);
  const total = SPICE_LINK_HEADER_SIZE + link.size;
  if (buffer.length < total) throw new Error(`SPICE link reply incomplete: need ${total}, got ${buffer.length}`);
  const body = buffer.subarray(SPICE_LINK_HEADER_SIZE, total);
  if (body.length < 4 + SPICE_TICKET_PUBKEY_BYTES) throw new Error('SPICE link reply body is too short');
  const error = body.readUInt32LE(0);
  let pubkeyLength = SPICE_TICKET_PUBKEY_BYTES;
  if (body[4] === 0x30) {
    const derLength = readDerObjectLength(body, 4);
    if (derLength <= body.length - 4) pubkeyLength = derLength;
  }
  const pubkey = body.subarray(4, 4 + pubkeyLength);
  const capabilityOffset = pubkeyLength === SPICE_TICKET_PUBKEY_BYTES ? 166 : 4 + pubkeyLength;
  const caps = tryDecodeReplyCapabilities(body, capabilityOffset);
  return {
    header: link,
    ok: error === SPICE_LINK_ERR_OK,
    error,
    pubkey,
    pubkeyLength,
    numCommonCaps: caps.numCommonCaps,
    numChannelCaps: caps.numChannelCaps,
    capsOffset: caps.capsOffset,
    commonCaps: caps.commonCaps,
    channelCaps: caps.channelCaps,
    opaqueTail: caps.opaqueTail,
    rest: buffer.subarray(total),
  };
}

function decodeSpiceAuthResult(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 4) throw new Error('SPICE auth result requires 4 bytes');
  const code = buffer.readUInt32LE(0);
  return {
    ok: code === SPICE_LINK_ERR_OK,
    code,
    rest: buffer.subarray(4),
  };
}

function encodeMiniHeader(type, size) {
  assertUInt16(type, 'type');
  assertUInt32(size, 'size');
  const out = Buffer.alloc(MINI_HEADER_SIZE);
  out.writeUInt16LE(type, 0);
  out.writeUInt32LE(size, 2);
  return out;
}

function decodeMiniHeader(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < MINI_HEADER_SIZE) {
    throw new Error(`SPICE mini header requires ${MINI_HEADER_SIZE} bytes`);
  }
  return {
    type: buffer.readUInt16LE(0),
    size: buffer.readUInt32LE(2),
  };
}

function encodeMiniMessage(type, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  return Buffer.concat([encodeMiniHeader(type, body.length), body]);
}

function decodeMiniMessage(input) {
  const buffer = Buffer.from(input);
  const header = decodeMiniHeader(buffer);
  const total = MINI_HEADER_SIZE + header.size;
  if (buffer.length < total) {
    throw new Error(`SPICE mini message incomplete: need ${total}, got ${buffer.length}`);
  }
  return {
    header,
    payload: buffer.subarray(MINI_HEADER_SIZE, total),
    rest: buffer.subarray(total),
  };
}

function encodeDataHeader(type, size, opts = {}) {
  assertUInt16(type, 'type');
  assertUInt32(size, 'size');
  const serial = typeof opts.serial === 'bigint' ? opts.serial : BigInt(opts.serial ?? 0);
  if (serial < 0n || serial > 0xffffffffffffffffn) throw new Error('serial must be uint64');
  const subList = opts.subList ?? 0;
  assertUInt32(subList, 'subList');
  const out = Buffer.alloc(DATA_HEADER_SIZE);
  out.writeBigUInt64LE(serial, 0);
  out.writeUInt16LE(type, 8);
  out.writeUInt32LE(size, 10);
  out.writeUInt32LE(subList, 14);
  return out;
}

function decodeDataHeader(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < DATA_HEADER_SIZE) {
    throw new Error(`SPICE data header requires ${DATA_HEADER_SIZE} bytes`);
  }
  return {
    serial: buffer.readBigUInt64LE(0),
    type: buffer.readUInt16LE(8),
    size: buffer.readUInt32LE(10),
    subList: buffer.readUInt32LE(14),
  };
}

function encodeDataMessage(type, payload = Buffer.alloc(0), opts = {}) {
  const body = Buffer.from(payload);
  return Buffer.concat([encodeDataHeader(type, body.length, opts), body]);
}

function decodeDataMessage(input) {
  const buffer = Buffer.from(input);
  const header = decodeDataHeader(buffer);
  const total = DATA_HEADER_SIZE + header.size;
  if (buffer.length < total) {
    throw new Error(`SPICE data message incomplete: need ${total}, got ${buffer.length}`);
  }
  return {
    header,
    payload: buffer.subarray(DATA_HEADER_SIZE, total),
    rest: buffer.subarray(total),
  };
}

function encodeDisplayInit(opts = {}) {
  const pixmapCacheId = opts.pixmapCacheId ?? 1;
  const pixmapCacheSize = opts.pixmapCacheSize ?? 20 * 1024 * 1024;
  const glzDictionaryId = opts.glzDictionaryId ?? 1;
  const glzDictionaryWindowSize = opts.glzDictionaryWindowSize ?? 8 * 1024 * 1024;

  if (!Number.isInteger(pixmapCacheId) || pixmapCacheId < 0 || pixmapCacheId > 0xff) {
    throw new Error('pixmapCacheId must be uint8');
  }
  if (!Number.isSafeInteger(pixmapCacheSize) || pixmapCacheSize < 0) {
    throw new Error('pixmapCacheSize must be non-negative integer');
  }
  if (!Number.isInteger(glzDictionaryId) || glzDictionaryId < 0 || glzDictionaryId > 0xff) {
    throw new Error('glzDictionaryId must be uint8');
  }
  assertUInt32(glzDictionaryWindowSize, 'glzDictionaryWindowSize');

  const payload = Buffer.alloc(14);
  payload.writeUInt8(pixmapCacheId, 0);
  payload.writeBigInt64LE(BigInt(pixmapCacheSize), 1);
  payload.writeUInt8(glzDictionaryId, 9);
  payload.writeUInt32LE(glzDictionaryWindowSize, 10);
  return encodeMiniMessage(SpiceMessage.DISPLAY_INIT, payload);
}

function decodeSetAckPayload(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 8) throw new Error('SET_ACK payload requires 8 bytes');
  return {
    generation: buffer.readUInt32LE(0),
    window: buffer.readUInt32LE(4),
  };
}

function encodeAckSync(generation) {
  assertUInt32(generation, 'generation');
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(generation, 0);
  return encodeMiniMessage(SpiceMessage.ACK_SYNC, payload);
}

function encodeAck() {
  return encodeMiniMessage(SpiceMessage.ACK);
}

function encodePong(pingPayload = Buffer.alloc(0)) {
  return encodeMiniMessage(SpiceMessage.PONG, Buffer.from(pingPayload));
}

function isSurfaceSignal(type) {
  return type === SpiceMessage.SURFACE_CREATE ||
    type === SpiceMessage.DRAW_COPY ||
    type === SpiceMessage.MARK;
}

module.exports = {
  SPICE_MAGIC,
  SPICE_LINK_HEADER_SIZE,
  SPICE_LINK_MESS_BASE_SIZE,
  SPICE_LINK_REPLY_BASE_SIZE,
  SPICE_TICKET_PUBKEY_BYTES,
  MINI_HEADER_SIZE,
  DATA_HEADER_SIZE,
  SpiceChannel,
  SpiceMessage,
  SpiceCommonCapability,
  encodeCapabilityWords,
  decodeCapabilityWords,
  encodeSpiceLinkHeader,
  decodeSpiceLinkHeader,
  encodeSpiceLinkMess,
  decodeSpiceLinkMess,
  readDerObjectLength,
  decodeSpiceLinkReply,
  decodeSpiceAuthResult,
  encodeMiniHeader,
  decodeMiniHeader,
  encodeMiniMessage,
  decodeMiniMessage,
  encodeDataHeader,
  decodeDataHeader,
  encodeDataMessage,
  decodeDataMessage,
  encodeDisplayInit,
  decodeSetAckPayload,
  encodeAckSync,
  encodeAck,
  encodePong,
  isSurfaceSignal,
};
