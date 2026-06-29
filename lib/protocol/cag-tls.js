'use strict';

const tls = require('tls');

function probeCagTcpTls(opts = {}) {
  const host = opts.host;
  const port = Number(opts.port);
  if (!host) throw new Error('host is required');
  if (!Number.isInteger(port) || port <= 0) throw new Error('port is required');
  const timeoutMs = Number(opts.timeoutMs || 5000);

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      servername: opts.servername || undefined,
    });
    const timer = setTimeout(() => {
      socket.destroy(new Error(`CAG TCP TLS probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      const result = {
        authorized: socket.authorized,
        authorizationError: socket.authorizationError || '',
        protocol: socket.getProtocol(),
        cipher: socket.getCipher(),
        peerSubject: cert?.subject || {},
        peerIssuer: cert?.issuer || {},
        validFrom: cert?.valid_from || '',
        validTo: cert?.valid_to || '',
        fingerprint256: cert?.fingerprint256 || '',
      };
      socket.end();
      resolve(result);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = {
  probeCagTcpTls,
};
