# dsh-rokid-aiui

DeepSeek Harness 的 **Rokid AIUI 开发套件**：一个标准 host 插件包，`dsh plugin add` 一条命令装完
**插件本体 + 「AIUI 开发模式」Agent 预设 + 完整的 `aiui-dev` / `aiui-cloud-integration` skill**，重启即用。

- 左下角悬浮「AIUI 开发模式」按钮 → 可拖动预览窗（真实 Ink 浏览器运行时，视口 480×352）
- 右侧项目面板 → 文件树，点击文件查看源码（支持图片内联预览）
- 改项目里的 `.ink` / WXML / WXSS / JS → 预览**保存即自动刷新**（`aix preview --dev` 文件监听 + WebSocket 热更新），无需手动导出快照

## 0.3.0 变更

| # | 变更 | 说明 |
|---|---|---|
| 1 | 「浏览文件夹…」改用真实 Remote `directoryPicker/pick` | 原调用不存在的 `host.pickDirectory`，必定失败；附 `{ args: {} }` 负载并兼容 `string` / `{path}` 两种返回值 |
| 2 | 选择项目前先 `mkdir` 标记文件父目录 | 修 `ENOENT: <workspaceRoot>/.aiui/current-project.json` |
| 3 | **新增 Config schema**（schemastery） | 配置可校验、可在 Config 检视器里看到；字段全部可选，只写 `workspaceRoot` 也不会校验失败 |
| 4 | **`/api/aiui-*` 全部加 connection 信任围栏** | 先过 `requestRejection`（Host/Origin 校验 + 登录 cookie），否则本机任意页面都能读项目文件、拉起预览进程；同时强制方法（GET/POST） |
| 5 | **项目扫描支持嵌套**（`scanDepth`，默认 3 层） | 修「只扫一层」的已知限制：`<root>/<分组>/<项目>/app.json` 也能被发现，候选列表显示相对路径 |
| 6 | **预览进程生命周期加固** | 监听 `handle.done`：进程中途退出即作废旧 URL 并给出原因（按项目记错，切项目自动清空）；自动重试有 30s 冷却（显式重试立即绕过），心跳不会反复拉起进程；URL 识别兼容 `localhost`/stderr；启动超时可配（`previewStartTimeoutMs`，默认 15s） |
| 7 | **浏览器脚本外置为 `client/injected.js`** | 不再放在宿主模板字符串里（原方式禁用反引号、极易写坏）；注入时只替换两个占位符 |
| 8 | **预览失败态可见 + 重试** | 失败不再是一块永远空白的 iframe / 永远「启动中」：面板里直接显示错误原文并提供「重试」，按钮变红，5s 心跳自动纠偏 |
| 9 | **预设改为随包安装**（`preset.patch.yml`） | 「AIUI 开发模式」预设以当前格式的**声明行**随本包分发，装插件即出现在预设列表；同时提供 `legacyPresetSync`（默认关闭）兼容旧 Harness 的 `$DSH_HOME/.agent-presets` 目录格式 |
| 10 | skill 随包分发 | `preset/skills/` 内置 `aiui-dev` 与 `aiui-cloud-integration`，安装后无需再手动下载（出处见 `THIRD-PARTY-NOTICES.md`） |

> 0.2.0 及更早的安装流程是「装插件 → 手动复制 Agent 预设 → 手动下载 skill」三步；
> 0.3.0 起只剩一条 `dsh plugin add`。

## 目录结构

```
dsh-rokid-aiui/
├── package.json            # 插件 bundle（dsh.bundle.patch 指向下面两个 patch）
├── cordis.patch.yml        # 挂载控制台插件行（aiui-dev-console）
├── preset.patch.yml        # 挂载「AIUI 开发模式」预设声明行（preset-aiui-dev）
├── build.mjs               # esbuild 构建脚本：src/ → lib/
├── src/  lib/              # 插件源码（TypeScript）/ 构建产物
├── client/injected.js      # 注入网页的浏览器端脚本（宿主启动时读取并注入）
├── preset/
│   ├── skills/aiui-dev/            # AIUI/Ink API 参考 skill
│   ├── skills/aiui-cloud-integration/
│   ├── preset.yml                  # 旧目录格式预设（仅 legacyPresetSync 用）
│   └── agent.cordis.yml
├── THIRD-PARTY-NOTICES.md
└── LICENSE
```

## 前置条件

- 已安装 DeepSeek Harness 的 `dsh` CLI
- Node ≥ 20

## 安装

任选一种来源（`<name>` 换成 profile 名，例如 `web`）：

```sh
# 从 GitHub（推荐，可锁定 commit）
dsh plugin --profile <name> add github:twinkle10010/dsh-rokid-aiui

# 从 npm
dsh plugin --profile <name> add dsh-rokid-aiui

# 从本地目录 / tarball
dsh plugin --profile <name> add E:/path/to/dsh-rokid-aiui
pnpm pack && dsh plugin --profile <name> add ./dsh-rokid-aiui-0.3.0.tgz
```

装完**重启 dsh**（插件模块在进程内缓存）。之后新建会话时，预设列表里就有 **「AIUI 开发模式」**，
进入该模式即出现左下角按钮与右侧项目面板。

验证安装：

```sh
# profile 层同时包含两条 row：aiui-dev-console 与 preset-aiui-dev
dsh --profile <name> --dump-config | grep -E 'aiui-dev-console|preset-aiui-dev'
```

> 从 0.2.0 或更早升级：如果你此前按旧文档手工同步过预设目录
> （`~/.dsh/.agent-presets/aiui-dev/`），可以删掉它 —— 当前 Harness 不再读该目录，
> 预设已由本包的声明行提供。

> `/api/aiui-*` 路由已接入 connection 信任围栏：浏览器需带登录 cookie，且 Host/Origin 必须匹配。
> 直接用 `curl` 未认证访问会得到 401/403，这是预期行为。

## 使用流程

1. **重启 dsh**（装完插件后第一次必须重启）。
2. **新建会话** → 选择「AIUI 开发模式」预设。
3. 进入后，左下角出现「AIUI 开发模式」按钮、右侧出现项目面板；若尚未选过项目，会自动弹出「选择 AIUI 项目」对话框。
4. **选项目**：从候选列表选（嵌套项目会带上相对路径），或用「浏览文件夹…」选任意含 `app.json` 的目录。
5. 选完后：右侧加载文件树；点左下角按钮打开预览窗，实时渲染该项目。
6. **开发**：改项目里的 `.ink` / WXML / WXSS / JS，保存后预览自动热更新，无需手动刷新。
7. **切换项目**：点右侧面板「选择项目」重选（或让 agent 重写标记文件后刷新页面），预览服务自动重启指向新项目。
8. **预览起不来时**：按钮转为红色，面板中直接显示 `aix` 的错误原文，点「重试」立即重拉；5s 心跳会自动纠偏（自动重拉有 30s 冷却，避免故障项目反复拉起进程）。

> 项目标记：默认存于 `<workspaceRoot>/.aiui/current-project.json`，记录「当前项目」；换项目就是换这个文件的内容。

## 配置（可选）

在你的 profile 的 `cordis.patch.yml` 里按 id 覆盖（**整块替换该行的 `config`，不做深合并**，所以未写出的字段会退回默认值）：

```yaml
- id: aiui-dev-console
  config:
    # 扫描 AIUI 项目（含 app.json 的目录）的根目录；默认 $AIUI_WORKSPACE，再退到启动 dsh 时的目录
    workspaceRoot: 'E:/path/to/your/aiui/projects'
    # 存储「当前项目」的标记文件；默认 <workspaceRoot>/.aiui/current-project.json
    projectFile: 'E:/path/to/current-project.json'
    # aix CLI 入口与预览进程工作目录（默认自动解析 / workspaceRoot）
    aixCli: 'E:/path/to/aix-cli/dist/cli.js'
    aixCwd: 'E:/path'
    # 触发控制台显示的预设名称 / id
    presetLabel: 'AIUI 开发模式'
    presetId: 'aiui-dev'
    # 向下扫描层数（默认 3）与预览启动超时（默认 15000ms）
    scanDepth: 3
    previewStartTimeoutMs: 15000
    # 是否额外同步旧目录格式预设到 $DSH_HOME/.agent-presets（默认 false）
    legacyPresetSync: false
```

> 预设行 `preset-aiui-dev` 的 `config` 同样可按 id 覆盖（`name` / `description` / `order` / `plugins`），
> 覆盖是**整块替换**：需要完整重写 `plugins` 列表。

## API（供 agent 排查用）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/aiui-preview` | GET | 确保预览服务在跑；返回 `{running, url, error, project}`。`?retry=1` 跳过失败冷却立即重试 |
| `/api/aiui-project` | GET | 当前项目（读标记文件） |
| `/api/aiui-projects` | GET | 工作区里发现的 AIUI 项目（`scanDepth` 层内） |
| `/api/aiui-project-select` | POST | 选择项目 `{path}`；缺 `app.json` 时自动定位子/父目录 |
| `/api/aiui-project-tree` | GET | 当前项目文件树 |
| `/api/aiui-project-file` | GET | 单个文件内容（`?path=<相对路径>`；图片返回 data URL，GBK 自动回退） |

全部经 connection 信任围栏；非 GET/POST 返回 405。

## 开发 / 重新构建

```sh
npm i -D esbuild
node build.mjs          # 等价于 npm run build → 输出 lib/aiui-dev-console.js

# 本地没有 esbuild 时，可指向任意一份 esbuild 入口：
AIUI_ESBUILD=/path/to/node_modules/esbuild/lib/main.js node build.mjs
```

改完源码（`src/`）或浏览器脚本（`client/injected.js`）后重新构建，再到 profile 里重装本包并**重启 dsh**。
两个产物都可直接语法检查：`node --check lib/aiui-dev-console.js`、`node --check client/injected.js`。

## 第三方资源

`preset/skills/aiui-dev/` 下的 AIUI/Ink API 参考文档按 Apache-2.0 从上游
[jsar-project/AIUI](https://github.com/jsar-project/AIUI) 原样打包；出处与刷新方法见
`THIRD-PARTY-NOTICES.md`。`preset/skills/aiui-cloud-integration/` 为本项目自带文档。

## License

MIT
