#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  decodeLocalSpiceClientHandshake,
  decodeLocalSpiceClientDataMessages,
  decodeLocalSpiceServerDataMessages,
  decodeLocalSpiceServerHandshake,
} = require('../lib/protocol');

const KNOWN_MINI_TYPES = new Map([
  [0x0003, 'SET_ACK'],
  [0x0004, 'PING'],
  [0x0005, 'PONG'],
  [0x0006, 'ACK_SYNC'],
  [0x0007, 'ACK'],
  [0x0065, 'DISPLAY_INIT'],
  [0x0066, 'MARK'],
  [0x0067, 'MAIN_INIT'],
  [0x0068, 'CHANNELS_LIST'],
  [0x0130, 'DRAW_COPY'],
  [0x013a, 'SURFACE_CREATE'],
]);

function usage() {
  console.error('Usage: node scripts/analyze-loopback-spice.js <loopback.pcap>');
  process.exit(2);
}

function parsePcapTcpPayloads(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24) throw new Error('pcap file is too short');
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0xa1b2c3d4 && magic !== 0xd4c3b2a1) {
    throw new Error('only classic little-endian pcap files are supported');
  }

  let offset = 24;
  const packets = [];
  while (offset + 16 <= buffer.length) {
    const seconds = buffer.readUInt32LE(offset);
    const micros = buffer.readUInt32LE(offset + 4);
    const capturedLength = buffer.readUInt32LE(offset + 8);
    const packetOffset = offset + 16;
    offset = packetOffset + capturedLength;
    if (capturedLength < 54) continue;
    if (buffer.readUInt16BE(packetOffset + 12) !== 0x0800) continue;

    const ipOffset = packetOffset + 14;
    const ipHeaderLength = (buffer[ipOffset] & 0x0f) * 4;
    if (buffer[ipOffset + 9] !== 6) continue;

    const tcpOffset = ipOffset + ipHeaderLength;
    const sourcePort = buffer.readUInt16BE(tcpOffset);
    const destinationPort = buffer.readUInt16BE(tcpOffset + 2);
    const sequence = buffer.readUInt32BE(tcpOffset + 4);
    const tcpHeaderLength = (buffer[tcpOffset + 12] >> 4) * 4;
    const ipTotalLength = buffer.readUInt16BE(ipOffset + 2);
    const payloadLength = ipTotalLength - ipHeaderLength - tcpHeaderLength;
    if (payloadLength <= 0) continue;

    packets.push({
      seconds,
      micros,
      sourcePort,
      destinationPort,
      sequence,
      payload: buffer.subarray(tcpOffset + tcpHeaderLength, tcpOffset + tcpHeaderLength + payloadLength),
    });
  }
  return packets;
}

function reconstructDirectionalStreams(packets) {
  const groups = new Map();
  for (const packet of packets) {
    const key = `${packet.sourcePort}->${packet.destinationPort}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(packet);
  }

  const streams = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => (a.sequence - b.sequence) || (a.seconds - b.seconds) || (a.micros - b.micros));
    const chunks = [];
    const ranges = [];
    let cursor = null;
    let assembledOffset = 0;
    for (const packet of group) {
      if (cursor === null) cursor = packet.sequence;
      const packetEnd = packet.sequence + packet.payload.length;
      if (packetEnd <= cursor) continue;
      if (packet.sequence > cursor) {
        const gapLength = packet.sequence - cursor;
        chunks.push(Buffer.alloc(gapLength));
        assembledOffset += gapLength;
        cursor = packet.sequence;
      }
      const trim = Math.max(0, cursor - packet.sequence);
      const payload = packet.payload.subarray(trim);
      chunks.push(payload);
      ranges.push({
        start: assembledOffset,
        end: assembledOffset + payload.length,
        seconds: packet.seconds,
        micros: packet.micros,
        sequence: packet.sequence + trim,
      });
      assembledOffset += payload.length;
      cursor += payload.length;
    }
    streams.push({
      key,
      packetCount: group.length,
      data: Buffer.concat(chunks),
      ranges,
    });
  }
  return streams;
}

function formatPcapTime(range) {
  if (!range) return null;
  return `${range.seconds}.${String(range.micros).padStart(6, '0')}`;
}

function streamTimeAtOffset(stream, offset) {
  for (const range of stream.ranges || []) {
    if (offset >= range.start && offset < range.end) return range;
  }
  return null;
}

function findAll(buffer, needle) {
  const out = [];
  let offset = -1;
  while ((offset = buffer.indexOf(needle, offset + 1)) !== -1) out.push(offset);
  return out;
}

function scanMiniMessages(buffer) {
  const out = [];
  for (let offset = 0; offset <= buffer.length - 6; offset++) {
    const type = buffer.readUInt16LE(offset);
    const size = buffer.readUInt32LE(offset + 2);
    if (!KNOWN_MINI_TYPES.has(type)) continue;
    if (size > 1024 * 1024) continue;
    if (offset + 6 + size > buffer.length) continue;
    out.push({
      offset,
      type,
      name: KNOWN_MINI_TYPES.get(type),
      size,
    });
  }
  return out;
}

function messageName(type) {
  return KNOWN_MINI_TYPES.get(type) || `0x${type.toString(16)}`;
}

function parseStreamKey(key) {
  const [sourcePort, destinationPort] = key.split('->').map((value) => Number(value));
  return { sourcePort, destinationPort };
}

function decodeServerDataMessages(rest) {
  const decoded = decodeLocalSpiceServerDataMessages(rest, { maxMessages: 48 });
  const out = decoded.authResult ? [{
    offset: 0,
    authResult: decoded.authResult.code,
    ok: decoded.authResult.ok,
  }] : [];
  for (const msg of decoded.messages) {
    out.push({
      offset: msg.offset,
      type: msg.header.type,
      name: messageName(msg.header.type),
      size: msg.header.size,
      serial: msg.header.serial.toString(),
      subList: msg.header.subList,
      paddingLength: msg.paddingLength,
    });
  }
  if (decoded.error) {
    out.push({
      offset: decoded.errorOffset,
      parseError: decoded.error.message,
    });
  }
  return out;
}

function decodeClientDataMessages(rest) {
  const decoded = decodeLocalSpiceClientDataMessages(rest, { maxFrames: 48 });
  const out = [];
  if (decoded.authFrame) {
    out.push({
      offset: decoded.authFrame.offset,
      authFrame: true,
      channelPrefix: decoded.authFrame.channelPrefix,
      payloadLength: decoded.authFrame.payloadLength,
    });
  }
  for (const msg of decoded.messages) {
    out.push({
      offset: msg.frameOffset,
      channelPrefix: msg.channelPrefix,
      type: msg.header.type,
      name: messageName(msg.header.type),
      size: msg.header.size,
      serial: msg.header.serial.toString(),
      subList: msg.header.subList,
      trailer: msg.trailer,
    });
  }
  if (decoded.error) {
    out.push({
      offset: decoded.errorOffset,
      parseError: decoded.error.message,
    });
  }
  return out;
}

function main() {
  const file = process.argv[2];
  if (!file) usage();

  const packets = parsePcapTcpPayloads(file);
  const streams = reconstructDirectionalStreams(packets)
    .map((stream) => ({
      ...stream,
      redqOffsets: findAll(stream.data, Buffer.from('REDQ', 'ascii')),
      miniMessages: scanMiniMessages(stream.data),
    }))
    .filter((stream) => stream.redqOffsets.length || stream.miniMessages.length)
    .sort((a, b) => b.data.length - a.data.length);

  console.log(`pcap=${file}`);
  console.log(`tcp_payload_packets=${packets.length}`);
  console.log(`candidate_streams=${streams.length}`);
  for (const stream of streams) {
    const first = stream.data.subarray(0, Math.min(24, stream.data.length)).toString('hex');
    const firstTime = formatPcapTime(stream.ranges[0]);
    const lastTime = formatPcapTime(stream.ranges[stream.ranges.length - 1]);
    const messages = stream.miniMessages
      .slice(0, 24)
      .map((msg) => `${msg.offset}:${msg.name}(0x${msg.type.toString(16)},${msg.size})`)
      .join(' ');
    console.log(`${stream.key} bytes=${stream.data.length} packets=${stream.packetCount} firstTime=${firstTime || '-'} lastTime=${lastTime || '-'} first=${first}`);
    console.log(`  REDQ offsets: ${stream.redqOffsets.slice(0, 16).join(',') || '-'}`);
    console.log(`  mini candidates: ${messages || '-'}`);
    if (stream.redqOffsets[0] === 164) {
      try {
        const decoded = decodeLocalSpiceClientHandshake(stream.data);
        const dataMessages = decodeClientDataMessages(decoded.rest)
          .slice(0, 16)
          .map((msg) => msg.authFrame
            ? `${msg.offset}:authFrame(channel=${msg.channelPrefix},len=${msg.payloadLength})`
            : msg.parseError
              ? `${msg.offset}:ERROR(${msg.parseError})`
              : `${msg.offset}:${msg.name}(channel=${msg.channelPrefix},serial=${msg.serial},size=${msg.size},tail=${msg.trailer.toString('hex') || '-'})`)
          .join(' ');
        console.log(`  local client: class=${decoded.extInfo.channelClass} field9e=${decoded.extInfo.field9eBe} fielda0=0x${decoded.extInfo.fielda0Be.toString(16)} linkChannel=${decoded.link.channelType} conn=${decoded.link.connectionId} linkSize=${decoded.link.header.size} rest=${decoded.rest.length}`);
        console.log(`  client data: ${dataMessages || '-'}`);
      } catch (err) {
        console.log(`  local client decode error: ${err.message}`);
      }
    }
    if (stream.redqOffsets[0] === 1) {
      try {
        const decoded = decodeLocalSpiceServerHandshake(stream.data);
        const dataMessages = decodeServerDataMessages(decoded.rest)
          .slice(0, 16)
          .map((msg) => msg.authResult !== undefined
            ? `auth=${msg.authResult}${msg.ok ? '/ok' : ''}`
            : msg.parseError
              ? `${msg.offset}:ERROR(${msg.parseError})`
            : `${msg.offset}:${msg.name}(serial=${msg.serial},size=${msg.size},pad=${msg.paddingLength})`)
          .join(' ');
        console.log(`  local server: prefix=${decoded.channelPrefix} replySize=${decoded.reply.header.size} pubkey=${decoded.reply.pubkeyLength} opaqueTail=${decoded.reply.opaqueTail.length} rest=${decoded.rest.length}`);
        console.log(`  data messages: ${dataMessages || '-'}`);
      } catch (err) {
        console.log(`  local server decode error: ${err.message}`);
      }
    }
  }

  const byKey = new Map(streams.map((stream) => [stream.key, stream]));
  console.log('display_flow_candidates=');
  for (const stream of streams) {
    if (stream.redqOffsets[0] !== 164) continue;
    let client;
    try {
      client = decodeLocalSpiceClientHandshake(stream.data);
    } catch {
      continue;
    }
    if (client.link.channelType !== 2) continue;

    const clientData = decodeLocalSpiceClientDataMessages(client.rest, { maxFrames: 128 });
    const displayInitSent = clientData.messages.some((msg) => msg.header.type === 0x0065);
    const clientRestOffset = stream.data.length - client.rest.length;
    const displayInitEvents = clientData.messages
      .filter((msg) => msg.header.type === 0x0065)
      .map((msg) => ({
        name: messageName(msg.header.type),
        serial: msg.header.serial.toString(),
        offset: clientRestOffset + msg.frameOffset,
        time: formatPcapTime(streamTimeAtOffset(stream, clientRestOffset + msg.frameOffset)),
      }));
    const { sourcePort, destinationPort } = parseStreamKey(stream.key);
    const reverse = byKey.get(`${destinationPort}->${sourcePort}`);
    let setAck = false;
    let surfaceCreate = false;
    let mark = false;
    let serverEvents = [];
    if (reverse) {
      try {
        const server = decodeLocalSpiceServerHandshake(reverse.data);
        const serverData = decodeLocalSpiceServerDataMessages(server.rest, { maxMessages: 128 });
        setAck = serverData.messages.some((msg) => msg.header.type === 0x0003);
        surfaceCreate = serverData.messages.some((msg) => msg.header.type === 0x013a);
        mark = serverData.messages.some((msg) => msg.header.type === 0x0066);
        const serverRestOffset = reverse.data.length - server.rest.length;
        serverEvents = serverData.messages
          .filter((msg) => [0x0003, 0x0130, 0x013a, 0x0066].includes(msg.header.type))
          .slice(0, 16)
          .map((msg) => ({
            name: messageName(msg.header.type),
            serial: msg.header.serial.toString(),
            offset: serverRestOffset + msg.offset,
            time: formatPcapTime(streamTimeAtOffset(reverse, serverRestOffset + msg.offset)),
          }));
      } catch {}
    }
    const ok = displayInitSent && setAck && surfaceCreate && mark;
    console.log(`  ${stream.key} displayInit=${displayInitSent} setAck=${setAck} surfaceCreate=${surfaceCreate} mark=${mark} protocolSuccessEvidence=${ok}`);
    console.log(`    events=${JSON.stringify([...displayInitEvents, ...serverEvents])}`);
  }
}

main();
