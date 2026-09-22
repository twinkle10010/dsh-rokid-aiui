# Third-Party Notices

## AIUI developer skill (aiui-dev)

The files under `preset/skills/aiui-dev/` (SKILL.md, apis-*.md, components.md,
wxss.md, design-system-green.md) are vendored verbatim from the upstream
repository:

- Source: https://github.com/jsar-project/AIUI
- Exact path: `skills/aiui-dev/`
- License: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
  (declared in the upstream `package.json`)

They are bundled with this package so that `dsh plugin add dsh-rokid-aiui`
installs a complete, self-contained preset without a separate download step.

To refresh the vendored copy after an upstream update:

```sh
git clone --depth 1 https://github.com/jsar-project/AIUI /tmp/AIUI
rm -rf preset/skills/aiui-dev
cp -R /tmp/AIUI/skills/aiui-dev preset/skills/aiui-dev
rm -rf /tmp/AIUI
```
