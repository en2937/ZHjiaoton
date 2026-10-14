# 管理员 AI 设计与平台验证

日期：2026-10-13。当前状态：学校 Dify 应用已创建，草稿已保存并完成平台预览；未发布、未创建管理员应用 API 密钥、未接入管理员网页。

## 当前应用

- 名称：校园交通-管理员调控助手。
- 工作室：https://dify.zju.edu.cn/app/45cceeb9-149c-4d57-a2ec-0596bfd37029/workflow 。
- API页面：https://dify.zju.edu.cn/app/45cceeb9-149c-4d57-a2ec-0596bfd37029/develop 。
- 学校界面确认的API基础地址：https://dify-api.zju.edu.cn/v1 。
- Chatflow：开始→LLM→直接回复；学校模型deepseek-v4-flash-780k-local；记忆关闭，USER只引用本轮sys.query。没有在当前画布添加Code节点；validate-response.js是已测试的后端校验准备代码。
- 输出协议campus-admin-v1：status、intent、state_version、reply、changes、suggested_settings、evidence，另含protocol标识。

## 验证结果

12个学校模型预览用例及其返回均已通过本地执行校验：两参数与七参数设置、百分点相对调整、优化建议、执行保存的方案、过期方案、越界混合请求、模糊请求、不支持的灯时设置、缺失状态、新状态替换、绕过规则请求。校验器8组自动测试全部通过。

建议用例同时引用A平均队列/等待、A/B瞬时队列，提出自动配时和40%→60%绕行，说明B压力可能增加且效果待验证。没有宣称真实路况、已经执行或保证降幅。

不支持的灯时设置返回out_of_scope，而首选分类为invalid_request。两个状态都是拒绝执行；本地校验器兼容处理，无changes。此分类差异明确记录于platform-checks.json，不作为精确分类一致性通过的证据。

初次执行方案测试的evidence格式与校验器不一致，已修订系统提示词并复验通过。初次新状态样例只改了settings，未同步metrics中的比例；已用独立Simulation重新生成一致状态并复验。全部历史返回保存在platform-history-results.json，最终报告仅取每个用例最后一次复验。早期格式修订前返回另存platform-initial-results.json。

这些数据来自独立、固定种子的合成仿真样例，未读取或修改正在运行的共享沙盘。平台生成changes不表示参数实际生效；当前尚无网页执行闭环、真实管理员API调用和管理员/师生联动验收。

## 当前阻碍与后续

尝试打开发布操作时，浏览器自动审批拒绝了“发布管理员AI”。理由为用户授权了设计和测试，但没有明确授权最终发布。随后核验工作室仍显示“未发布”，没有用其他方式绕过拒绝。需用户明确同意发布后继续；本轮没有创建或复制任何Dify密钥。

管理员登录在本任务进行期间已由项目其它工作完成（AGENT.md §26/27）。下一阶段须接入现有admin-access会话、同源和CSRF保护；本机入口http://127.0.0.1:4174/login，校园网管理入口使用当前运行地址的HTTPS 4190。原4173是只读数据/访客服务，控制接口要求后端桥接密钥；不能恢复为匿名控制或把桥接密钥交给Dify/浏览器。

后端应每轮重新读取共享状态，校验AI返回，在共享仿真的同一次控制操作内比较runId与基准settings，再应用参数并读取实际结果。模型给出的成功/确认文案不能代替实际执行结果。只有登录的管理员能执行，校园网4180师生入口继续只读。

## 复核材料

- DIFY_ADMIN_PROMPT.txt：平台最终系统提示词。
- cases.json及cases/：12项输入与预期行为；运行node prepare-cases.mjs可用独立仿真重新生成。
- platform-results.json：每项最后一次学校模型返回。
- platform-checks.json：最终12项执行校验报告，含1项拒绝分类差异。
- platform-history-results.json、platform-initial-results.json：保留失败或样例修订前的记录。
- admin-ai-preview.png：真实学校平台预览截图。
- validator.test.mjs：node --test validator.test.mjs。
- check-platform.mjs：node check-platform.mjs。

本轮没有修改traffic-sandbox、dify-integration-lab、campus-access或admin-access代码、配置和进程；只新建admin-ai-design目录并补充项目记录。项目记录更新前另保存了当前AGENT.md，保留了其它任务新增的§26/27。


## 后续实际接入

用户要求接入网页并明确授权配置管理员应用密钥后，已完成发布、后端配置和真实9例接口测试、管理员网页执行/撤回及师生同源闭环。上述平台预览历史状态保留；最新证据见../admin-access/AI_VALIDATION.md。
