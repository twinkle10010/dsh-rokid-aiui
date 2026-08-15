# dsh-rokid-aiui

DeepSeek Harness 的 **Rokid AIUI 开发套件**：一个 host 插件 + 一个 Agent 预设，让你在 Harness GUI 里直接开发、实时预览 AIUI（Ink 框架）应用。

- 左下角悬浮「AIUI 开发模式」按钮 → 可拖动预览窗（真实 Ink 浏览器运行时，视口 480×352）
- 右侧项目面板 → 文件树，点击文件查看源码（支持图片内联预览）
- 改项目里的 `.ink` / WXML / WXSS / JS → 预览**保存即自动刷新**（`aix preview --dev` 文件监听 + WebSocket 热更新），无需手动导出快照

## 目录结构

```
dsh-rokid-aiui/
├── package.json          # 插件 bundle（dsh.bundle.patch）
├── cordis.patch.yml      # 挂载插件行
├── src/  lib/            # 插件源码 / 构建产物
└── preset/               # 「AIUI 开发模式」Agent 预设（需手动复制）
    ├── preset.yml
    ├── agent.cordis.yml
    └── skills/aiui-dev/  # skill 从这里下载（见下）
```

## 前置条件

- 已安装 DeepSeek Harness 的 `dsh` CLI
- Node ≥ 20

## AI 自动安装清单

> 给 AI 助手看的完整流程。用户说「帮我安装 dsh-rokid-aiui」时，按顺序执行，不要跳过。`<name>` 是用户的 profile 名（通常 `web`）。

**AI 自动执行：**

1. 检查 CLI：`dsh --version`（源码版用 `pnpm dsh --version`）。失败就停下，先让用户装好 dsh。
2. 拉取本仓库（为了拿到 `preset/`）：`git clone https://github.com/twinkle10010/dsh-rokid-aiui`
3. 安装插件：`dsh plugin --profile <name> add github:twinkle10010/dsh-rokid-aiui`
4. 复制预设到 Harness home（按平台二选一）：
   - Windows PowerShell：`Copy-Item -Recurse dsh-rokid-aiui\preset "$HOME\.dsh\.agent-presets\aiui-dev"`
   - Linux / macOS：`cp -r dsh-rokid-aiui/preset "$HOME/.dsh/.agent-presets/aiui-dev"`
5. 下载 skill（命令见下文「下载 aiui-dev skill」），完成后确认 `~/.dsh/.agent-presets/aiui-dev/skills/aiui-dev/SKILL.md` 存在。

**AI 做不了、必须提示用户的两步：**

6. **重启 dsh**（插件要重启才生效）。
7. **新建会话并选择「AIUI 开发模式」预设**。

完成后这样回复用户：`装好了。请重启 dsh，然后新建一个会话选「AIUI 开发模式」，进入后选项目即可看到实时预览。`

## 1. 安装插件

三种方式任选其一（`<name>` 换成你的 profile 名，例如 `web`）：

```sh
# 从 GitHub（推荐，锁定 commit 更安全）
dsh plugin --profile <name> add github:twinkle10010/dsh-rokid-aiui

# 从 npm
dsh plugin --profile <name> add dsh-rokid-aiui

# 从 tarball
pnpm pack
dsh plugin --profile <name> add ./dsh-rokid-aiui-0.1.0.tgz
```

安装后 `dsh --profile <name> --dump-config` 应能看到 `# == dsh-rokid-aiui` 这一层。

## 2. 安装 Agent 预设

控制台只在会话的 Agent 预设名称匹配 `presetLabel`（默认 **「AIUI 开发模式」**，id `aiui-dev`）时才显示，所以还需要把本仓库的 `preset/` 放到你的 Harness home：

```sh
# Linux / macOS
cp -r preset "$HOME/.dsh/.agent-presets/aiui-dev"

# Windows (PowerShell)
Copy-Item -Recurse preset "$HOME\.dsh\.agent-presets\aiui-dev"
```

### 下载 aiui-dev skill（必做，否则 skill 缺失）

AIUI/Ink 的 API 参考文档**不随本仓库分发**，需要从上游 [jsar-project/AIUI](https://github.com/jsar-project/AIUI) 下载。该仓库里 skill 的**精确路径是 `skills/aiui-dev/`**（含 `SKILL.md`、`apis-*.md`、`components.md`、`wxss.md`、`design-system-green.md`），把它整个复制到预设的 `skills/aiui-dev/` 下即可。

**Windows (PowerShell)**
```powershell
git clone --depth 1 https://github.com/jsar-project/AIUI "$env:TEMP\AIUI"
New-Item -ItemType Directory -Force "$HOME\.dsh\.agent-presets\aiui-dev\skills\aiui-dev" | Out-Null
Copy-Item "$env:TEMP\AIUI\skills\aiui-dev\*" "$HOME\.dsh\.agent-presets\aiui-dev\skills\aiui-dev\" -Recurse -Force
Remove-Item "$env:TEMP\AIUI" -Recurse -Force
```

**Linux / macOS**
```sh
git clone --depth 1 https://github.com/jsar-project/AIUI /tmp/AIUI
mkdir -p "$HOME/.dsh/.agent-presets/aiui-dev/skills/aiui-dev"
cp -r /tmp/AIUI/skills/aiui-dev/. "$HOME/.dsh/.agent-presets/aiui-dev/skills/aiui-dev/"
rm -rf /tmp/AIUI
```

验证：`~/.dsh/.agent-presets/aiui-dev/skills/aiui-dev/SKILL.md` 存在即成功。

## 3. 配置（可选）

在你的 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: aiui-dev-console
  config:
    # 扫描 AIUI 项目（含 app.json 的目录）的根目录；默认 $AIUI_WORKSPACE，再退到启动 dsh 时的目录
    workspaceRoot: 'E:/path/to/your/aiui/projects'
    # 存储「当前项目」的标记文件；默认 <workspaceRoot>/.aiui/current-project.json
    projectFile: 'E:/path/to/current-project.json'
    # 触发控制台显示的预设名称 / id
    presetLabel: 'AIUI 开发模式'
    presetId: 'aiui-dev'
```

## 使用流程

1. **重启 dsh**（装完插件后第一次必须重启）。
2. **新建会话** → 选择「AIUI 开发模式」预设。
3. 进入后，左下角出现「AIUI 开发模式」按钮、右侧出现项目面板；若尚未选过项目，会自动弹出「选择 AIUI 项目」对话框。
4. **选项目**：从候选列表选，或用「浏览文件夹…」选任意含 `app.json` 的目录。
5. 选完后：右侧加载文件树；点左下角按钮打开预览窗，实时渲染该项目。
6. **开发**：改项目里的 `.ink` / WXML / WXSS / JS，保存后预览自动热更新，无需手动刷新。
7. **切换项目**：点右侧面板「选择项目」重选（或让 agent 重写标记文件后刷新页面），预览服务自动重启指向新项目。

> 项目标记：默认存于 `<workspaceRoot>/.aiui/current-project.json`，记录「当前项目」；换项目就是换这个文件的内容。

## 开发 / 重新构建

源码在 `src/`（TypeScript），构建产物 `lib/` 已提交（git 安装免构建授权）。改源码后重新构建：

```sh
npm i -D esbuild   # 只需一次
npm run build      # 等价于 node build.mjs
```

## License

MIT
