# Pro Max Design System Data

设计系统数据库，由 `promax-api.js` 读取并通过 `/api/promax/*` 暴露给前端。

## 数据来源

数据原始来源：[ui-ux-pro-max skill](https://github.com/) v2.5.0 的内置 CSV。
拷贝时间：2026-06-18

## 文件清单

| 文件 | 内容 | 字段 |
|---|---|---|
| `colors.csv` | 161 套配色方案 | Product Type, Primary, Accent, Background, Foreground, Card, Muted, Border, Notes |
| `styles.csv` | 50+ 风格系统 | Style Category, Keywords, Best For, Effects, Light/Dark Mode, AI Prompt Keywords |
| `typography.csv` | 57 组字体搭配 | Font Pairing Name, Heading Font, Body Font, Mood Keywords, Google Fonts URL, CSS Import |

## 更新

如需同步上游最新数据，重新拷贝即可：

```bash
cp ~/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/*/src/ui-ux-pro-max/data/{colors,styles,typography}.csv ./demo/data/promax/
```
