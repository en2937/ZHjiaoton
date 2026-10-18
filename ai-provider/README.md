# DeepSeek 接入与独立测试

本目录增加模型供应商适配。正常服务没有显式选择时继续使用原学校 Dify；独立测试启动器始终选择 DeepSeek，并建立自己的车流、端口、账号文件和 Cookie。

已完成接口适配、本机替身回归，以及真实 DeepSeek 两端问答、网页管理员确认执行/撤回与出发推演验收，详见 [REAL_API_VALIDATION.md](REAL_API_VALIDATION.md)。尚未部署公网；当次接口耗时不代表长期或高并发性能。

## 公网服务器部署

公网版本使用专用入口，详见 [给服务器 AI 的部署说明](../DEPLOY_FOR_AI.md) 和 [本机公网代理回归](../server-deploy/VALIDATION.md)。下面的4283入口仅用于本机独立测试。

## 打开独立测试版

在这个开发分支的项目目录运行：

```powershell
node ai-provider/start-test.mjs
```

Windows 可双击项目根目录的 `启动DeepSeek独立测试.cmd`。需要 Node.js 22 或更新版本；脚本先使用 PATH 中的 Node，再尝试本机 Codex 已安装的运行时。

- 师生页：`http://127.0.0.1:4283/student/`
- 管理员页：`http://127.0.0.1:4283/login`
- 只读沙盘：`http://127.0.0.1:4283/viewer/`

只监听本机。端口占用时明确失败，不终止已有程序；可设置 `DEEPSEEK_TEST_PORT` 另选端口。内部三个服务使用操作系统分配的独立端口，不读取正式 4173 车流、不复制正式账号或桥接密钥、不运行校园网启动器或防火墙脚本。默认仿真仍使用 07:00—08:00 循环。

管理员测试页首次需要单独设置测试账号，存入 `ai-provider/private/test-admin.json`。Cookie 名为 `traffic_admin_deepseek_test`，不会覆盖正式管理员 Cookie；仅换端口不能隔离 Cookie，因此这里使用了独立名称。关闭启动进程只停止本测试站点。

## 下一步需要用户填写的配置

将 `ai-provider/config.example.json` 复制为 `ai-provider/private/config.json`，在此私有文件的 `apiKey` 中自行填写开放平台密钥。`private/` 已被 Git 忽略，网页静态路由也不开放它；不要把密钥放入提示词、前端、聊天、截图或提交历史。

```json
{
  "provider": "deepseek",
  "apiBase": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "apiKey": "",
  "timeoutMs": 45000
}
```

也支持 `AI_PROVIDER=deepseek`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_API_BASE`、`DEEPSEEK_TIMEOUT_MS`。环境变量优先于文件。`STUDENT_AI_PROVIDER` / `ADMIN_AI_PROVIDER` 可分别选择 `dify` 或 `deepseek`，两端也可用 `STUDENT_DEEPSEEK_API_KEY` / `ADMIN_DEEPSEEK_API_KEY`；私有 JSON 的 `student` / `admin` 对象支持分端配置。独立启动器固定两端 DeepSeek，不自动调用学校平台。

DeepSeek 配置只接受官方 HTTPS 主机及基础路径；私有文件不能启用测试用 HTTP 回环。学校 Dify 的密钥绝不会自动继承为 DeepSeek 密钥。正常服务切回 `AI_PROVIDER=dify` 可继续使用原配置，密钥不在供应商之间复用。

`POST /api/check` 仅检查 API 模型列表，确认所配模型可用，不发起聊天。首次真实聊天仍需要另行验收。

## 提示词如何维护

直接复用项目已有两份完整协议提示词，避免复制后分叉：

- 师生：`dify-integration-lab/DIFY_STUDENT_PROMPT.txt`
- 管理员：`admin-ai-design/DIFY_ADMIN_PROMPT.txt`

`prompts.mjs` 每次请求读取对应文件，在前面说明原文中的 `sys.query` 对应本轮 `user` 消息。固定规则放 `system`，本轮 JSON 状态、用户问题和待确认方案放 `user`。每次请求独立，不发送 Dify 会话编号、账号身份或前轮车流；保存提示词文件后，下一次请求自动加载，错误或空文件明确失败。

师生结构化路线选择保持 `campus-student-v1`；管理员保持 `campus-admin-v2`，也兼容旧 v1。结构化调用启用 JSON 输出，默认关闭模型思考，限制输出长度。JSON 合法并不代表业务合法，原来的路线核对、事实占位符、参数范围、状态版本、CSRF、方案确认和撤回仍在后端校验。

管理员分组启用时，仍须明确说明参考了路线认知、尝试意愿与引导触达；未启用时必须说明按原选路规则分析。师生用时与距离仍由沙盘提供，AI 不能编造数值。课堂出发推演、普通时间/距离快答仍为本地计算，不因模型替换变成大模型计算。

## 传输、错误与测试

适配 `/chat/completions` 的流式与 JSON 返回，读取最终 `content`，不显示 `reasoning_content`。空回答、截断、超长、非正常结束、HTML、跳转、余额或限流错误均不会伪装成功。取消关闭本次 HTTP 传输，不承诺供应商端已停止计费；不会自动重试。学生端沿用原队列与截止时间，429 进入原冷却机制。

```powershell
node --test --test-concurrency=1 ai-provider/tests/deepseek.test.mjs ai-provider/tests/site.test.mjs
```

上述自动化测试仅使用本机 HTTP 替身和随机端口，没有真实 API 费用。真实问答、课堂出发、管理员因素说明及建议确认/执行/撤回已另行验收；断网、限流和余额不足由替身覆盖。本轮未做公网网络/HTTPS、校外设备、长期并发验收。当前 Windows 校园网启动器并不是公网部署工具。

接口依据：
- https://api-docs.deepseek.com/zh-cn/
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/guides/thinking_mode/

核对日期：2026-10-18。模型名称与平台能力后续以官方文档及真实测试为准。
