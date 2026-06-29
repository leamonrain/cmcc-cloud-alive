'use strict';

function normalizeProtocolConnectInfo(auth = {}) {
  const vmId = auth.vmId || auth.vmID || '';
  const scAuthCode = auth.scAuthCode || auth.vmPassword || '';
  const credentialSource = auth.scAuthCode ? 'scAuthCode' : auth.vmPassword ? 'vmPassword' : '';
  const host = auth.scgIp || auth.cagIp || '';
  const port = Number(auth.scgTcpPort || auth.cagPort || 0);
  if (!vmId) throw new Error('vmId is required');
  if (!scAuthCode) throw new Error('scAuthCode is required');
  if (!host) throw new Error('SCG/CAG host is required');
  if (!Number.isInteger(port) || port <= 0) throw new Error('SCG/CAG port is required');
  return {
    vmId,
    scAuthCode,
    credentialSource,
    bizCode: auth.bizCode || '',
    connectId: auth.connectId || '',
    host,
    port,
    source: auth.scgIp ? 'scg' : 'cag',
    vmcIp: auth.vmcIp || '',
    vmcPort: Number(auth.vmcPort || 0),
    raw: auth,
  };
}

module.exports = {
  normalizeProtocolConnectInfo,
};
