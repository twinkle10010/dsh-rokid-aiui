# aiui-dev skill

本目录存放 AIUI / Ink 的语法与 API 参考文档，由上游仓库维护，**不随本 npm 包分发**。

上游仓库：https://github.com/jsar-project/AIUI

skill 文档在该仓库里的精确路径是 **`skills/aiui-dev/`**，请把它整个复制到本目录（即本目录应直接包含 `SKILL.md` 与 `apis-*.md` 等文件，而不是再套一层目录）。

```sh
git clone --depth 1 https://github.com/jsar-project/AIUI /tmp/AIUI
cp -r /tmp/AIUI/skills/aiui-dev/. "$HOME/.dsh/.agent-presets/aiui-dev/skills/aiui-dev/"
rm -rf /tmp/AIUI
```

验证：本目录下存在 `SKILL.md` 即成功。
