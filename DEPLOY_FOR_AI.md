# 公网部署交接：供协作者的 AI 执行

更新：2026-10-18。目标是将本仓库的 DeepSeek 版本部署到协作者自己的公网服务器，使用真实 HTTPS，保留管理员调参、共享沙盘、师生问答的闭环。

## 先确认版本与边界

- 使用分支 **`codex/deepseek-api`**：<https://github.com/en2937/ZHjiaoton/tree/codex/deepseek-api>。`main` 和旧 `codex/share-departure-forecast` 可能没有本版的 DeepSeek 与公网入口。开始和交付时都记录 `git rev-parse HEAD`。
- 本文是可执行部署说明，不代表已经在你的服务器上线。发布前已在 Windows 的隔离副本验证代理链路；此处的 Docker 镜像构建、Linux 容器运行、域名证书签发与校外网络仍需由你实际验收。不能把本机通过改写为公网已通过。
- 下列命令面向 **Linux + Docker Engine + Compose v2**。先检查服务器操作系统、CPU/内存、磁盘、Docker、DNS和已有服务。若为 Windows 或没有 Docker，请先说明适配方案，再操作。
- 先检查 80/443 是否已有站点占用。已有 Nginx/Caddy/宝塔/其它业务时，不覆盖配置、不停其它站点；为本项目设计独立域名和代理适配。需要复用代理时必须保留下面的可信代理头覆盖与隔离规则。
- 源码不含 API 密钥、管理员账号、学校配置或旧车流。不得复制开发电脑的 `private/`、`.env*`、证书、检查点。不得把密钥/密码粘贴到聊天、Git、工单或验证报告。
- 仅使用本服务器和本仓库完成工作，不改开发者电脑的 4173/4174/4183/4283 服务，也不触及其它聊天的沙盘。

## 运行结构与容量

```text
浏览器 -- HTTPS:443 --> Caddy -- 容器内部HTTP --> app:3000
                                          ├─ 共享仿真（内部随机端口）
                                          ├─ 师生问答 → DeepSeek官方API
                                          └─ 管理员认证/AI/控制
```

唯一公网端口为 Caddy 的 80/443。app 的 3000 **没有映射到宿主机**，内部服务只监听容器的 127.0.0.1。不要额外发布 3000 或内部端口，不要把 `ai-provider/start-test.mjs` 或 Windows 一键启动脚本当作公网入口。

本版使用**一个 app 进程、一份内存沙盘**。不要配置多 app 副本、PM2 cluster 或按请求启动沙盘，否则会出现管理员和师生读取不同车流。默认共用仿真 07:00—08:00 循环，管理员可手动覆盖；访客刷新不会重建模型。重启会清空当前车辆、内存会话和预测缓存，并重新从默认场景开始；`app_data` 中的管理员账号哈希保留。本版没有车流自动持久化。

建议从 2 vCPU、至少 2 GB 内存的独立测试环境起步，再实测 CPU/内存与问答延迟。这是起步配置建议，不是并发承诺；Compose 将 app 内存上限设为 1536 MB，服务器还要给系统和 Caddy 留空间。完整推演占用 Worker，增加内存不能自动消除 CPU 耗时。

## 需要所有者提供或亲自操作的内容

1. 服务器登录权限，以及已经解析到该服务器的域名，例如 `traffic.your-domain.cn`。确认适用的域名备案、服务商和学校公开展示要求。
2. DeepSeek 官方 API 密钥和可用余额。由所有者在服务器私有文件中填入，不发给 AI 聊天。
3. 首次管理员账号、密码。由所有者在服务器交互终端输入，下面有专用命令；AI 不代设公开默认账号。
4. 域名 DNS、云安全组/本机防火墙的必要调整。只放行本项目所需的 80/443，保留现有管理通道；不要清空规则。

本示例要求域名和受浏览器信任的证书。只有公网 IP 时，不要直接声称配置即可得到可信 HTTPS；先安排域名或适合该 IP 的有效证书方案。禁止用忽略证书错误、HTTP 管理员登录或去掉 Secure Cookie 来绕过问题。

## 从干净仓库部署

以下命令除克隆外，均在项目根目录执行。示例域名必须换成真实域名；不得把示例域名用于证书申请。

### 1. 检查与下载

先只读检查 `uname -a`、`free -h`、`df -h`、`docker version`、`docker compose version`、监听端口及现有容器。若需要安装 Docker，按服务器发行版的官方安装流程执行，不盲目运行第三方脚本。

```bash
git clone --branch codex/deepseek-api --single-branch https://github.com/en2937/ZHjiaoton.git zju-traffic
cd zju-traffic
git branch --show-current
git rev-parse HEAD
```

若目标目录已存在，先检查其分支与未提交内容，不覆盖、强制重置或删除用户文件。GitHub Download ZIP 也可用，但必须选这个分支并记录下载版本。

### 2. 生成服务器自己的私有配置

服务器有 Node.js 24 时：

```bash
node server-deploy/init-env.mjs https://traffic.your-domain.cn
```

没有 Node、已有 Docker 时，可用一次性容器生成：

```bash
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace node:24-alpine node server-deploy/init-env.mjs https://traffic.your-domain.cn
```

生成器创建 `server-deploy/.env`，自动生成独立代理密钥，已有文件时拒绝覆盖。**请暂停在这里，让所有者用服务器编辑器自行填入 `DEEPSEEK_API_KEY`**，然后继续。保留代理密钥，不要打印它。执行：

```bash
chmod 600 server-deploy/.env
```

私有文件中各项的含义：

| 项 | 如何填写 |
| --- | --- |
| `PUBLIC_ORIGIN` | 真实完整来源，例如 `https://traffic.your-domain.cn`，无子路径；本例为标准443端口 |
| `PUBLIC_HOST` | 同一域名，不含 `https://` 或路径 |
| `TRAFFIC_PROXY_KEY` | 生成器创建的64位十六进制密钥，Caddy与app共用；不是DeepSeek密钥 |
| `DEEPSEEK_API_KEY` | 所有者的DeepSeek官方API密钥 |
| `DEEPSEEK_MODEL` | 默认 `deepseek-flash`；先通过下面的模型探测确认账号可用，必要时选实际支持的模型 |

Compose 显式把模型密钥只传给 app，Caddy 不接收它。`.env` 被 Git 和 Docker 构建上下文排除。不执行会展开并输出密钥的 `docker compose config`、`env`、`docker inspect` 或 `cat server-deploy/.env`；需要验证 Compose 时使用 `config --quiet`。不要将密钥作为 shell 命令参数或写入 Dockerfile。

### 3. 验证配置、构建与初始化管理员

```bash
docker compose --env-file server-deploy/.env -f server-deploy/compose.yml config --quiet
docker compose --env-file server-deploy/.env -f server-deploy/compose.yml build app
docker compose --env-file server-deploy/.env -f server-deploy/compose.yml run --rm --no-deps app node server-deploy/check-ai.mjs
```

`check-ai.mjs` 使用官方模型列表探测，不发送对话。失败时检查服务器出网、密钥、余额/账号状态、模型权限与官方故障信息；不要打印密钥，也不要取消TLS校验。它通过不等于真实问答已验收。

**接下来由所有者在交互终端执行**：

```bash
docker compose --env-file server-deploy/.env -f server-deploy/compose.yml run --rm --no-deps app node server-deploy/setup-admin.mjs
```

必须保留默认交互 TTY，不加 `-T`。输入账号和两次密码（12—128位，输入不显示）。仅保存盐和密码哈希到 `app_data:/data/admin.json`。已有账号时拒绝覆盖。公网 `/api/admin/setup` 始终关闭；没有初始化管理员时 app 拒绝启动。不要改成“第一个外网访客创建管理员”。

### 4. 启动与证书

确认真实域名的 A/AAAA 记录均指向可达的服务器；没有IPv6服务时不要保留错误的AAAA。80/443不能被其它程序占用，云安全组和本机防火墙允许访问。

```bash
docker compose --env-file server-deploy/.env -f server-deploy/compose.yml up -d
docker compose --env-file server-deploy/.env -f server-deploy/compose.yml ps
```

Caddy 按域名自动申请/续期证书，数据保存在专用卷。只有 app 健康后 Caddy 才启动。若启动失败，查看本项目相关容器的少量日志并先脱敏，不要把完整环境或账号文件贴出来。

若需要只验证 Caddy 语法，使用下面的安静命令；不要运行会输出插入代理密钥后的完整配置的 `caddy adapt`：

```bash
docker compose --env-file server-deploy/.env -f server-deploy/compose.yml run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

访问入口：

| 页面 | 地址 |
| --- | --- |
| 师生端，建议对外分享这个 | `https://真实域名/student/` |
| 只读沙盘 | `https://真实域名/viewer/` |
| 管理员登录 | `https://真实域名/login` |
| 管理员沙盘，未登录会跳转 | `https://真实域名/` |
| 最小健康状态 | `https://真实域名/_health` |

## 必须完成的真实验收

不能只看到容器 running 就宣布完成。记录真实结果和版本，别在报告中提供密钥、Cookie、CSRF token 或账号文件。

1. **外网与 HTTPS**：从服务器外、最好手机流量访问师生页、只读沙盘和登录页。证书有效且不需要安装开发者CA；HTTP应跳到HTTPS。`curl -fsS https://真实域名/_health` 应成功，不使用 `-k`。观察页面资源、控制台和网络请求，不应指向开发电脑的127.0.0.1端口。
2. **访问权限**：未登录访问根路径跳登录；未登录控制请求不能成功；`/api/admin/setup` 为403，`/ai-provider/private/config.json`、`/server-deploy/.env`、`/api/check`、`/api/chat` 等内部路径不能取得私有内容。跨域来源或伪造桥接头不能调参。
3. **真实对话**：选择云峰学园→东教学楼，分别问时间/距离比较。确认当前配置、三条路线、时间和距离来自本地状态，普通对话实际走DeepSeek；如命中本地快答，不能把它算作模型连通测试。未知建筑应保守拒答，缺课堂时间应追问。只读访客不能执行控制。
4. **管理员闭环**：由所有者登录，问“结合认知、意愿和引导覆盖给一个优化方案”。应说明参考该因素，先提出方案，等待确认才执行；验证师生读取同一runId和设置，再撤回。只在双方同意的测试场景进行，别改真实正在展示的参数。检查Cookie的Secure、HttpOnly、SameSite及CSRF约束没有被代理破坏。
5. **完整推演**：问“从云峰去东教上早八，提前五分钟到，几点出发”。观察异步任务/轮询而不是长连接等待；首次推演可能需要较长时间，再问同条件检查缓存。它在本地Worker计算，不由DeepSeek生成数字；以前360人本机约70秒、缓存约54毫秒，仅为开发机样本。不能承诺上服务器后秒回。保留180秒/256MB Worker边界，不以无限延时绕过性能问题。
6. **默认循环和共享状态**：默认07:00—08:00，跨8点回7点清理车流；管理员改场景可覆盖。多位访客读同一场景，刷新不重置。浏览器可观察一轮（4倍速约15分钟真实时间），不要在公开运行中通过控制强行跳时验收。
7. **资源与失败路径**：查看本项目CPU、内存、Worker和少量并发请求。网关师生每IP每分钟60次、同时最多32个转发聊天请求；模型另有原有并发、排队和会话限制。超限应明确提示，不能靠取消限流或扩成多沙盘副本应付。暂不承诺抗恶意压测；若广泛开放，按实测安排校园访问范围、服务商限额/余额提醒或前置访问控制。

## 更新、备份与回退

- 先保存当前发布提交号、Compose版本及本项目配置。私有 `.env`、`app_data`（账号哈希）和证书卷应按服务器自己的受限备份流程保存；备份也不可进入公共Git。日志有大小轮转，仍应检查磁盘。
- 更新前确认 `git status`，先保留本地改动。获取 `codex/deepseek-api` 的新提交，审查后重新 `build app` 和 `up -d`。不要让定时任务自动拉取未知变更直接重启。
- 回退时使用先前已验收的提交或镜像标签，仅针对本Compose项目恢复；不重置别人的工作目录。若账号格式发生变化，先确认数据兼容性。本版启动会保留已存在账号。
- **不要使用 `docker compose down -v`、`docker system prune` 或删除卷作为“重装”步骤**，这些会丢失账号/证书或影响其它项目。
- app重启后需重新登录；车辆与缓存重新开始。不得声称重启后保留中断时每辆车、运行时刻或待执行AI方案。本机历史检查点不在仓库，也不是服务器自动恢复方案。

## 关键源码与后续修改位置

| 文件 | 用途 |
| --- | --- |
| `server-deploy/compose.yml`、`Dockerfile`、`Caddyfile` | 单进程应用、持久卷、HTTPS代理与日志轮转 |
| `server-deploy/server.mjs` | 公网白名单、可信代理、限流、异步推演入口、内部三服务 |
| `server-deploy/setup-admin.mjs` | 仅服务器终端初始化账号 |
| `ai-provider/config.mjs`、`deepseek.mjs` | DeepSeek配置、超时、流式输出、错误脱敏 |
| `ai-provider/prompts.mjs` | 每轮加载完整系统提示词及内容指纹 |
| `dify-integration-lab/DIFY_STUDENT_PROMPT.txt` | 师生提示词（名称保留，DeepSeek也读取它） |
| `admin-ai-design/DIFY_ADMIN_PROMPT.txt` | 管理员提示词；保留行为因素说明、确认/撤回与权限边界 |
| `dify-integration-lab/DEPARTURE_FORECAST.md`、`FORECAST_SPEED_VALIDATION.md` | 完整出发推演方法与性能限制 |
| `server-deploy/VALIDATION.md`、`ai-provider/REAL_API_VALIDATION.md` | 本次自动化与此前真实DeepSeek测试记录 |

在源码中改提示词后需要重新构建/部署镜像；不要只改学校Dify工作室。改提示词不能代替后端的数值、权限和版本校验。

## 给项目所有者的最终交付

请报告：实际分支与提交、真实师生/沙盘/管理员URL、证书状态、模型探测及真实问答结果、管理员确认/执行/撤回结果、共享循环结果、CPU/内存观察、未通过或未测试项，以及下次更新/回退命令。若卡在域名、权限、密钥或交互密码，请明确只需所有者完成的那一步，保留已做工作；不要假称已经部署。

参考：[Caddy自动HTTPS](https://caddyserver.com/docs/automatic-https)、[Caddy反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Docker官方Node镜像](https://hub.docker.com/_/node)、[Docker Compose文档](https://docs.docker.com/compose/)。
