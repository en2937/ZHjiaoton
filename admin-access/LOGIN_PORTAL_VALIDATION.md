# 登录成功后的地图镜头过渡

2026-10-15，按用户要求实现“登录窗口渐隐 → 背景地图清晰并放大 → 地图缩小进入管理员页面”。

## 实现

- 仅在登录/首次设置API返回成功后触发。先加载并解码既有3875×3379原图（1.61MB）；成功后窗口、页脚和背景控制在340ms内渐隐，背景遮罩淡出、固定模糊从4px/手机3px降到0，地图在1.18秒内放大至1.65倍并居中。0.93秒时完全清除滤镜，避免清晰阶段继续被滤镜栅格化；正常登录背景仍为轻量900px缩略图。原图准备失败或超过1.8秒则直接正常导航。
- 保留正常的 `location.replace('/')` 导航。只在当前标签页sessionStorage中短暂保存固定原图路径 `/assets/Map.png`、矩形和视口大小，version2严格拒绝其它路径与旧缩略图数据；12秒过期，不包含账号、密码或认证令牌。
- 管理员页模块在head中以render blocking加载，首屏用原图img创建覆盖层。原图解码、后端首个状态和画布都绘制好后，将该图在1.05秒内缩小到画布里实际底图的位置，再交接给真实Canvas路网、车辆与标签。几何按原图实际宽高比计算。
- 两页使用原生跨文档View Transition衔接；支持的浏览器在导航期间保留上一幅地图画面。其它浏览器仍有两端GSAP动画，但原生页面切换不保证完全无缝。
- 过渡完成后移除覆盖层并解除inert；减少动态效果直接正常登录，刷新/直达管理员页不重播。存储不可用、数据非法/过期、视口尺寸不匹配时跳过交接；地图等待超时3.5秒、Esc、缩放视口或切到后台时移除覆盖层，正常界面仍可用。
- 认证请求、失败提示、CSRF、Cookie、服务器权限和实际仿真均沿用原实现。前端认证脚本仅在成功导航前增加动画等待，成功后按钮保持禁用，避免重复提交。没有增加服务器路由或修改CSP；动画资源本身无需重启，收尾沙盘中断后的恢复见下节。

## 高清放大调整验收

- 24项自动化检查通过：交接/原图解码/失败与超时回退8项，公共动效4项，绘制缓存3项，原认证与Cookie隔离9项。初次测试替身缺少setItem、缓存测试遗漏VM启动开关，均修正后复验；未更改认证实现。
- 隔离浏览器1440×900录23帧，390×844录39帧；登录放大和入场缩小阶段均确认图像naturalWidth=3875、naturalHeight=3379。峰值scale=1.65，桌面放大图约3230px宽，最终滤镜为none；原先1.22倍约2390px。落位后无遮罩或inert残留，手机无横向溢出。
- 错误密码保留原表单与可重试按钮；刷新不重播。减少动态效果用fixture替身验证，约623ms正常导航、无地图镜头。浏览器警告/错误日志为空。实体手机、系统偏好切换、其它浏览器及FPS未实测。
- 本次只更新前端源与构建产物，无服务重启、调参或正式登录操作。前后运行身份、配置与保护源码核对见 `../ui-validation/login-portal-hd/before.json`、`after.json`；私有完整检查点使用新的login-portal-hd文件名，不覆盖原记录。
- 修改前备份：`../_backup/20261015-143622-before-login-portal-hd/`。实际截图序列、JSON与GIF保存在 `../ui-validation/login-portal-hd/`。

![高清放大镜头预览](../ui-validation/login-portal-hd/login-transition.gif)

## 首轮1.22倍版本验证（历史）

- 33项检查通过：原渲染与车辆平滑17项、公共动效生命周期4项、新交接数据/几何3项、原登录与Cookie隔离9项。生成模块语法和diff检查通过。
- 独立真实HTTP认证，使用专用Cookie测试账号。错误密码显示原错误，窗口opacity=1、inert未设，按钮可重试。
- 1440×900录得29帧截图：窗口opacity从1到0；地图blur从4px到0；导航后地图宽度从约2388px连续缩至约530px，再移除覆盖层。原生导航期间观察到地图画面保持，没有录得空白闪屏。截图间隔不是设备FPS测量。
- 390×844录得38帧，包含9帧缩小阶段；落位后页面宽375px、视口390px，无横向溢出、无遮罩或inert残留。刷新不重播，管理员和手机浏览器错误/警告日志为空。
- 减少动态效果使用隔离媒体查询/CSS替身验证：登录页标记true、背景控制隐藏，成功后约636ms完成正常导航，没有缩小覆盖层。未修改操作系统偏好；实体手机、虚拟键盘、其它浏览器和真实系统偏好切换未实测。
- 正式沙盘在本轮开始验收前保存了完整私有检查点 `private/login-portal-before.json`。收尾从该检查点恢复后，原runId、配置版本、参数、出发场景、运行状态及倍速逐项比对；恢复生成新的实例ID。结果见 `../ui-validation/login-portal/before.json`、`after.json`。未操作正式账号或正式参数；四份正式资源与构建输出一致，七份后端/引擎/认证源码哈希未改。

## 收尾服务中断与完整检查点恢复

最终核对时4173返回ECONNREFUSED，独立测试进程也停止，原因未确认；管理员39472、师生39380与校园网40368仍监听，未停止它们。

先离线恢复完整检查点并按实际传输JSON逐字段比对simulation，确认2352.9896899990395秒、209辆车及历史完全一致后，使用独立隐藏进程启动原沙盘server.mjs，PID28356。保留runId `64549913-b9e5-4678-b110-6ba2db568500`、settingsRevision4、29/70/72/6/95/8/adaptive、grouped/覆盖55%、survey/08:00/07:00与4倍运行；新instanceId `91920385-cc93-4af9-8a05-bad9ad063379`。

**恢复的是验收前完整检查点，不是中断瞬间状态；检查点之后未保存的进度未恢复。** 恢复记录 `../ui-validation/login-portal/recovery.json`，另存完整私有收尾包 `private/login-portal-final.json`。没有新增自动保存、自动重启或运行守护。

## 维护与恢复

公共交接源：`../ui-motion/login-portal.mjs`。登录源：`client/login-form.mjs`、`client/login-motion.mjs`、`client/login.css`。管理员覆盖层CSS位于 `public/admin.css`，落位调用位于沙盘app的draw末尾。

修改后在项目根目录执行：

```powershell
node ui-motion/build.mjs
node admin-access/build-login.mjs
```

修改前副本：`../_backup/20261015-133835-before-login-portal/`，按原目录结构保留。截图、逐帧数据与预览：`../ui-validation/login-portal/`。预览GIF来自独立测试浏览器截图，并非另一套动画实现。

![登录镜头预览](../ui-validation/login-portal/login-transition.gif)

浏览器能力依据：[script blocking](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script#blocking)、[跨文档视图过渡](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@view-transition)。
