# aiui-dev skill

本目录存放 AIUI / Ink 的语法与 API 参考文档，**随本包分发**（`dsh plugin add dsh-rokid-aiui`
安装后即可用，无需另行下载）。它们由上游仓库维护，按 Apache-2.0 原样打包，出处见
仓库根目录的 `THIRD-PARTY-NOTICES.md`。

上游仓库：https://github.com/jsar-project/AIUI

skill 文档在该仓库里的精确路径是 **`skills/aiui-dev/`**，刷新时整目录覆盖本目录
（本目录应直接包含 `SKILL.md` 与 `apis-*.md` 等文件，而不是再套一层目录）：

```sh
git clone --depth 1 https://github.com/jsar-project/AIUI /tmp/AIUI
rm -rf preset/skills/aiui-dev
cp -R /tmp/AIUI/skills/aiui-dev preset/skills/aiui-dev
rm -rf /tmp/AIUI
```

验证：本目录下存在 `SKILL.md` 即成功。
