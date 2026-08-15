# aiui-dev skill

这里的 AIUI / Ink 语法与 API 参考文档来自上游仓库：

https://github.com/jsar-project/AIUI

请把该仓库里的 skill 文档复制到本目录（`skills/aiui-dev/`）：

- `SKILL.md`
- `apis-*.md`、`components.md`、`wxss.md`、`design-system-green.md` 等

示例：

```sh
git clone https://github.com/jsar-project/AIUI /tmp/AIUI
cp -r /tmp/AIUI/<skill 所在目录>/* ~/.dsh/.agent-presets/aiui-dev/skills/aiui-dev/
```

> 本 npm 包不随附这些文档（它们由上游维护），请从 jsar-project/AIUI 获取。
