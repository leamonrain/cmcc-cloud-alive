#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  deriveZteCagTunnelMeta,
  parseZteCagDatagram,
  summarizeZteCagTunnelDatagrams,
  summarizeZteCagTunnelSequences,
} = require('../lib/protocol');

function usage() {
  console.error('Usage: node scripts/analyze-cag-transport.js <cag.pcap> [--limit 120] [--from SEC.USEC] [--to SEC.USEC]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [], limit: 120, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') {
      out.limit = Number(argv[++i] || 0);
    } else if (arg === '--from') {
      out.from = Number(argv[++i] || 0);
    } else if (arg === '--to') {
      out.to = Number(argv[++i] || 0);
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function packetTimeNumber(packet) {
  return Number(`${packet.seconds}.${String(packet.micros).padStart(6, '0')}`);
}

function inTimeWindow(packet, args) {
  const time = packetTimeNumber(packet);
  if (args.from !== null && time < args.from) return false;
  if (args.to !== null && time > args.to) return false;
  return true;
}

function parseClassicEthernetPcap(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24) throw new Error('pcap file is too short');
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0xa1b2c3d4 && magic !== 0xd4c3b2a1) {
    throw new Error('only classic little-endian Ethernet pcap files are supported');
  }

  let offset = 24;
  const packets = [];
  while (offset + 16 <= buffer.length) {
    const seconds = buffer.readUInt32LE(offset);
    const micros = buffer.readUInt32LE(offset + 4);
    const capturedLength = buffer.readUInt32LE(offset + 8);
    const packetOffset = offset + 16;
    offset = packetOffset + capturedLength;
    if (capturedLength < 34) continue;
    if (buffer.readUInt16BE(packetOffset + 12) !== 0x0800) continue;

    const ipOffset = packetOffset + 14;
    const ipHeaderLength = (buffer[ipOffset] & 0x0f) * 4;
    const protocol = buffer[ipOffset + 9];
    const ipTotalLength = buffer.readUInt16BE(ipOffset + 2);
    const sourceIp = [...buffer.subarray(ipOffset + 12, ipOffset + 16)].join('.');
    const destinationIp = [...buffer.subarray(ipOffset + 16, ipOffset + 20)].join('.');
    const l4Offset = ipOffset + ipHeaderLength;

    if (protocol === 6) {
      const tcpHeaderLength = (buffer[l4Offset + 12] >> 4) * 4;
      const payloadLength = ipTotalLength - ipHeaderLength - tcpHeaderLength;
      packets.push({
        seconds,
        micros,
        protocol: 'tcp',
        sourceIp,
        destinationIp,
        sourcePort: buffer.readUInt16BE(l4Offset),
        destinationPort: buffer.readUInt16BE(l4Offset + 2),
        sequence: buffer.readUInt32BE(l4Offset + 4),
        flags: buffer[l4Offset + 13],
        payload: payloadLength > 0
          ? buffer.subarray(l4Offset + tcpHeaderLength, l4Offset + tcpHeaderLength + payloadLength)
          : Buffer.alloc(0),
      });
    } else if (protocol === 17) {
      const udpLength = buffer.readUInt16BE(l4Offset + 4);
      packets.push({
        seconds,
        micros,
        protocol: 'udp',
        sourceIp,
        destinationIp,
        sourcePort: buffer.readUInt16BE(l4Offset),
        destinationPort: buffer.readUInt16BE(l4Offset + 2),
        payload: buffer.subarray(l4Offset + 8, l4Offset + udpLength),
      });
    }
  }
  return packets;
}

function direction(packet, remoteHost = '') {
  if (remoteHost && packet.destinationIp === remoteHost) return 'client->cag';
  if (remoteHost && packet.sourceIp === remoteHost) return 'cag->client';
  return `${packet.sourceIp}:${packet.sourcePort}->${packet.destinationIp}:${packet.destinationPort}`;
}

function firstRemoteHost(packets) {
  const counts = new Map();
  for (const packet of packets) {
    if (packet.sourceIp.startsWith('127.') || packet.destinationIp.startsWith('127.')) continue;
    for (const ip of [packet.sourceIp, packet.destinationIp]) {
      if (/^(10|172\.16|172\.17|172\.18|172\.19|172\.2\d|172\.3[01]|192\.168)\./.test(ip)) continue;
      counts.set(ip, (counts.get(ip) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function describePacket(packet, remoteHost) {
  const dir = direction(packet, remoteHost);
  const base = {
    time: `${packet.seconds}.${String(packet.micros).padStart(6, '0')}`,
    dir,
    protocol: packet.protocol,
    source: `${packet.sourceIp}:${packet.sourcePort}`,
    destination: `${packet.destinationIp}:${packet.destinationPort}`,
    length: packet.payload.length,
  };
  if (!packet.payload.length) return base;
  if (packet.protocol === 'tcp') {
    return {
      ...base,
      tcpFlags: `0x${packet.flags.toString(16)}`,
      sequence: packet.sequence,
      first: packet.payload.subarray(0, 12).toString('hex'),
    };
  }

  const parsed = parseZteCagDatagram(packet.payload);
  const out = {
    ...base,
    first: packet.payload.subarray(0, 12).toString('hex'),
    hasZtec: parsed.hasZtec,
    hasTlsRecord: parsed.hasTlsRecord,
  };
  if (parsed.udpControl) {
    out.udpControl = {
      type: parsed.udpControl.header.type,
      typeName: parsed.udpControl.header.typeName,
      sequence: parsed.udpControl.header.sequence,
      tunnelId: parsed.udpControl.header.tunnelId,
      dynamicTunnelWord0: parsed.udpControl.dynamicTunnelWord0,
      payloadLength: parsed.udpControl.payload.length,
    };
  }
  if (parsed.ztecPacket) {
    out.ztec = {
      bodyLength: parsed.ztecPacket.head.bodyLength,
      keyFirstWord: parsed.ztecKeyInfo?.firstWord ?? parsed.ztecOpentelemetryKeyInfo?.firstWord,
      randomKey: parsed.ztecKeyInfo?.key ?? parsed.ztecOpentelemetryKeyInfo?.key,
      connectInfoLength: parsed.ztecKeyInfo?.connectInfoLength ?? parsed.ztecOpentelemetryKeyInfo?.connectInfoLength,
      traceId: parsed.ztecOpentelemetryKeyInfo?.traceId,
      serverKey: parsed.ztecServerKeyInfo?.key,
      serverKeyFlags: parsed.ztecServerKeyInfo?.flags,
      sdkAesFlags: parsed.ztecServerKeyInfo?.sdkAesFlags,
    };
  }
  if (parsed.connectReply) {
    out.connectReply = {
      ok: parsed.connectReply.ok,
      code: parsed.connectReply.code,
    };
  }
  if (parsed.tunnel) {
    out.tunnel = {
      meta: deriveZteCagTunnelMeta(parsed.tunnel),
      type: parsed.tunnel.header.packetTypeName,
      packetType: parsed.tunnel.header.packetType,
      flagByte: parsed.tunnel.header.flagByte,
      sequence16: parsed.tunnel.header.sequence16,
      word4: parsed.tunnel.header.word4,
      word5: parsed.tunnel.header.word5,
      payloadLength: parsed.tunnel.payloadLength,
      hasTlsRecord: parsed.tunnel.hasTlsRecord,
      tlsRecordOffset: parsed.tunnel.tlsRecordOffset,
      payloadLengthMatchesWord4: parsed.tunnel.payloadLengthMatchesWord4,
    };
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) usage();

  const packets = parseClassicEthernetPcap(file);
  const visiblePackets = packets.filter((packet) => inTimeWindow(packet, args));
  const remoteHost = firstRemoteHost(packets);
  const udpEvents = visiblePackets
    .filter((packet) => packet.protocol === 'udp' && packet.payload.length > 0)
    .map((packet) => ({ packet, parsed: parseZteCagDatagram(packet.payload) }));
  const tunnelItems = udpEvents
    .filter((event) => event.parsed.tunnel)
    .map((event) => ({
      direction: direction(event.packet, remoteHost),
      tunnel: event.parsed.tunnel,
    }));

  const counts = {};
  for (const packet of visiblePackets) {
    const key = `${packet.protocol}:${direction(packet, remoteHost)}:${packet.payload.length > 0 ? 'payload' : 'empty'}`;
    counts[key] = (counts[key] || 0) + 1;
  }

  console.log(`pcap=${file}`);
  console.log(`packets=${packets.length}`);
  console.log(`visiblePackets=${visiblePackets.length}`);
  if (args.from !== null || args.to !== null) {
    console.log(`timeWindow=${args.from ?? '-'}..${args.to ?? '-'}`);
  }
  console.log(`remoteHost=${remoteHost || '-'}`);
  console.log(`counts=${JSON.stringify(counts)}`);
  console.log(`tunnelSummary=${JSON.stringify(summarizeZteCagTunnelDatagrams(tunnelItems))}`);
  console.log(`tunnelSequences=${JSON.stringify(summarizeZteCagTunnelSequences(tunnelItems))}`);

  const interesting = visiblePackets
    .filter((packet) => packet.payload.length > 0)
    .map((packet) => describePacket(packet, remoteHost));
  for (const event of interesting.slice(0, args.limit)) {
    console.log(JSON.stringify(event));
  }
}

main();
