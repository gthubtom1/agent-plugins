# pi-shell-guard

独立的 Pi 扩展：给模型发起的 `bash` 调用补充有限超时，在执行前检查常见搜索、删除和后台命令，并提供 Everything 文件名检索。无需修改 Pi 核心；升级宿主后仍从个人配置加载。宿主 API 变化仍需重新验证兼容性。

## 安装与版本

安装器以精确公共 release commit 和插件目录树摘要安装本包，**只注册 `plugins/pi/shell-guard`，不要安装整个 hub**。安装器的 shell-guard 选项默认关闭，明确启用后后续更新保留选择。源码试用安装不能替代冻结身份。

本包维护的版本为 **0.3.0**：统一使用 `allow/trash/block`，移除用户文本授权、删除等级和生成目录特权；用 AST 校验有限只读循环与单目标 `rm`。原样内置 unbash 3.0.0 的6个运行时文件和 ISC 许可证，无需 npm install、构建或运行时下载。

```json
{
  "packages": ["<absolute-frozen-package-directory>"],
  "shellGuard": {
    "timeout": {"fast": 60, "default": 120, "heavy": 900, "ceiling": 1800},
    "everything": {
      "esPath": "<absolute-path-to-es.exe>",
      "guiPath": "<absolute-path-to-Everything.exe>",
      "autostart": true,
      "maxResults": 50
    }
  }
}
```

实际参数来自公开 `pi.getSettings()`；环境变量 `PI_SHELL_GUARD_ES` 可覆盖 Everything CLI 路径。`guiPath` 必须是用户明确配置的 Everything GUI 绝对路径；`autostart: true` 时，只有在 CLI 明确报告 Everything IPC/服务不可用后，插件才会用 `shell:false` 启动该 GUI 一次，在有界启动调用结束后对同一组 CLI 参数重试一次。它不会启动任意程序，也不会把启动失败当成空结果。Everything 和 ES 由用户自行提供，本包不下载或捆绑它们。Linux 上没有 Everything 时，shell 检查继续工作，文件名工具明确报告后端不可用。

## 运行方式

- `tool_call`：在 `bash` 执行前判断，拒绝操作、设置有限 `timeout`，或将符合条件的 `rm` 改写为本包的 TEMP helper 命令。预检只分析和改写参数，不访问目标文件系统；后续处理器仍可阻止调用。通过 Pi `ctx.executeTool()` 发起的嵌套 bash 调用也经过该事件；`parentToolCallId` 只表示工具嵌套关系，不用于判断代理角色。
- `before_agent_start`：注入简短策略；不捕获用户输入，不保存会话授权，不调用确认 UI。
- `/shell-guard status`：显示当前已加载版本、模块路径和策略边界。它不启动模型或检查磁盘全盘。
- `search_files`：用绝对 ES 路径、独立 argv 和15秒截止时间查询 Everything。最多200条、输出24KB；失败和空结果明确区分。

不再把搜索规则分别写回 reverse领域规则或四个宿主适配器。本插件的行为和提示随同一包版本发布。

## 删除和 TEMP 回收

主代理和子代理使用同一条删除规则：单条 `rm`、单个字面目标、目标位于当前项目（会话 `ctx.cwd`）内且不属于保护路径时，shell-guard 将 Bash 参数改写为 Node helper 命令。只有实际执行 Bash 时，helper 才会复查路径并将整个文件/目录一次 rename 到 `<project>/TEMP/<unique-batch>/<original-name>`，输出恢复位置；原始 `rm` 不执行。可处理 `rm file`、`rm -f cache`、`rm -rf old-cache` 这类普通项目清理。之后你可以在文件管理器中检查并手动清空 TEMP。

插件会在移动前重新检查项目边界、源目标、父路径与 TEMP 路径。根、系统、主目录、凭据、`.git`、TEMP（含大小写别名）、已知数据库路径/文件名（如 `db`、`data`、`*.db`、`*.sqlite`、`*.sqlite3`）、项目外路径、目标/父路径链接、通配符、含 `..` 分量的原始目标（含 Windows 尾空格别名）、多目标、包装器和复合删除命令都不会自动移动；`./cache` 仍可处理。目录内容不递归扫描；整体 rename 保留其中的字节和链接，不保证识别任意名称的数据库。目标碰撞或 rename 失败（包括跨设备）会报错，不使用复制后删除作为回退。

主代理、独立子会话和嵌套调用一致：允许、移入 TEMP 或立即阻止，均不打开 UI。字面列表上的有限 `for/echo`、`for/if/test/printf` 支持空白、多行、引用和 Unicode 路径；也支持 `[ -f "$p" ]` 等简单一元文件/字符串检查、所有分支都只读的 `if`，以及参数明确的 `cat/head/stat`。数值比较、`-v` 测试、动态列表、命令/进程替换、未知调用、赋值、写入/重定向、后台任务和循环内删除均拒绝；printf 格式必须是字面值，禁止 `-v`、`%n` 和动态格式。解析错误拒绝执行。

`TEMP` 是恢复区，不是自动清理机制。移动失败时原始 `rm` 不会继续执行。shell-guard 不会自动清空 TEMP；识别到的其他删除工具和内联删除会阻止，任意脚本的内部行为仍不属于完整控制范围。

## 搜索与长任务

默认超时分为60/120/900秒，有效显式正数保留在上限内，超过上限时夹到配置 ceiling（最多1800秒）；缺失或无效值使用分类默认值，超时结果写入实际调用参数。分类是启发式的，耗时长的合法任务应明确预算与生命周期。旧 `shellGuard.rm` 授权/分档设置不再生效；显式 `shellGuard.enabled: false` 可整体关闭 Bash 策略，仍保留有限超时。

常见整盘 `find` / 递归 `grep` / `rg` / `dir` / `Get-ChildItem` 等形式会被拒绝，包装命令也需检查。`find` 不使用 ripgrep的忽略规则；`| head` 只限制可见输出，不是遍历预算或进程清理保证。Git Bash的根目录与挂载盘符由具体安装决定，不能把每一种 `/` 形式解释为已扫描全部盘符。

常驻服务、交互等待与后台进程需要单独管理。后台只关闭stdin或只重定向一个输出流仍可能保留执行器管道；多个后台任务分别检查，不能借同一串命令中另一个任务的重定向通过。

## Everything 的结果含义

普通查询使用 Everything 的搜索语法，通常是子串匹配。精确文件名可用 `regex: true`，例如 `^es\\.exe$`；目录限制用 `path`。内容搜索继续使用限定目录的 `rg`。

索引可能未覆盖某个卷、排除目录或尚未更新；有限条数返回也可能没有包含目标。因此空结果、返回上限、后端错误**都不能证明文件不存在**。CLI不可用或返回无效JSON会报错，不能把错误文本当成文件列表。

## 保护范围

这是常见命令的**预执行护栏**，不是操作系统沙箱。任意程序/脚本、其他扩展的直接进程调用、直接用户 `!` shell、MCP内部命令或其他文件写入工具不等于已经被完整控制。串接、解释器、编码脚本和运行时计算无法仅凭字符串完全验证。判断异常会阻止该次bash调用；评估失败不会退化为放行。路径复查与 rename 之间不是操作系统级原子保护，不能防御恶意并发替换路径。

已安装旧模块可能仍被宿主进程缓存。使用新的冻结目录后检查 `/shell-guard status` 的实际模块路径，不能仅凭配置改动声称已加载。必要时重载/重启并重新验证；不要为测试停止用户正在使用的服务。

## 验证

```text
node --test test/*.test.mjs
```

`PI_SDK_DIR` 指向调用方已有的 Pi SDK 后可执行 `node scripts/verify-sdk.mjs`。测试使用确定性假provider和惰性bash执行器；SDK 危险负例和改写的 helper 都不运行真实命令，实际 Bash/helper 的字节恢复由独立临时夹具单元测试覆盖。可选 `PI_SHELL_GUARD_ES` 启用真实只读索引查询；缺少时明确记录未验证，不能算作成功。

历史681条回放仅是一批字符串判定结果，没有完整的人工期望标注；“全部放行”不等于零误判或没有绕过。0.2.0用有明确正负期望的测试与实际SDK事件验证取代该完成依据。发布前分别记录策略、宿主接线、索引可用性和安装/回滚结果。
