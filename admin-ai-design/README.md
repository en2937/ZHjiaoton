# 管理员 Dify AI 设计

2026-10-13。按用户指定顺序，先配置与验证独立管理员 AI，再接入管理员网页。当前目录保存提示词、状态协议、后端校验准备代码和验收材料。学校应用已发布并接入管理员网页，独立应用密钥仅保存在后端。平台设计验证见VALIDATION.md；真实接口与网页闭环见../admin-access/AI_VALIDATION.md。

应用名称：校园交通-管理员调控助手。当前Chatflow：开始（sys.query）→ LLM（理解本轮状态与请求）→ 直接回复（LLM.text）。使用学校可用模型；关闭LLM历史记忆，用户消息只引用sys.query。每轮由后端携带最新state与pendingProposal，避免把首轮inputs或历史路况当作当前数据。参数校验保存在validate-response.js，已完成本地测试；接入时放入网页后端，验证通过后才执行。该函数也兼容Dify的Code节点，但当前画布没有加入Code节点。

## 对话行为

| 管理员请求 | AI行为 |
| --- | --- |
| 把北侧环岛绕行调到80%，A切到自动配时 | 生成两项明确调参指令，保留其他参数 |
| 绕行增加10个百分点 | 根据本轮参数计算最终值 |
| 看看A为什么堵，怎么优化 | 解释当前指标，提出方案与B压力的观察要点 |
| 按刚才方案执行 | 只使用后端保存、且基准参数/场景仍匹配的方案 |
| 设红灯10秒、扩大道路 | 明确当前模型不支持 |
| 绕行设150%或“调高一点” | 分别拒绝越界、要求补充确定值 |

AI只生成指令。接入后，网页后端校验管理员身份、参数范围与方案，再通过共享仿真应用指令，读取结果后显示“已生效”。Dify预览不能宣称已经控制本机沙盘。明确合法调参无需每轮再确认；优化咨询只提方案，可通过“执行方案”继续对话。方案被执行后清除；参数改变/仿真重置后旧方案失效。

平台验证中，不支持的灯时设置被模型归为out_of_scope，而首选分类为invalid_request；两类均属于合法拒绝，后端兼容处理并保证无参数变更。此差异保留在platform-results.json和platform-checks.json中。设置成功文案由后端根据执行结果生成，不直接使用模型的“请确认”或“已执行”等表达。

## 参数与指标

参数定义与范围以traffic-sandbox/control-settings.mjs为准。原七项demand、motorDemand、northDemand、electric、outbound、northBypassShare、westSignalMode保留。认知分组启用时AI额外可调整guidanceCoverage（0–100）。behaviorMode、认知/意愿权重、种子、试用概率及收益门槛只供分析。northBypassShare是管理员策略目标，不是引导覆盖、接受率或实际绕行比例。A固定配时为30秒绿灯，自动配时是现有规则型控制器；不开放灯色或安全过渡秒数的直接写入。

state必须来自当前共享仿真，包含source、stateVersion、runId、updatedAt、simulationTime、settings、metrics。全体状态为合成仿真。metrics读取Simulation.metrics()，不由LLM生成；A平均排队/等待从本轮运行起累积，调参后的即时效果不能用其旧平均值断言。无独立对照推演时，AI只能提出待验证的方向，不能量化优化效果。

## 当前协议与行为分组（2026-10-14）

当前`campus-admin-v2`每轮追加统一时钟、出发场景、同源师生路线估算、行为统计及动态控制白名单。模型返回protocol、status、intent、state_version、reply、basis、changes、suggested_settings、evidence九字段。与选路相关的分析使用简短basis说明认知、意愿和触达；未启用时明确按原选路规则分析。模式及其他相关配置改变后，旧待执行方案失效。

数字由后端生成的`behavior.facts`完整事实描述提供，包括明确群体、时间范围、条件、人数或单位；模型引用事实占位符并列出证据。后端检查分母、状态版本、路径和控制参数，再填充数字。无法统计时标记缺失，不能猜测。裸数字统计和把条件意愿误作长期使用均不接受。初次格式不合格时最多一次格式修复；45秒总时限内重新核对权限与配置，修复不得改变控制意图或参数值。

问卷样本36份；认知18/14/4、意愿32/2/2使用原始人数权重。调查小路对应北侧环岛绕A路线由用户确认；人群迁移、两题独立分配、概率与门槛属于模拟假设。模型与口径见../traffic-sandbox/ROUTE_BEHAVIOR.md，真实联调与对照证据见../traffic-sandbox/ROUTE_BEHAVIOR_VALIDATION.md。v1兼容保留供旧服务回退，旧VALIDATION.md及platform-results.json是历史验收，不代表当前分组验收。

独立网页验收必须使用专用Cookie名称；不同端口不足以隔离本机登录。测试不得重置正式共享沙盘。

## 后续接入验收

1. 每次询问前读取共享状态，后端组装JSON到query；不向Dify开放本机控制接口。
2. 只将status=ok且intent=set/apply_proposal的白名单changes交给沙盘；建议不自动执行。
3. 在共享仿真执行控制的同一次操作内，原子比较runId与完整settings；仿真推进引起revision增长可接受，其他管理员调参或重置则拒绝旧指令并重新读取。不能仅检查不断增长的revision，也不能忽略设置冲突。
4. 读取应用后的实际settings，再显示成功与变更明细；接口失败不显示成功。记录修改前参数，提供恢复上次调参。师生端下一轮使用同源新状态。
5. 复用已有admin-access登录会话、同源与CSRF保护：本机4174/login、校园网HTTPS 4190；原4173控制接口使用后端桥接密钥，不能匿名直调。4180师生网关继续禁止控制端点。不得向Dify、网页或日志传入管理员密码、会话凭据或桥接密钥。
6. 在浏览器完成命令→控件更新→车流变化→C端建议变化；测试状态缺失、模糊/越界请求、过期方案、多人冲突和上游失败。

## 配置来源

[Dify LLM节点](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)支持提示词和变量；[Code节点](https://docs.dify.ai/en/cloud/use-dify/nodes/code)支持JavaScript校验并返回声明的输出。调用已发布应用时，密钥应仅由后端保存，见[Dify API入门](https://docs.dify.ai/en/api-reference/guides/get-started)。学校版本以实际工作室界面为准。
