# 两端拒答验收

2026-10-17，实际项目目录 `D:\智慧交通比赛项目`。

## 独立测试

命令（项目根目录，使用既有 Node）：

```powershell
node --test qa-policy/tests/uncertainty.test.mjs dify-integration-lab/tests/student.test.mjs dify-integration-lab/tests/departure-http.test.mjs admin-access/tests/ai.test.mjs admin-access/tests/behavior-ai.test.mjs admin-access/tests/repair-ai.test.mjs
```

最终 **79/79 通过**，详见 [测试记录](evidence/tests.txt)。全部测试使用独立服务、内存状态或静止副本，没有向正式沙盘发送测试控制请求。

- 未知建筑、道路、C/AAA路口、未知修饰的教学楼、未知地点拼接、真实流量/建筑详情/实测收益拒答。
- 已知名词但事实缺失亦拒答；未知预测目的地不读取状态、不启动 Worker、不调用学校模型。
- 已知行程别名、常用提问措辞、网页快捷提问通过；已知地点与页面选择冲突不能静默借用默认行程。
- 两端模型非 ok/自报不确定的处理；无路线卡，无额外控制或新方案。
- 原有正常选路、后台预测、同源与CSRF、注销、非法/额外参数、版本变化、确认、执行回执、撤回和限流回归通过。

初测发现普通“北侧绕行比例”被范围判定误拦，已修正并回归。新增HTTP测试替身缺少 dispose 导致清理等待，补齐测试替身后通过；正式服务接口无此问题。

## 网页与学校接口

| 页面 | 实际输入 | 结果 |
|---|---|---|
| 正式师生4183 | 从云峰去图书馆，几点出发最好？ | 完全一致的拒答文本，无路线卡/预测 |
| 正式师生4183 | 从云峰学园到东教学楼，哪条路更快？ | 真实学校Dify建议北侧环岛线，后端提供三条路线的本轮估算值 |
| 正式师生最终部署后 | 我想去北教学楼上早八，几点出发最好？ | 指定拒答，没有将北教学楼视作东教学楼 |
| 独立管理员网页 | 图书馆路口绕行比例设为80% | 指定拒答，无控制或方案 |
| 独立管理员网页 | 分析当前A和B路口的拥堵。 | 学校Dify真实返回v2，正确引用A/B当前队列和原选路模式 |

管理员网页使用正式源码、独立认证Cookie命名空间及当前状态的静止副本；未使用正式管理员账号或重置正式沙盘。测试只提问，没有点击执行/重置/播放按钮。副本逐字段保持不变（`fixture-invariant.json`）。浏览器 error/warn 记录均为空；截图见 evidence/ 下四张初次验收图及 student-final.png。学校管理员实际原始回答已脱敏保存为 `admin-school-replies.json`，不含密钥。

## 部署与运行状态

- 只重启管理员4174/4190与师生4183；初次部署后又加载了正常措辞与地点组合边界补丁。最终管理员PID38556，师生PID53352；沙盘主进程一直为PID40012。
- 前后 runId `d677cac6-1072-4075-adba-e03568f1a93e`、instanceId `95bf7a73-2372-42ea-a01c-507e4e262769`、配置版本215及九项配置一致；运行4倍速保持，最终部署期间时间7158.350755→7167.055698秒连续推进。详见 `evidence/deployment.json`。
- 登录、权限、CSRF、控制校验、密钥、学校应用凭据、共享状态、预测引擎及问卷模型未改。管理员服务重启会使旧内存登录会话失效，需要重新登录；账号密码未改。
- 新私有完整检查点 `admin-access/private/qa-uncertainty-before.json`、`qa-uncertainty-deployment-before.json`、`qa-uncertainty-final.json` 均为只读手动保存，不是自动持久化，部署没有使用它们恢复或重置场景。
- 备份位置及回退步骤见 [README](README.md)。
