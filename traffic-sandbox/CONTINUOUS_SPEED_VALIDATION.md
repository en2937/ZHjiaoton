# 车辆连续速度修复验收

日期：2026-10-14。

## 原因与实现

仿真约100ms推进，浏览器约150ms轮询，一次快照会包含一步或两步变化。上一版按每次接收间隔完成位置追赶，导致本来匀速的车辆出现周期性速度波动。

此次改为350ms缓冲并按仿真时间/播放倍速推进独立显示时钟。新包追加到缓冲，不重启车辆过渡；沿原道路以位置与速度相连的单调三次曲线采样，纵向速度和横向变道连续，始终约束在已确认数据区间，不外推。

新入场/离场、安全改道、等待停车、暂停重置、变速、断连/后台返回和减少动态效果均保留处理。缓冲耗尽时等待更多确认数据后恢复。动画会短暂落后于最新统计与灯色；首次加载或重新收集数据时可能先短暂停留约350ms。

仅改`dist/shared-client.mjs`及运动测试。网络轮询/鉴权控制客户端逐字保持原样；app静态缓存、交通引擎、路网、Dify和权限代码未改动。

## 验证

- 14项车辆运动检查通过，包括100ms/150ms节拍匀速、接收抖动、解析连续加速/减速、节点速度连续、停车不越界与缓冲不足恢复。
- 3项现有静态缓存/绘制调度测试通过。总计17项通过。
- 从实际运行服务读取32个快照，46辆全程保持恒定v且无变道的车辆可用于前后相同数据重放。60Hz采样时钟下，旧模块平均速度变异系数约45.55%，新模块低于0.001%。详细数据为`speed-comparison.json`。这里只比较动画沿道路进度的速度波动，不表示浏览器实测FPS、实地车速或全部车型/负载效果。
- 真实浏览器地图与实时状态正常，点击“观察A”可放大，错误日志为空；截图与DOM检查在证据目录。
- 本机/校园网的4个模块资源与部署文件相符，C端runId和参数同源，HTTPS健康检查保留项目CA及地址校验。引擎和道路文件哈希一致。
- 服务未重启；部署前后runId和参数保持不变、仿真时间继续增长。未进行本轮实体手机或跨设备运动观感验收。

## 文件与回退

备份：`D:\智慧交通比赛项目\_backup\20261014-104521-before-continuous-speed`。恢复其中的shared-client.mjs及对应运动测试可回退，再刷新网页。

证据：`traffic-sandbox/evidence/continuous-speed/`下的captured-motion.json、speed-comparison.json、deployment-validation.json、live-validation.json、browser-validation.json及continuous-speed.jpg。

```powershell
node --experimental-vm-modules --test traffic-sandbox/tests/vehicle-motion.test.mjs traffic-sandbox/tests/render-cache.test.mjs
```

VM参数仅用于实际app代码在DOM/Canvas测试替身中的回归；生产网页不依赖VM。
