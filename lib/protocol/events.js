'use strict';

const ProtocolStage = Object.freeze({
  SCG_AUTH_OK: 'scg_auth_ok',
  TLS_OK: 'tls_ok',
  MAIN_CHANNEL_OK: 'main_channel_ok',
  DISPLAY_CHANNEL_OK: 'display_channel_ok',
  DISPLAY_INIT_SENT: 'display_init_sent',
  SET_ACK_RECEIVED: 'set_ack_received',
  ACK_SYNC_SENT: 'ack_sync_sent',
  PING_RECEIVED: 'ping_received',
  PONG_SENT: 'pong_sent',
  SURFACE_CREATE_RECEIVED: 'surface_create_received',
  DRAW_COPY_RECEIVED: 'draw_copy_received',
  MARK_RECEIVED: 'mark_received',
});

function createProtocolProgress() {
  return {
    scgAuthOk: false,
    tlsOk: false,
    mainChannelOk: false,
    displayChannelOk: false,
    displayInitSent: false,
    setAckReceived: false,
    ackSyncSent: false,
    pingReceived: false,
    pongSent: false,
    surfaceCreateReceived: false,
    drawCopyReceived: false,
    markReceived: false,
  };
}

function applyProtocolEvent(progress, event) {
  const next = { ...progress };
  switch (event) {
    case ProtocolStage.SCG_AUTH_OK:
      next.scgAuthOk = true;
      break;
    case ProtocolStage.TLS_OK:
      next.tlsOk = true;
      break;
    case ProtocolStage.MAIN_CHANNEL_OK:
      next.mainChannelOk = true;
      break;
    case ProtocolStage.DISPLAY_CHANNEL_OK:
      next.displayChannelOk = true;
      break;
    case ProtocolStage.DISPLAY_INIT_SENT:
      next.displayInitSent = true;
      break;
    case ProtocolStage.SET_ACK_RECEIVED:
      next.setAckReceived = true;
      break;
    case ProtocolStage.ACK_SYNC_SENT:
      next.ackSyncSent = true;
      break;
    case ProtocolStage.PING_RECEIVED:
      next.pingReceived = true;
      break;
    case ProtocolStage.PONG_SENT:
      next.pongSent = true;
      break;
    case ProtocolStage.SURFACE_CREATE_RECEIVED:
      next.surfaceCreateReceived = true;
      break;
    case ProtocolStage.DRAW_COPY_RECEIVED:
      next.drawCopyReceived = true;
      break;
    case ProtocolStage.MARK_RECEIVED:
      next.markReceived = true;
      break;
    default:
      throw new Error(`unknown protocol event: ${event}`);
  }
  return next;
}

function isProtocolKeepaliveSuccess(progress) {
  const surface = Boolean(progress.surfaceCreateReceived);
  const draw = Boolean(progress.drawCopyReceived);
  const mark = Boolean(progress.markReceived);
  return Boolean(progress.displayInitSent && (
    (surface && draw) ||
    (surface && mark) ||
    (draw && mark)
  ));
}

module.exports = {
  ProtocolStage,
  createProtocolProgress,
  applyProtocolEvent,
  isProtocolKeepaliveSuccess,
};
