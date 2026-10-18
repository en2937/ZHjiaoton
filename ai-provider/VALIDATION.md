# DeepSeek 独立接入验证

日期：2026-10-18。范围为计划第2、3、4步：独立测试版本、供应商适配及提示词加载。本文件记录当时未使用真实密钥的自动化测试；后续真实 DeepSeek 验收见 [REAL_API_VALIDATION.md](REAL_API_VALIDATION.md)。未使用学校账号或公开部署。

## 结果

联合回归288项通过、0失败，耗时196.887秒。覆盖现有沙盘、完整出发推演、问答边界、登录、管理员AI、校园网代理、启动器，以及新增DeepSeek专项15项。需要本机私有证书的HTTPS用例没有纳入本轮，不能将此记录当作公网TLS验收。

运行命令（PowerShell）：

```powershell
$testFiles = Get-ChildItem -LiteralPath 'ai-provider/tests','traffic-sandbox/tests','dify-integration-lab/tests','qa-policy/tests','admin-access/tests','campus-access/tests','platform-launcher/tests' -Filter '*.test.mjs' -File | Sort-Object FullName | Select-Object -ExpandProperty FullName
node --experimental-vm-modules --test --test-concurrency=1 --test-skip-pattern '^HTTPS ' $testFiles
```

## 新增验证

- 默认Dify及分端供应商选择；DeepSeek不继承学校应用密钥；环境变量优先；非法配置和地址拒绝；私有文件不能启用测试HTTP回环。
- 读取原师生/管理员完整提示词，适配sys.query含义；每轮重新加载且有内容指纹；system与本轮user分离，不发送Dify会话历史或身份。
- 实际本机HTTP模拟DeepSeek：中文跨字节SSE、CRLF、最终content、不展示reasoning；结构化JSON输出、非思考、输出限制。
- 无响应、流式挂起、取消、截断、空回答、超长、HTML、跳转、401、余额不足、429及服务失败。错误和成功回复均不泄漏测试密钥。
- 师生时间/距离三路线比较；未知地点与课堂缺时间本地处理；模型非法输出被原校验器阻断；当前状态变化返回409；429冷却不自动重试。
- 管理员登录与CSRF、认知/意愿/触达依据、建议等待确认、执行/撤回、引导覆盖明确调参；师生随后读取同一份测试状态。
- 独立网关、私有配置路由404、只读控制拒绝、浏览器伪造桥接头无效；测试Cookie与正式Cookie隔离；HTML链接不指回正式4173/4174/4183端口。
- 无真实密钥时页面可打开，模型请求明确返回not_configured，不伪造已连接或已回答。

## 边界与后续

这些是本机HTTP替身及原项目自动化验证，不能证明真实模型会稳定遵守提示词、在学生端当前时限内回答，或验证其真实计费、余额和公网可达性。下一步用户自行填入私有密钥后，再验收真实两端问答及浏览器交互。完整出发推演仍在本地Worker，不由DeepSeek计算，首次推演速度不会因为替换对话模型自动加快。

正式根目录运行代码、提示词、引擎与Git索引保持不动；不重启正式服务，不更改校园网绑定/防火墙，也不复制正式账号、Dify密钥或运行检查点。全部代码改动只在本地codex/deepseek-api独立工作副本，未推送GitHub。
