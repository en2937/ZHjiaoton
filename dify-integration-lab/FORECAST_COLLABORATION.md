# 出发时间推演：协作入口

本次将此前仅在本机存在的完整出发时间推演纳入版本管理，并与现有“本地路线快答/学校AI高峰保护”接入口衔接。**已在本地完成Worker车辆查询优化：360人早八由179秒超时降至约63–70秒计算完成，138项回归通过。首次完整推演仍较慢；详见FORECAST_SPEED_VALIDATION.md。**

## 从哪里开始读

| 文件 | 职责 |
| --- | --- |
| `departure-intent.mjs` | 解析早八、明确课堂时刻、行程及“尽量晚出发/避开拥堵”目标 |
| `departure-forecast.mjs` | 独立Worker、任务合并、缓存、指纹和超时 |
| `departure-forecast-worker.mjs` | 重建课前背景车流、保存分钟快照、试行候选路线并选取建议 |
| `forecast-simulation.mjs` | Worker内入口前车查询索引，必须与原引擎逐字段等价 |
| `departure-periods.mjs` | 经确认的分时出发模板假设，不是分时实测数据 |
| `departure-objectives.mjs` | 默认最晚出发、避堵候选评分及结果短句 |
| `student-chat.mjs`、`server.mjs` | HTTP接入；出发推演与普通学校AI问答分支分离 |
| `sandbox-client.mjs` | 当前参数快照读取和普通路线状态读取 |
| `public/student/app.mjs`、`index.html`、`style.css` | 202短请求轮询、取消、出发建议卡片与失败反馈 |
| `../qa-policy/knowledge-scope.mjs` | 已确认地点/别名和数据范围；“东教上八点钟的课”等正常口语可进入推演 |
| `../traffic-sandbox/student-data.mjs`、`dist/engine.mjs`、`dist/route.mjs` | 共享路网、旅程边界、约1.2公里尺度假设及原仿真规则 |

现有地点：1为云峰学园，2为东教学楼。宿舍/碧峰/紫云、东教/东一至东六等按确认的两个端点理解，不是新增逐栋楼的实际路程数据。管理员与师生共享同义地点/缺数据校验，所以这次也包含其管理员接入及已有回归。

## 运行和验证

需要Node.js 20或更新版本；这些模块没有新增npm依赖。测试不需要学校Dify密钥、真实管理员账号或正式沙盘服务，不读取本机私有配置。请在独立副本运行，不要停止或重置现场服务。

在仓库根目录执行以下现有测试，先串行跑，避免把CPU争用误判为单次推演耗时：

```powershell
node --test --test-concurrency=1 dify-integration-lab/tests/departure-forecast.test.mjs dify-integration-lab/tests/forecast-objectives.test.mjs dify-integration-lab/tests/departure-http.test.mjs
node --test --test-concurrency=1 qa-policy/tests/aliases.test.mjs qa-policy/tests/uncertainty.test.mjs
```

需要完整师生端回归时，枚举`dify-integration-lab/tests/*.test.mjs`与`qa-policy/tests/*.test.mjs`运行。测试中的HTTP服务器使用临时端口、独立SharedSimulation与假模型；正式网页需要按项目启动说明自行配置本机服务及学校凭据。

API核心流程：

1. `POST /api/student/chat`带`question`、`trip`、`preference`、匿名`sessionId`、`forecastAsync:true`。
2. 首次返回202和`jobId`；按`retryAfterMs`（当前10000毫秒）携带`forecastJobId`轮询。
3. 完成返回200，`kind=departure_forecast`、`provider=sandbox-forecast`及后端计算数字。不能把这些数字描述为Dify生成或真实路况。
4. 参数/运行场景变更返回409；超时、繁忙、无可行方案分别处理，不让学校模型补造时间。

## 当前行为与性能边界

- 课堂前一小时独立重建；不倒带或修改管理员当前车流。
- 原引擎仍按0.1秒推进。默认从晚向前逐分钟检验，最晚可行分钟内按快照估计排序，不保证同分钟的全局最快。
- 避堵使用固定粗取样和局部细化，比较入口、信号、排队和慢行增加量，不保证连续时间全局最优。
- Worker单任务、内存256MB、硬时限180秒；页面等待上限约190秒。重建背景、深拷贝快照和反复试行仍可能耗时。
- 成功结果为进程内缓存：最多8条、5分钟。服务重启会丢失；目标、车型、时刻、设置、种子、运行/配置版本等变化不能复用旧结果。自然时间推进本身不使独立重建失效。
- 202短轮询能避免占住长HTTP请求，并不意味着计算已经加速。
- 已合入的`a995429`主要优化普通路线快答、学校AI队列/截止时间和状态读取；相关说明为`STUDENT_PERFORMANCE.md`，不能把其中普通问答耗时目标套到本推演Worker。

## 下一步优化的验收口径

优先分别测量背景重建、快照复制、候选试行和总耗时，再选择优化点。基线和优化版使用完全相同的参数、种子、行程、时刻与目标，区分首次计算、缓存命中和缓存失效；保留不可行判断、人数、入口队列、道路约束和正式状态不变检查。

优化索引/复用计算时复跑原引擎等价测试。若引入近似、减少候选或放宽求解目标，必须明确披露，不把较短计算时间冒充仍具有原来的最晚性/候选覆盖保证。不要只延长超时、编造固定出发时刻或用实时快照冒充未来推演。

方法详见`DEPARTURE_FORECAST.md`；历史基线见`DEPARTURE_FORECAST_VALIDATION.md`、`FORECAST_OBJECTIVES_VALIDATION.md`。历史验收中的参数、机器和耗时是当时记录，不保证在新机器或当前车流设置下重现同样秒数。

## 协作与部署边界

仓库不应包含`.env.local`、`private/`、账号、API密钥、私钥、证书运行配置、日志或完整私有检查点。协作者自行配置所需凭据；数值和HTTP隔离测试无需凭据。

本协作分支汇总完整推演、Worker提速和默认小时循环。功能在原开发机已验证；从GitHub下载并配置、启动后才会在另一台机器生效。上传操作本身不重启任何服务。主工作目录存在未完成的Git合并索引；本分支由独立工作副本整理，不改写该索引。合并前应分别备份、检查本地改动；不要直接使用破坏性Git重置来覆盖现场版本。

## 本次隔离验证（2026-10-18）

完整师生端与数据范围回归首轮覆盖131项，128项通过；3处旧测试与新规则不兼容，已在本协作分支修订并对涉及文件复验62项，全部通过。修订分别为：异步推演测试按服务端建议间隔轮询；学校429测试使用已支持的路线排队问题；批量数据范围测试隔离会话限流并显式关闭本地快答以检验模型拒答。正式限流、推演算法、时限和数据范围规则均未放宽。

原引擎/Worker索引混合车流逐字段一致检查通过，约98秒是该多场景回归测试的耗时，不是单次早八查询承诺。完整计算、缓存、异步HTTP、未知地点、普通快答、模型取消和高峰保护均有现有测试覆盖。


## 本版联合验证

完整师生端与数据范围138项通过；小时循环相关149项去重检查通过，详情见FORECAST_SPEED_VALIDATION.md与../traffic-sandbox/PUBLIC_HOUR_LOOP.md。默认小时循环与预测Worker分别管理运行轮次，循环后旧请求按既有指纹/版本校验失效。
