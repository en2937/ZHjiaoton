import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fixture, makeEnvelope} from './fixtures.mjs';
import {studentEnvelope, parseStudentReply, routeComparison, futureQuestion} from './student.mjs';
import {createSandboxClient,places,modes} from './sandbox-client.mjs';

const root = new URL('./', import.meta.url);
const webRoot = new URL('./public/', root);
const LIMIT = 32 * 1024;
class LabError extends Error {
  constructor(status, code, message) {super(message); Object.assign(this, {status, code});}
}

export async function loadConfig() {
  let saved = {};
  try {saved = JSON.parse(await readFile(new URL('.env.local', root), 'utf8'));}
  catch (e) {if (e.code !== 'ENOENT') throw new Error('本地 Dify 配置格式错误，请重新运行配置程序。');}
  return {
    apiBase: process.env.DIFY_API_BASE || saved.apiBase || 'https://dify-api.zju.edu.cn/v1',
    apiKey: process.env.DIFY_API_KEY || saved.apiKey || '',
    inputs: saved.inputs || {}, timeoutMs: 45000,
  };
}

function apiBase(config) {
  let url;
  try {url = new URL(config.apiBase);}
  catch {throw new LabError(503, 'invalid_config', '请在本地配置程序中填写学校应用的实际 API 地址。');}
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(config.allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new LabError(503, 'invalid_config', 'API 地址需要使用 HTTPS，且不能包含密钥、查询参数或账号密码。');
  }
  return url.href.replace(/\/$/, '');
}

function requireConfig(config) {
  if (!config.apiKey) throw new LabError(503, 'not_configured', '后端尚未配置应用 API 密钥。请运行独立目录中的“配置Dify.cmd”。');
  return apiBase(config);
}

function redact(text, key) {return key ? String(text).split(key).join('[已隐藏密钥]') : String(text);}
function upstreamError(status) {
  const messages = {
    401: 'Dify 拒绝密钥，请核对本地配置的应用 API 密钥。',
    403: '学校平台拒绝 API 访问，请检查账号、网络和应用权限。',
    404: 'Dify 接口不存在，请核对应用页面显示的 API 基础地址。',
    429: 'Dify 调用额度或频率已达限制，请稍后再试。',
    400: 'Dify 请求被拒绝，请检查应用是否为 Chatflow／聊天助手、是否已发布，以及必填输入变量。',
  };
  return new LabError(502, 'dify_http_' + status, messages[status] || 'Dify 服务暂时无法完成请求（HTTP ' + status + '）。');
}

async function callDify(config, endpoint, payload) {
  const base = requireConfig(config);
  let response;
  try {
    response = await fetch(base + endpoint, {
      method: payload ? 'POST' : 'GET', redirect: 'manual',
      headers: {Authorization: 'Bearer ' + config.apiKey, ...(payload ? {'Content-Type': 'application/json'} : {})},
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(config.timeoutMs || 45000),
    });
  } catch (error) {
    throw new LabError(502, error.name === 'TimeoutError' ? 'dify_timeout' : 'dify_network',
      error.name === 'TimeoutError' ? 'Dify 响应超时，可以保留当前状态稍后重试。' : '后端无法连接学校 Dify，请检查校园网／VPN、API 地址和网络访问权限。');
  }
  if (response.status >= 300 && response.status < 400)
    throw new LabError(502, 'dify_redirect', 'API 返回了跳转，可能指向登录页；请核对应用 API 地址和学校访问方式。');
  if (!response.ok) throw upstreamError(response.status);
  return response;
}

export async function readReply(response) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await response.json();
    if (typeof data.answer !== 'string') throw new LabError(502, 'invalid_reply', '接口返回的数据不是聊天回答。');
    return {answer: data.answer, conversationId: data.conversation_id || '', messageId: data.message_id || data.id || ''};
  }
  if (!type.includes('text/event-stream'))
    throw new LabError(502, 'unexpected_content', 'API 返回了网页而非聊天数据，请核对地址、登录和访问权限。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', answer = '', conversationId = '', messageId = '', size = 0, complete = false;
  function processEvent(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try {event = JSON.parse(data);} catch {throw new LabError(502, 'invalid_stream', 'Dify 流式回答格式无法解析。');}
    if (event.event === 'error') throw new LabError(502, 'dify_run_error', 'Dify 工作流运行失败，请查看学校应用的运行日志和模型配置。');
    if (['message', 'agent_message'].includes(event.event)) answer += event.answer || '';
    if (event.event === 'message_replace') answer = event.answer || '';
    if (event.conversation_id) conversationId = event.conversation_id;
    if (event.message_id) messageId = event.message_id;
    if (event.event === 'message_end') complete = true;
  }
  try {
    while (!complete) {
      const {value, done} = await reader.read();
      if (done) {buffer += decoder.decode(); break;}
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new LabError(502, 'reply_too_large', 'Dify 回答过大，请缩短问题或应用输出。');
      buffer += decoder.decode(value, {stream: true});
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        processEvent(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      }
    }
    if (!complete && buffer.trim()) processEvent(buffer);
    if (!complete) throw new LabError(502, 'incomplete_reply', 'Dify 连接中断，未收到完整回答。');
    if (!answer.trim()) throw new LabError(502, 'empty_reply', '工作流没有输出回答，请检查 Answer 节点。');
    return {answer, conversationId, messageId};
  } finally {await reader.cancel().catch(() => {});}
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw new LabError(413, 'body_too_large', '请求内容过大。');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw new LabError(400, 'bad_json', '请求需要是有效 JSON。');}
}

export function createLabServer(configProvider = loadConfig,{studentProvider=createSandboxClient()}={}) {
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const send = (status, body) => {
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(body));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'");
    try {
      const host = req.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new LabError(403, 'host_rejected', '请使用本机 127.0.0.1 地址。');
      const origin = req.headers.origin;
      if (origin && origin !== 'http://' + host) throw new LabError(403, 'origin_rejected', '仅接受本机测试页面发起的请求。');
      const path = new URL(req.url, 'http://' + host).pathname;
      if (req.method === 'GET' && path === '/api/student/options') {
        const config = await configProvider();
        return send(200,{places,modes,configured:Boolean(config.apiKey),sourceLabel:'沙盘合成仿真 · 用时与距离为估算'});
      }
      if(req.method==='GET'&&path==='/api/student/state'){
        const params=new URL(req.url,'http://'+host).searchParams;
        const state=await studentProvider({origin:params.get('origin')||'1',destination:params.get('destination')||'2',mode:params.get('mode')||'electric'});
        if(!state)throw new LabError(422,'unknown_trip','这个行程暂时没有路线数据。');
        return send(200,state);
      }
      if (req.method === 'POST' && path === '/api/student/chat') {
        const body = await readBody(req);
        if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1000)
          throw new LabError(400,'bad_question','请输入 1–1000 字的问题。');
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(body.sessionId || '')) throw new LabError(400,'bad_session','请刷新页面后重试。');
        if (!body.trip || !['time','distance'].includes(body.preference)) throw new LabError(400,'bad_trip','请先选择出发地、目的地和出行方式。');
        const state = await studentProvider({...body.trip,fixtureId:body.fixtureId || 'A'});
        if (!state) throw new LabError(422,'unknown_trip','这个行程暂时没有路线数据。');
        const metadata={stateVersion:state.stateVersion,source:state.source,sourceLabel:state.sourceLabel,trip:body.trip,mode:state.mode,
          runId:state.runId,simulationTimeSeconds:state.simulationTimeSeconds,settings:state.settings,clock:state.clock,departureScenario:state.departureScenario,calibration:state.calibration};
        if(state.origin===state.destination)return send(200,{...metadata,provider:'local-validation',status:'same_place',message:'出发地和目的地相同，无需比较路线。',routes:[]});
        if (!state.routes.length) return send(200,{...metadata,provider:'local-validation',status:'missing_data',message:state.unavailableReason||'当前沙盘没有这个行程的数据。',routes:[]});
        if (futureQuestion(body.question)) return send(200,{...metadata,provider:'local-validation',status:'missing_data',message:'还没有未来时段的推演数据，暂时无法比较。',routes:[]});
        const sessionKey='student:'+body.sessionId,previous=sessions.get(sessionKey);
        if(previous?.busy)throw new LabError(409,'session_busy','上一条问题还在处理中。');
        if(!previous&&sessions.size>=100)throw new LabError(429,'session_limit','会话已达上限，请重启独立服务。');
        const session=previous || {user:'traffic-student-'+randomUUID(),conversationId:'',busy:false};
        sessions.set(sessionKey,session);session.busy=true;
        try {
          const config=await configProvider();
          const response=await callDify(config,'/chat-messages',{
            inputs:config.inputs || {},query:studentEnvelope(body.question.trim(),state,body.preference),
            response_mode:'streaming',user:session.user,auto_generate_name:false,
            ...(session.conversationId?{conversation_id:session.conversationId}:{}),
          });
          const reply=await readReply(response),decision=parseStudentReply(reply.answer,state);
          if(!decision)throw new LabError(502,'invalid_student_reply','AI 这次没给出可核对的路线建议，请重试。');
          session.conversationId=reply.conversationId;
          if(decision.status!=='ok')return send(200,{...metadata,provider:'school-dify',status:decision.status,
            message:decision.status==='missing_data'?'这条路线暂时没有数据，请换一个目的地。':'我可以帮你比较校园路线的时间和距离。',routes:[],latencyMs:Date.now()-started});
          const route=state.routes.find(r=>r.id===decision.recommendedRouteId);
          return send(200,{...metadata,provider:'school-dify',status:'ok',criterion:decision.criterion,
            recommendedRouteId:route.id,message:'建议走'+route.name+'，'+(decision.criterion==='distance'?'路程更短。':'用时更少。'),
            routes:state.routes,comparison:routeComparison(state),latencyMs:Date.now()-started,messageId:reply.messageId});
        }finally{session.busy=false;}
      }
      if (req.method === 'GET' && path === '/api/status') {
        const config = await configProvider();
        const base = apiBase(config);
        return send(200, {configured: Boolean(config.apiKey), apiBase: base, schoolUrl: 'https://dify.zju.edu.cn/apps', mode: 'real-dify', fixtureNotice: '人工构造接口样例，非沙盘计算'});
      }
      if (req.method === 'GET' && /^\/api\/fixtures\/[AB]$/.test(path)) return send(200, fixture(path.at(-1)));
      if (req.method === 'POST' && path === '/api/check') {
        await readBody(req);
        const response = await callDify(await configProvider(), '/parameters');
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw new LabError(502, 'unexpected_content', 'API 返回了网页，请核对实际 API 地址。');
        const data = await response.json();
        return send(200, {connected: true, requiredInputs: (data.user_input_form || []).map(item => Object.values(item)[0]).filter(Boolean).map(item => ({variable: item.variable, type: item.type, required: item.required}))});
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const body = await readBody(req);
        if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000)
          throw new LabError(400, 'bad_question', '请输入 1–2000 字的问题。');
        const state = fixture(body.fixtureId);
        if (!state) throw new LabError(422, 'unknown_state', '当前状态缺失或未知，请选择样例 A 或 B。');
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(body.sessionId || '')) throw new LabError(400, 'bad_session', '会话标识无效，请刷新页面。');
        // These fixtures have no forecast. Reject explicit future-time queries
        // before a language model can reuse current metrics as a prediction.
        if (/未来|明天|后天|稍后|(?:分钟|小时|天)后|过\s*[0-9一二三四五六七八九十百几]+\s*(?:分钟|小时)/u.test(body.question)) {
          return send(200, {
            answer: '人工构造接口样例，非真实路况。状态版本：' + state.stateVersion + '。暂无未来时段推演数据，无法给出未来出发的路线耗时或建议。当前样例指标只适用于本轮状态。',
            stateVersion: state.stateVersion, usedSource: state.sourceLabel,
            provider: 'local-validation', reason: 'forecast_unavailable', latencyMs: Date.now() - started, sentState: state,
          });
        }
        const previous = sessions.get(body.sessionId);
        if (previous?.busy) throw new LabError(409, 'session_busy', '上一条问题仍在处理中。');
        if (!previous && sessions.size >= 100) throw new LabError(429, 'session_limit', '本地测试会话已达上限，请重启独立测试服务。');
        const session = previous || {user: 'traffic-lab-' + randomUUID(), conversationId: '', busy: false};
        sessions.set(body.sessionId, session);
        session.busy = true;
        try {
          const config = await configProvider();
          const query = makeEnvelope(body.question.trim(), state);
          const response = await callDify(config, '/chat-messages', {
            inputs: config.inputs || {}, query, response_mode: 'streaming', user: session.user,
            ...(session.conversationId ? {conversation_id: session.conversationId} : {}), auto_generate_name: false,
          });
          const reply = await readReply(response);
          session.conversationId = reply.conversationId;
          return send(200, {answer: redact(reply.answer, config.apiKey), stateVersion: state.stateVersion,
            messageId: reply.messageId, usedSource: state.sourceLabel, provider: 'school-dify', latencyMs: Date.now() - started, sentState: state});
        } finally {session.busy = false;}
      }
      if (req.method === 'GET' && path === '/') {
        res.writeHead(302, {Location: '/student/', 'Cache-Control': 'no-store'}); res.end(); return;
      }
      const files = {
        '/student/':['student/index.html','text/html'],'/student':['student/index.html','text/html'],
        '/student/app.mjs':['student/app.mjs','text/javascript'],'/student/style.css':['student/style.css','text/css'],
        '/student/emblem.png':['student/emblem.png','image/png']};
      if (req.method === 'GET' && files[path]) {
        const [file, type] = files[path];
        const data = await readFile(new URL(file, webRoot));
        res.writeHead(200, {'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(data); return;
      }
      throw new LabError(404, 'not_found', '路径不存在。');
    } catch (error) {
      send(error.status || 500, {error: error.code || 'internal_error', message: error instanceof LabError ? error.message : '服务暂不可用，请稍后重试。'});
    }
  });
  server.requestTimeout = 65000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.DIFY_LAB_PORT || 4183);
  const server = createLabServer();
  server.on('error', e => {console.error(e.code === 'EADDRINUSE' ? '独立测试端口已占用，请使用 DIFY_LAB_PORT 指定其他端口。' : '独立测试服务无法启动。'); process.exitCode = 1;});
  server.listen(port, '127.0.0.1', () => console.log('Dify integration lab: http://127.0.0.1:' + port));
}
