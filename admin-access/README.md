# 校园交通管理员登录

## 首次使用

1. 在服务器电脑运行根目录“启动项目.cmd”或“启动管理员登录.cmd”。
2. 打开 http://127.0.0.1:4174/login，在本机设置管理员账号和 12–128 位密码。没有预置通用账号或默认密码；密码不要发到聊天中。
3. 本机登录后进入原交通管理沙盘，可调整参数、播放、重置和导出。右上角可退出登录。原 http://127.0.0.1:4173/ 会跳转到登录入口。
4. 校园网管理员使用启动脚本显示的 `https://校园网IPv4:4190/login`。先以 Windows 管理员身份运行“允许管理员校园网访问.cmd”，只放行校园网 10.x 来源到本机 HTTPS 4190 端口。
5. 需要登录管理的其它设备须先安装本项目证书；普通师生继续用既有 HTTP 4180 沙盘与问答入口，不需要管理员账号或本证书。

## 管理设备的 HTTPS 证书

本项目没有公网域名，使用专用本地证书机构签发校园网地址证书。名称为 `Campus Traffic Admin Local CA`，证书带名称约束，仅适用于 localhost、127.x 和校园网 10.x 地址。它不是浙江大学统一认证或学校颁发的证书。

可分发文件是 `admin-access/public/campus-admin-ca.cer`；通过自己可信的文件传输方式交给管理设备，并核对 `certificate-info.json` 的 SHA-256 指纹。**不要分发 private 文件夹**。不要通过浏览器“忽略证书错误”来输入管理密码。

- Windows：在自己的管理电脑导入该证书到“当前用户 → 受信任的根证书颁发机构”。服务器电脑也可运行“信任管理员HTTPS证书.cmd”，核对指纹后按提示安装；脚本不自动扩大其它设备的信任。
- iPhone/iPad：安装证书描述文件后，在“设置 → 通用 → 关于本机 → 证书信任设置”启用该证书的 SSL/TLS 信任。步骤依据 [Apple 证书信任说明](https://support.apple.com/en-us/102390)。
- Android：在安全/加密与凭据设置中安装 CA 证书，名称和入口随系统版本及厂商变化。参见 [Google 安装证书说明](https://support.google.com/pixelphone/answer/2844832/add-amp-remove-certificates)。

叶证书有效期 90 天，启动准备脚本会检查有效期及当前地址。重新联网后若校园网地址变化，应重新准备证书并重启管理员入口，更新防火墙规则；根证书保持不变时，设备无需重新安装根证书。

## 权限与状态

- 只有登录的管理员会话才能调用管理员入口的控制接口。直接调用 4173 控制接口也需要仅在服务端保存的桥接密钥，浏览器不会获得这个密钥。
- HTTP 4180 继续只读，不能凭管理员 HTTPS Cookie 修改策略；HTTPS 4190 登录后允许管理操作。
- 密码采用随机盐与 scrypt 哈希存储。HTTPS 会话 Cookie 使用 Secure、HttpOnly、SameSite=Strict，控制与退出还校验同源及 CSRF Token。参考 [OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)和 [Node.js 加密接口](https://nodejs.org/api/crypto.html)。
- 闲置 30 分钟、或最长 8 小时后需要重新登录；仅浏览器后台轮询不会延长闲置时间。失败登录限制为同来源 15 分钟内最多 5 次，最多同时计算两次密码哈希。
- 会话保存在服务端内存，重启管理员入口后需要重新登录。沙盘仍由独立共享服务推进，关闭页面或退出账号不会暂停车流。
- 管理员账号是本项目独立账号，未接入浙江大学统一认证；当前支持一个管理员账号，多台设备可分别登录。

## 私有文件与恢复

`private/account.json` 仅含账号、盐和哈希；`private/bridge-key.txt` 是内部操作密钥；证书私钥也在 private 下。准备脚本限制该目录为当前 Windows 用户、SYSTEM 和 Administrators 访问。HTTP 静态资源白名单不开放私有文件。

忘记密码时，服务器拥有者应保留原 account.json 副本，在停止管理员入口后移走该账号文件，再启动入口并在本机重新设置账号。此恢复属于服务器维护，不能在远端匿名发起。不要重置仿真或覆盖 Dify 配置。

## 测试

在项目根目录运行：

```text
node --test admin-access/tests/auth.test.mjs
node --test dify-integration-lab/tests/integration.test.mjs dify-integration-lab/tests/student.test.mjs dify-integration-lab/tests/sandbox.test.mjs campus-access/tests/gateway.test.mjs
```

认证测试中的 HTTPS 请求使用测试证书机构做完整证书与地址校验，没有关闭证书验证。运行认证测试前，在测试副本生成该副本的 TLS 证书，不要读取或复制真实管理员密码。


## 管理员交通助手

登录后点击页头“交通助手”，可输入“把北侧绕行调到80%”“A路口切换自动配时”或“给一个缓解A拥堵的方案，先不要执行”。明确合法调参直接执行；建议显示变更内容，点击“执行方案”后才生效。可“撤回上次调整”；如果参数或场景已被再次修改，旧方案与撤回会失效。数据来自共享合成仿真，AI建议不代表已验证的优化效果。

独立管理员应用已发布；API基础地址https://dify-api.zju.edu.cn/v1，密钥只在private/dify-admin.json的apiKey字段或服务端DIFY_ADMIN_API_KEY环境变量中。不要放入前端、导出证据或聊天。配置文件可热读取，无需为替换有效配置而重启沙盘。每次重启管理员入口仍需重新登录。测试与恢复记录见AI_VALIDATION.md。

自动测试：node --test admin-access/tests/ai.test.mjs。真实学校接口在独立沙盘测试：node admin-access/tests/live-ai.mjs；真实部署只读检查：node admin-access/tests/live-web.mjs。browser-fixture.mjs必须显式--mock才使用测试回答，仅用于隔离UI回归，不能部署到产品入口。deploy-ai.ps1仅在服务身份核实后更新沙盘和管理员入口，保存完整检查点并逐字段核对恢复；校园网地址以runtime.json和实际网卡为准。
