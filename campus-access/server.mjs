import http from 'node:http';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createGzip} from 'node:zlib';
import {randomUUID} from 'node:crypto';

const sandboxFiles = new Set(['/', '/index.html', '/style.css', '/app.mjs', '/engine.mjs',
  '/route.mjs', '/shared-client.mjs', '/assets/Map.png', '/assets/zju-emblem.png', '/api/simulation']);
const studentFiles = new Set(['/student', '/student/', '/student/app.mjs', '/student/style.css',
  '/student/emblem.png', '/api/student/options', '/api/student/state']);

export function campusAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, items]) => items
    .filter(item => item.family === 'IPv4' && !item.internal && item.address.startsWith('10.'))
    .map(item => ({name, address: item.address, cidr: item.cidr})));
}

export function allowedCampusAddress(address = '') {
  return /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address.replace(/^::ffff:/, ''));
}

export function visitorHtml(html, student = false) {
  if (student) return html.replaceAll('http://127.0.0.1:4173/', '/');
  return html.replaceAll('http://127.0.0.1:4183/student/', '/student/')
    .replace('本地原型 / 12', '师生浏览 / 12')
    .replace(/<input\b(?![^>]*\bdisabled)/g, '<input disabled title="策略由管理员调整"')
    .replace(/<button\b(?![^>]*\bdisabled)(?=[^>]*\bid="(?:play|reset)")/g, '<button disabled title="策略由管理员调整"')
    .replace(/<button\b(?![^>]*\bdisabled)(?=[^>]*\bdata-(?:speed|preset|signal-mode)=)/g, '<button disabled title="策略由管理员调整"')
    .replace('正在连接共享沙盘状态…', '师生浏览模式 · 正在连接共享沙盘状态…');
}

export function createCampusServer({host, port = 4180, sandboxPort = 4173, studentPort = 4183,
  allowAddress = allowedCampusAddress, chatLimit = 60, chatConcurrency = 32} = {}) {
  if (!host) throw new Error('需要指定校园网 IPv4 地址');
  if (![chatLimit, chatConcurrency].every(value => Number.isInteger(value) && value > 0))
    throw new Error('提问容量配置无效');
  const authority = host + ':' + port;
  const origin = 'http://' + authority;
  const rates = new Map();
  let activeChats = 0;
  const server = http.createServer(async (req, res) => {
    const suppliedId = req.headers['x-request-id'];
    const requestId = typeof suppliedId === 'string' && /^[a-zA-Z0-9._:-]{1,100}$/.test(suppliedId) ? suppliedId : randomUUID();
    const send = (status, data, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId, ...extra});
      const codes = {400:'invalid_request',403:'forbidden',404:'not_found',413:'request_too_large',415:'unsupported_media_type',429:'rate_limited',502:'upstream_unavailable'};
      res.end(JSON.stringify(status >= 400 ? {status:'error',error:codes[status] || 'gateway_error',requestId,...data} : data));
    };
    if (!allowAddress(req.socket.remoteAddress)) return send(403, {message: '仅接受校园网内访问'});
    if (req.headers.host !== authority) return send(403, {message: '请使用启动时显示的校园网网址'});
    if (req.headers.origin && req.headers.origin !== origin)
      return send(403, {message: '仅接受本站页面发起的请求'});
    let url;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error();
      url = new URL(req.url, origin);
    } catch {return send(400, {message: '请求地址无效'});}
    const pathname = url.pathname;
    if (pathname === '/_campus/health' && req.method === 'GET')
      return send(200, {mode: 'campus-read-only', host, port, adminControls: 'local-only'});
    if (pathname === '/api/control') return send(403, {message: '师生浏览模式：策略调整需要管理员权限，目前请由管理员在本机操作'});
    const isChat = pathname === '/api/student/chat' && req.method === 'POST';
    const isStudent = studentFiles.has(pathname) || isChat;
    if (!(req.method === 'GET' && (sandboxFiles.has(pathname) || studentFiles.has(pathname))) && !isChat)
      return send(404, {message: '路径不存在'});
    let body;
    let releaseChat = () => {};
    if (isChat) {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || ''))
        return send(415, {message: '提问需要使用 JSON 格式'});
      const now = Date.now();
      for (const [key, value] of rates) if (now - value.start >= 60000) rates.delete(key);
      const key = req.socket.remoteAddress;
      const rate = rates.get(key) || {start: now, count: 0};
      if (rate.count >= chatLimit)
        return send(429, {error:'rate_limited',message: '提问较多，请稍后重试'}, {'Retry-After': String(Math.max(1,Math.ceil((rate.start+60000-now)/1000)))});
      if (activeChats >= chatConcurrency)
        return send(429, {error:'gateway_busy',message: '提问较多，请稍后重试'}, {'Retry-After': '1'});
      if (!rates.has(key) && rates.size >= 1024)
        return send(429, {message: '访问较多，请稍后重试'}, {'Retry-After': '60'});
      rate.count++; rates.set(key, rate); activeChats++;
      let released = false;
      releaseChat = () => {if (!released) {released = true; activeChats--;}};
      res.once('close', releaseChat);
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32768) {releaseChat(); return send(413, {message: '请求过大'});}
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      } catch {releaseChat(); return send(400, {message: '请求中断'});}
    }
    const upstreamPort = isStudent ? studentPort : sandboxPort;
    const headers = {Host: '127.0.0.1:' + upstreamPort, 'X-Request-ID': requestId};
    // The gateway checks the external origin before supplying the local origin
    // required by the existing loopback services. Private services stay loopback-only.
    if (req.headers.origin) headers.Origin = 'http://127.0.0.1:' + upstreamPort;
    if (isChat) {headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length;}
    const upstream = http.request({hostname: '127.0.0.1', port: upstreamPort, method: req.method,
      path: (pathname==='/'||pathname==='/index.html'?'/viewer/':pathname) + url.search, headers}, reply => {
      const type = reply.headers['content-type'] || 'application/octet-stream';
      const responseHeaders = {'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'X-Request-ID': reply.headers['x-request-id'] || requestId,
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"};
      if (reply.headers['retry-after']) responseHeaders['Retry-After'] = reply.headers['retry-after'];
      reply.on('error', () => {releaseChat(); res.destroy();});
      if (type.includes('text/html')) {
        const chunks = []; let size = 0;
        reply.on('data', chunk => {
          size += chunk.length;
          if (size > 262144) {reply.destroy(); return;}
          chunks.push(chunk);
        });
        reply.on('end', () => {
          if (res.destroyed) return;
          res.writeHead(reply.statusCode, responseHeaders);
          let html=visitorHtml(Buffer.concat(chunks).toString('utf8'), isStudent);
          if(!isStudent)html=html.replace('<div class="header-right">','<div class="header-right"><a class="text-button" href="https://'+host+':4190/login">管理员登录 ↗</a>');
          res.end(html);
        });
      } else {
        const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') &&
          /application\/json|text\/|javascript/.test(type);
        if (gzip) {responseHeaders['Content-Encoding'] = 'gzip'; responseHeaders.Vary = 'Accept-Encoding';}
        res.writeHead(reply.statusCode, responseHeaders);
        if (gzip) {
          const compressor = createGzip({level: 1});
          compressor.on('error', () => {releaseChat(); res.destroy();});
          reply.pipe(compressor).pipe(res);
        } else reply.pipe(res);
      }
    });
    upstream.setTimeout(isChat ? 15000 : 70000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      releaseChat();
      if (!res.headersSent) send(502, {message: '项目服务暂时不可用，请管理员检查本机沙盘和问答服务'});
      else res.destroy();
    });
    res.once('close', () => {if (!res.writableEnded) upstream.destroy();});
    upstream.end(body);
  });
  server.requestTimeout = 75000;
  server.headersTimeout = 15000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--addresses')) console.log(JSON.stringify(campusAddresses()));
  else {
    const candidates = campusAddresses();
    const host = process.env.CAMPUS_HOST || (candidates.length === 1 ? candidates[0].address : '');
    if (!host || !allowedCampusAddress(host)) throw new Error('未找到唯一的校园网 10.x 地址，请通过 CAMPUS_HOST 指定');
    const port = Number(process.env.CAMPUS_PORT || 4180);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('校园网端口无效');
    const server = createCampusServer({host, port});
    server.on('error', error => {console.error('校园网入口启动失败：' + error.message); process.exitCode = 1;});
    server.listen(port, host, () => {
      console.log('校园网沙盘：http://' + host + ':' + port + '/');
      console.log('校园网师生端：http://' + host + ':' + port + '/student/');
      console.log('师生可查看与问答；策略操作仍使用本机 4173 入口。');
    });
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => server.close());
  }
}
