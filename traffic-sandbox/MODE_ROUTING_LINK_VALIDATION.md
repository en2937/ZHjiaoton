# 出发模式与选路规则自动对应

2026-10-15。管理员入口：http://127.0.0.1:4174/，刷新后显示最新界面。

| 出发模式 | 自动采用的选路规则 |
| --- | --- |
| 模拟固定需求 | 原选路规则 |
| 仿真模式 | 认知与意愿分组 |

“选路规则”改为只读结果，无单独下拉。后端统一约束；矛盾的单独选路设置原子拒绝，不会顺带修改其他参数。引导覆盖及策略目标保持原值；固定需求隐藏覆盖控件，仿真模式再显示。出发模式/时段/观察起点仍按既有操作自动准备新场景，不增加按钮。后台准备会先用正确选路规则，再推进到观察起点。重置、固定预设及恢复同样遵守对应关系；刷新/轮询不重新开始。

## 修改与备份

运行代码修改shared-simulation.mjs、dist/app.mjs、index.html、style.css；另外更新三份相关原测试、新增mode-routing-link.test.mjs及ROUTE_BEHAVIOR.md，共9项部署文件。引擎、路网、车辆运动与缓存、师生适配器、认证/权限、管理员AI及Dify提示词原文件保持。新增behavior.modeSource=departureScenario供同源状态读取。

修改前备份：D:\智慧交通比赛项目\_backup\20261015-103510-before-mode-routing-link。AGENT记录更新前另存最新副本。旧快照规则若不匹配当前出发模式，恢复时只修正规则并增加配置版本，保持时刻、身份、位置、车型和目的地，不清空车流、不越过分岔约束；匹配快照原样保留。

## 独立验收

95项不同检查最终通过：目标测试28、原仿真/曲线/动画缓存55、原管理员AI12。隔离环境最初缺少公共模块及本机网络权限，补齐后相应测试复验通过；未以修改生产认证或放松校验绕过。覆盖固定/仿真往返、带观察时间的后台准备与连续参考场景一致、重置/预设、参数保留、矛盾设置拒绝、旧快照一次升级及旧方案失效、暂停/倍速、身份稳定和人数/路径原检查。

独立真实网页使用专用Cookie：固定显示原规则；仿真显示分组；观察07:01准备后师生同源；刷新保留runId和时刻；切回固定恢复原规则，覆盖55%原值保留且控件隐藏。网页无错误/警告。正式访客页再次核对只读规则、无旧下拉、模式对应正常；未在正式场景中执行模式切换测试。本轮未重新联调学校大模型，也未改变Dify配置。

## 正式运行状态

完整私有检查点admin-access/private/mode-routing-link-deployment.json：3707.497617997903秒、80辆；runId 683c3bce-a7ef-4283-9f95-e652ba27433e，配置版本179，原4倍速及原播放状态保留。恢复后原simulation全部字段深比较一致，无额外改道、丢车或初始化；当前为survey/grouped，覆盖50%，其余原参数保持，再恢复运行。

只重启沙盘服务；管理员/HTTPS、师生和校园网网关进程均保持，未影响内存登录。9文件部署哈希一致；本机/校园网师生同runId、参数和时钟基准；登录页、匿名地图与匿名AI/控制权限通过。未新增自动持久化。

证据：evidence/mode-routing-link/下的tests-validation.json、targeted-tests.log、regression-tests.log、ai-regression.log、browser-http.json、browser-validation.json、formal-browser-validation.json、截图、deployment-validation.json、process-validation.json、production-validation.json。日志保留了已解决的测试环境失败，最终通过以汇总及对应复验为准。
