// Guard identitas sesi/request untuk membuang jawaban/retry lama yang datang telat.

export function getRequestIdentity(source = {}) {
  const payload = source.payload && typeof source.payload === 'object' ? source.payload : null;
  return {
    sessionId: source.sessionId ?? payload?.sessionId ?? null,
    requestId: source.requestId ?? payload?.requestId ?? null,
  };
}

export function isCurrentRequest(state = {}, source = {}) {
  const { sessionId, requestId } = getRequestIdentity(source);
  return state.isBatching === true &&
    !!state.sessionId && !!state.activeRequestId &&
    state.sessionId === sessionId &&
    state.activeRequestId === requestId;
}

export function requestKey(source = {}) {
  const { sessionId, requestId } = getRequestIdentity(source);
  return sessionId && requestId ? `${sessionId}:${requestId}` : '';
}
