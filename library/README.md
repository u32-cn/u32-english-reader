# 资料库规范（en-reader library v1）

资料库就是**一份 JSON 索引文件的可访问网址**。前端只认这个网址，不关心它放在 GitHub、对象存储还是本机目录。

本目录 `library.json` 是可直接参考的完整示例。

## 结构

三级固定：**系列 → 书 → 文章**。阅读器的浏览窗口在它前面再加一层「资料库」，构成四级树，因此一个库内部不必再写库名层级。

```json
{
  "name": "轻读示例资料库",
  "description": "可选，一句话说明",
  "series": [
    {
      "name": "每日新闻",
      "books": [
        {
          "name": "2026年11月",
          "articles": [
            { "title": "Small Robots, Big Farms", "level": "B1", "file": "articles/small-robots-big-farms.json" }
          ]
        }
      ]
    }
  ]
}
```

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 否 | 资料库名称，缺省显示「未命名资料库」 |
| `description` | 否 | 一句话说明，仅作文档用途 |
| `series` | **是** | 非空数组，系列层 |
| `series[].name` | **是** | 系列名 |
| `series[].books` | 否 | 书层数组，缺省视为该系列无书 |
| `books[].name` | **是** | 书名 |
| `books[].articles` | 否 | 文章层数组 |
| `articles[].title` | 否 | 文章标题，缺省用 `file` 原样显示 |
| `articles[].level` | 否 | 难度标签，如 `A2` `B1` `B2`，只用于展示 |
| `articles[].file` | **是** | 文章 JSON 的路径，相对索引文件所在 URL 解析 |

## 三条硬规则

1. **文章格式沿用 [schema.md](../schema.md)**：索引只描述目录结构，不描述文章内容，工具不改写文章。
2. **`file` 相对索引文件解析**：`library.json` 在 `https://x.com/lib/library.json`，`file: "a/b.json"` 即 `https://x.com/lib/a/b.json`；也允许写绝对 URL。
3. **索引与文章都必须可跨域读取**：网页直接 fetch，服务器需返回 `Access-Control-Allow-Origin: *`。GitHub raw、GitHub Pages、对象存储都满足。

## 工具侧的校验行为

- 索引：根节点必须是对象，`series` 必须是非空数组，系列与书必须有 `name`；缺 `file` 的条目直接跳过，不报错。
- 文章：载入时校验 `sentences` 非空、每句有 `en`，与手动载入同一套规则。
- 索引读取失败（404 / 跨域 / 非 JSON）会在弹窗内与右上提示中说明原因，不会静默空白。

## 最小可跑示例

```json
{
  "name": "我的库",
  "series": [
    { "name": "短篇", "books": [ { "name": "第一册", "articles": [ { "title": "Demo", "file": "demo.json" } ] } ] }
  ]
}
```
