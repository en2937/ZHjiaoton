# 公网部署入口：本机验证记录

日期：2026-10-18。此记录用于区分“代码及本机代理链路已验证”与“真实公网服务器已部署”。部署操作见根目录 [DEPLOY_FOR_AI.md](../DEPLOY_FOR_AI.md)。

## 通过范围

联合回归 **295项通过、0失败**，222.235秒。在隔离协作副本执行，没有启动、停止、重置或调参开发者的正式沙盘。命令：

```powershell
$testFiles = Get-ChildItem -LiteralPath 'server-deploy/tests','ai-provider/tests','traffic-sandbox/tests','dify-integration-lab/tests','qa-policy/tests','admin-access/tests','campus-access/tests','platform-launcher/tests' -Filter '*.test.mjs' -File | Sort-Object FullName | Select-Object -ExpandProperty FullName
node --experimental-vm-modules --test --test-concurrency=1 --test-skip-pattern '^HTTPS ' $testFiles
```

本次新增7项公网专项，使用真实HTTP反向代理链路和本机DeepSeek替身：

- HTTPS来源、独立64位十六进制代理密钥、私有env初始化且不覆盖已有文件。
- 不可信代理、错误Host/Origin、非HTTPS声明、无效客户端IP均拒绝；公网初始化管理员关闭，绕过网关直接访问内部管理员拒绝。
- 真实登录、Secure `__Host-traffic_admin` Cookie、CSRF错误拒绝；管理员方案→确认→执行→师生共享新状态→撤回，回答明确包含认知/意愿/触达依据。
- 登录失败按可信的真实客户端IP限流，不将所有访客当作同一个代理IP。
- 私有路径和实验接口不可访问；师生、只读沙盘、登录页面及HEAD正常，链接不回到开发电脑端口。
- 每IP聊天限额、伪造桥接头不能控制、请求正文大小上限。
- 多访客读取不重建共享场景，默认窗口跨8点自动回7点清理上一轮；真实容器健康检查脚本可从本机代理入口取得成功结果。

原288项覆盖推演等价性、性能边界、场景/问卷模型、登录、AI权限、未知地点、DeepSeek输出与错误处理、旧校园网和启动器兼容性。之前的真实DeepSeek与浏览器验收见 [REAL_API_VALIDATION.md](../ai-provider/REAL_API_VALIDATION.md)，没有在本轮重复产生真实对话费用。

## 修复与限制

- 首次代理测试中发现Node fetch会替换自定义Host，导致403；测试传输和健康检查改用node:http，保留产品的Host/Origin/代理密钥验证，未放宽校验。
- 原认证HTTPS测试需要本机私有证书，隔离副本没有该证书；此用例按上述命令排除。未复制开发者证书来让测试通过。一次早期认证测试因此挂起，已仅清理那次隔离测试进程。
- 当前机器没有Docker。**没有执行Linux镜像构建、Compose启动、Caddy证书申请、实际外网访问、实体手机或长期压力测试**。服务器AI必须按部署说明完成这些验收；本记录不表示这些项目通过。
- 没有验证真实供应商余额耗尽或公网攻击。替身覆盖传输错误、429、超时和格式边界，不能据此宣称所有真实供应商故障都已实测。
- 默认小时循环防止跨小时积压，不代表任意负载下的无限容量。单app进程、Worker与限流边界应保留。

## 发布文件边界

新增公网入口在server-deploy，原管理员服务只增加可选的可信本机代理模式，默认本机/校园网行为保留。Docker构建上下文默认拒绝，仅允许运行源码和页面资产；私有配置、证书、日志、测试证据、账号、备份和工作目录不进入镜像或Git。
