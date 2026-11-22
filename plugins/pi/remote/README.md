# remote — 从手机连接 pi-web

`/remote` 打开菜单；也可以用 `/remote lan` 或 `/remote tailscale` 查看连接地址，`/remote check` 检查绑定、端口和可达性，`/remote password` 管理 pi-web 登录密码。扩展不能改变正在运行的服务器的监听地址。

**不要把 pi-web 通过明文 HTTP 暴露到公网，也不要为远程访问关闭认证。** 仅在可信的私有网络（如受访问控制的 tailnet）使用，保留强密码。密码会写入 `<agentDir>/pi-web-remote.json`，请保护好该文件。二维码不含密码。

## 本地安装

在要启用插件的项目目录运行（把路径换成本地仓库的绝对路径）：

```sh
pi install --local "/path/to/agent-plugins/plugins/pi/remote"
```

只试一次可用 `pi -e "/path/to/agent-plugins/plugins/pi/remote"`。无需安装其他扩展。pi-web 默认显示网址；需要终端二维码时，可在本包目录运行 `npm install --legacy-peer-deps` 安装可选的 `qrcode-generator`，不装也能使用其他功能。

在本包目录用 Node.js 22.18+ 运行 `npm test`。
