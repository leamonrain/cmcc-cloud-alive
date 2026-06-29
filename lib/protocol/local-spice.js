'use strict';

const {
  decodeDataMessage,
  decodeSpiceAuthResult,
  decodeSpiceLinkMess,
  decodeSpiceLinkReply,
} = require('./spice');

const LOCAL_SPICE_EXT_INFO_SIZE = 164;
const LOCAL_SPICE_PRIMARY_ID_OFFSET = 0x6c;
const LOCAL_SPICE_PRIMARY_ID_SIZE = 0x20;
const LOCAL_SPICE_SECONDARY_ID_OFFSET = 0x8d;
const LOCAL_SPICE_SECONDARY_ID_SIZE = 0x10;
const LOCAL_SPICE_CLIENT_FRAME_HEADER_SIZE = 4;

function readAsciiField(buffer, offset, size) {
  const raw = buffer.subarray(offset, offset + size);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('ascii');
}

function decodeLocalSpiceExtInfo(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < LOCAL_SPICE_EXT_INFO_SIZE) {
    throw new Error(`local SPICE ExtInfo requires ${LOCAL_SPICE_EXT_INFO_SIZE} bytes`);
  }
  return {
    raw: buffer.subarray(0, LOCAL_SPICE_EXT_INFO_SIZE),
    field00: buffer.readUInt16LE(0x00),
    field02: buffer.readUInt16LE(0x02),
    localPortHint: buffer.readUInt16LE(0x04),
    channelClass: buffer.readUInt16LE(0x06),
    field08: buffer.readUInt16LE(0x08),
    field0a: buffer.readUInt16LE(0x0a),
    primaryId: readAsciiField(buffer, LOCAL_SPICE_PRIMARY_ID_OFFSET, LOCAL_SPICE_PRIMARY_ID_SIZE),
    secondaryId: readAsciiField(buffer, LOCAL_SPICE_SECONDARY_ID_OFFSET, LOCAL_SPICE_SECONDARY_ID_SIZE),
    field9eBe: buffer.readUInt16BE(0x9e),
    fielda0Be: buffer.readUInt16BE(0xa0),
    fielda2Le: buffer.readUInt16LE(0xa2),
  };
}

function decodeLocalSpiceClientHandshake(input) {
  const buffer = Buffer.from(input);
  const extInfo = decodeLocalSpiceExtInfo(buffer);
  const redqOffset = buffer.indexOf(Buffer.from('REDQ', 'ascii'), LOCAL_SPICE_EXT_INFO_SIZE);
  if (redqOffset !== LOCAL_SPICE_EXT_INFO_SIZE) {
    throw new Error(`local SPICE client REDQ expected at ${LOCAL_SPICE_EXT_INFO_SIZE}, got ${redqOffset}`);
  }
  const link = decodeSpiceLinkMess(buffer.subarray(redqOffset));
  return {
    extInfo,
    redqOffset,
    link,
    rest: link.rest,
  };
}

function decodeLocalSpiceServerHandshake(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 2) throw new Error('local SPICE server handshake is too short');
  const channelPrefix = buffer.readUInt8(0);
  const redqOffset = buffer.indexOf(Buffer.from('REDQ', 'ascii'));
  if (redqOffset !== 1) {
    throw new Error(`local SPICE server REDQ expected at 1, got ${redqOffset}`);
  }
  const reply = decodeSpiceLinkReply(buffer.subarray(redqOffset));
  return {
    channelPrefix,
    redqOffset,
    reply,
    rest: reply.rest,
  };
}

function decodeLocalSpiceServerDataMessages(input, opts = {}) {
  const buffer = Buffer.from(input);
  const includeAuthResult = opts.includeAuthResult !== false;
  const maxMessages = opts.maxMessages ?? 128;
  const messages = [];
  let cursor = buffer;
  let offset = 0;
  let authResult = null;

  if (includeAuthResult) {
    authResult = decodeSpiceAuthResult(cursor);
    cursor = authResult.rest;
    offset += 4;
  }

  while (cursor.length >= 18 && messages.length < maxMessages) {
    let msg;
    try {
      msg = decodeDataMessage(cursor);
    } catch (err) {
      return {
        authResult,
        messages,
        rest: cursor,
        error: err,
        errorOffset: offset,
      };
    }
    const messageLength = 18 + msg.header.size;
    let paddingLength = 0;
    if (msg.rest.length > 0 && msg.rest[0] === 0x00) {
      paddingLength = 1;
    }
    messages.push({
      offset,
      header: msg.header,
      payload: msg.payload,
      paddingLength,
    });
    cursor = msg.rest.subarray(paddingLength);
    offset += messageLength + paddingLength;
  }

  return {
    authResult,
    messages,
    rest: cursor,
    error: null,
    errorOffset: null,
  };
}

function decodeLocalSpiceClientFrames(input, opts = {}) {
  const buffer = Buffer.from(input);
  const maxFrames = opts.maxFrames ?? 128;
  const frames = [];
  let offset = 0;

  while (offset + LOCAL_SPICE_CLIENT_FRAME_HEADER_SIZE <= buffer.length && frames.length < maxFrames) {
    const marker = buffer.readUInt8(offset);
    if (marker !== 0x0a) {
      return {
        frames,
        rest: buffer.subarray(offset),
        error: new Error(`local SPICE client frame marker must be 0x0a, got 0x${marker.toString(16)}`),
        errorOffset: offset,
      };
    }
    const channelPrefix = buffer.readUInt8(offset + 1);
    const payloadLength = buffer.readUInt16LE(offset + 2);
    const payloadOffset = offset + LOCAL_SPICE_CLIENT_FRAME_HEADER_SIZE;
    const nextOffset = payloadOffset + payloadLength;
    if (nextOffset > buffer.length) {
      return {
        frames,
        rest: buffer.subarray(offset),
        error: new Error(`local SPICE client frame incomplete: need ${nextOffset}, got ${buffer.length}`),
        errorOffset: offset,
      };
    }
    frames.push({
      offset,
      channelPrefix,
      payloadLength,
      payload: buffer.subarray(payloadOffset, nextOffset),
    });
    offset = nextOffset;
  }

  return {
    frames,
    rest: buffer.subarray(offset),
    error: null,
    errorOffset: null,
  };
}

function decodeLocalSpiceClientDataMessages(input, opts = {}) {
  const decoded = decodeLocalSpiceClientFrames(input, opts);
  const messages = [];
  let authFrame = null;
  for (const frame of decoded.frames) {
    if (!authFrame && frame.payloadLength === 128) {
      authFrame = frame;
      continue;
    }
    let msg;
    try {
      msg = decodeDataMessage(frame.payload);
    } catch (err) {
      return {
        authFrame,
        messages,
        frames: decoded.frames,
        rest: decoded.rest,
        error: err,
        errorOffset: frame.offset,
      };
    }
    const messageLength = 18 + msg.header.size;
    const trailer = frame.payload.subarray(messageLength);
    messages.push({
      frameOffset: frame.offset,
      channelPrefix: frame.channelPrefix,
      header: msg.header,
      payload: msg.payload,
      trailer,
    });
  }
  return {
    authFrame,
    messages,
    frames: decoded.frames,
    rest: decoded.rest,
    error: decoded.error,
    errorOffset: decoded.errorOffset,
  };
}

module.exports = {
  LOCAL_SPICE_EXT_INFO_SIZE,
  LOCAL_SPICE_PRIMARY_ID_OFFSET,
  LOCAL_SPICE_PRIMARY_ID_SIZE,
  LOCAL_SPICE_SECONDARY_ID_OFFSET,
  LOCAL_SPICE_SECONDARY_ID_SIZE,
  LOCAL_SPICE_CLIENT_FRAME_HEADER_SIZE,
  decodeLocalSpiceExtInfo,
  decodeLocalSpiceClientHandshake,
  decodeLocalSpiceServerHandshake,
  decodeLocalSpiceServerDataMessages,
  decodeLocalSpiceClientFrames,
  decodeLocalSpiceClientDataMessages,
};
