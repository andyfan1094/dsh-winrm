# dsh-winrm — Windows 远程管理插件（WinRM / PowerShell Remoting）

仿照 [dsh-ssh](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-ssh) 开发的 DSH 插件：用 Windows 原生的 **WinRM / PowerShell Remoting** 协议远程管理 Windows 服务器，**目标机不需要装 OpenSSH**。

作者：**andyfan1094**（独立插件，不属于 linxin666 插件家族）。

## 功能

| 面 | 说明 |
| --- | --- |
| GUI 侧边栏「Windows」入口 | 居中面板：**主机** / **控制台** / **服务** / **进程** / **传输** 五个页签 |
| Agent 工具 | `winrm_list` `winrm_exec` `winrm_service` `winrm_process` `winrm_upload` `winrm_download` `winrm_cluster` |
| PowerShell 控制台 | WebSocket 命令会话（每条命令通过 pywinrm 执行，输出实时返回） |
| 服务管理 | 列出 / 启动 / 停止 / 重启 / 改启动类型（自动/手动/禁用） |
| 进程管理 | 列出（CPU/内存/路径）/ 按 PID 结束 |
| 文件传输 | base64 分块读写，**不依赖 SMB**，任意路径可传；上传自动建目录 |
| 集群 | 一条命令并发跑多台主机（按 aliases / environment / tags 过滤） |

## 认证与传输

- 使用 Windows 本机 `pywinrm` 的 NTLM/SPNEGO 实现（目标服务器广告 `Negotiate` 时兼容性更好）
- 本地账户可写 `Administrator`；域账户可写 `DOMAIN\user` 或 `user@domain`
- 本机需要可调用 Python + `pywinrm`（当前环境已安装；其他机器可执行 `python -m pip install pywinrm`）
- 传输：HTTP(5985) 或 HTTPS(5986)；HTTPS 可勾选「接受自签名证书」
- 中文输出不乱码：所有命令走 **UTF-8 base64 信封**（`-EncodedCommand` + `Out-String` 包装），绕过 WinRM 传输的代码页问题

## 目标机准备（一次性）

在要管理的 Windows 机器上，**以管理员身份**运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\enable-winrm.ps1
```

脚本自动：启用 WinRM 服务与 5985 监听 → 开放 Basic/Negotiate 认证 → 允许 HTTP 明文（内网）→ WinRS 内存上限 512MB → 放行防火墙 → 打印本机 IP。

> ⚠️ **安全**：HTTP + Basic 是明文，仅限受信内网；公网请配置 HTTPS + 自签名证书，并在插件里勾选「接受自签名证书」。密码明文存于本机 `~/.dsh/dsh-winrm.json`（0600 权限，仅当前用户可读），插件界面永不回显。

## 安装（本机 dsh web）

已在 `D:\项目\dsh-winrm` 开发，通过 profile 链接安装：

```bash
dsh plugin --profile web add link:D:\项目\dsh-winrm
```

安装后 **重启 dsh web**（退出再启动 `dsh web`）使插件生效。侧边栏出现「Windows」入口；对话中可直接用 `winrm_list` 等工具。

### 从源码构建

```bash
cd D:\项目\dsh-winrm
pnpm install
npm run build     # tsc 声明 + tsdown 宿主/客户端打包 + postbuild 包装
```

## 使用示例（agent 工具）

```
winrm_list                                        # 列出已配置主机
winrm_exec  alias=web1 command="Get-Service | Select -First 5 | Format-Table"
winrm_service alias=web1 name=W3SVC action=restart
winrm_process alias=web1 action=list
winrm_process alias=web1 id=1234 action=kill
winrm_upload alias=web1 localPath=D:\a.zip remotePath=C:\temp\a.zip
winrm_download alias=web1 remotePath=C:\logs\app.log localPath=D:\app.log
winrm_cluster command="Get-Date" tags=prod
```

## 架构

```
src/
  index.ts            Cordis 插件入口（webServer/tools/systemPrompt 挂载 + 设置面板 + 公告）
  engine.ts           WinRmEngine 门面：exec / services / processes / ls / upload / download / console / cluster / test
  store.ts            ~/.dsh/dsh-winrm.json 主机存储（原子写，0600）
  protocol.ts         宿主↔浏览器 wire 类型
  powershell.ts       PS 片段构造器（UTF-8 信封 / 服务 / 进程 / 目录 / 分块读写）
  routes.ts           /api/dsh-winrm 路由族 + 控制台 WebSocket（loopback 围栏）
  tools.ts            7 个 winrm_* agent 工具
  engine/client.ts    pywinrm bridge：凭据 stdin 传入、UTF-8 信封、分块传输
  engine/console.ts   流式 PowerShell 控制台会话
  client/             浏览器半：侧边栏入口 + 居中面板（5 页签）
scripts/
  enable-winrm.ps1    目标机一键启用 WinRM
  postbuild.mjs       客户端产物 __ModuleLoader__ 包装
```

传输依赖本机 Python 的 [pywinrm](https://github.com/diyan/pywinrm)（NTLM/SPNEGO）；密码通过 stdin 传给 bridge，不出现在 Python 进程参数中。

## 已知限制

- 控制台是命令会话，不保持 PowerShell 变量和当前目录状态；每条命令独立执行
- WinRM 单次响应受 150KB 信封上限约束，传输按 48KB 分块，大文件较慢（每块一次往返）
- 单命令默认 60s 超时，可传 `timeoutMs`
- 目标机需已启用 WinRM（见上）；HTTP 明文 Basic 不应用于公网
