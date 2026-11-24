# 轻读 · 英语阅读器

把一个 JSON 变成可逐句朗读、逐词查义的英语阅读页。JSON 由你用 AI 生成，工具本身不解析、不改写文章。

## 特点

- **只用浏览器**：无后端、无构建、无依赖，双击 `index.html` 就能用
- **逐句朗读**：Web Speech 朗读整句，朗读时逐词高亮
- **每个词可点**：点单词出词卡，含上下文义项、词性、音标、发音按钮
- **没收录也不崩**：词表里没有的词仍可点击发音，只提示无释义
- **自带生成引导**：顶部「载入」面板里有可直接复制的 AI 提示词、字段说明和示例
- **三种载入方式**：选择文件、拖拽 `.json`、粘贴 JSON 文本

## 使用

1. 打开 `index.html`（双击即可）。
2. 点顶部「载入」，展开「没有 JSON？用 AI 生成」，复制提示词。
3. 把提示词和英文文章一起发给任意 AI，拿到 JSON。
4. 回到「载入」面板，粘贴 JSON 或点「加载 JSON 文件」，再点「载入」。

也可以直接把 `.json` 文件拖到页面上。

快捷键：`←` `→` 翻句，`空格` 朗读本句，`Esc` 关闭词卡/面板。

## 数据格式

见 [schema.md](schema.md)。最小结构：

```json
{
  "title": "文章标题",
  "sentences": [
    { "en": "English sentence.", "zh": "中文翻译。", "words": { "english": { "zh": "英文的", "pos": "adj.", "ipa": "/ˈɪŋɡlɪʃ/" } } }
  ]
}
```

`examples/demo.json` 是完整示例，`assets/demo.js` 是页面内置的同一份数据。

## 目录

```
index.html          页面
assets/reader.css   样式
assets/app.js       交互逻辑
assets/demo.js      内置示例数据
examples/demo.json  示例数据（JSON 文件形式）
schema.md           数据格式规范 + AI 提示词
llms.txt            给 AI 的站点入口
```

## 浏览器要求

Chrome / Edge / Safari 较新版本。语音合成依赖系统语音包；如果没声音，检查系统是否安装了英语语音。

## License

MIT
