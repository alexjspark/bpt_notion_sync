const allowedHeaders = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'];
/** Internal fixed-host upgrade only. Never forward credentials or arbitrary request targets. */
export function companyCdpUpgradeRequest(path, headers) {
  if (!/^\/devtools\/(browser|page)\/[a-zA-Z0-9-]+$/.test(path)) throw new Error('COMPANY_CDP_TARGET_INVALID');
  const lines = allowedHeaders.flatMap(name => {
    const value = headers[name];
    if (typeof value !== 'string') return [];
    if (/[\r\n]/.test(value)) throw new Error('COMPANY_CDP_HEADER_INVALID');
    return [name + ': ' + value];
  });
  return ['GET ' + path + ' HTTP/1.1', 'Host: 127.0.0.1:9223', ...lines, '', ''].join('\r\n');
}
