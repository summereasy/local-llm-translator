# Local LLM Translator

[English](README.md) | 简体中文

一个 Chrome 扩展，用你自己的本地或自托管 LLM endpoint 翻译网页和选中文本。

它可以接 Ollama、LM Studio、omlx、vLLM、SGLang、llama.cpp，或任何 OpenAI-compatible `/v1/chat/completions` endpoint。如果你仍然想使用托管服务，也可以在设置页里填写 API key 和 base URL。

我不太理解为什么这种浏览器翻译工具经常是闭源的，所以做了一个开源版本。

## 截图

<table>
  <tr>
    <td width="50%">
      <strong>划词翻译</strong>
      <br />
      <img src="docs/images/selection-translate.jpg" alt="划词翻译弹窗" />
    </td>
    <td width="50%">
      <strong>整页翻译</strong>
      <br />
      <img src="docs/images/full-translate.jpg" alt="整页翻译" />
    </td>
  </tr>
</table>

## 功能

- 使用 `Option+A` 翻译当前页面。
- 使用同一个快捷键在译文和原文之间切换。
- 使用 `Option+E` 或浮动按钮翻译选中文本。
- 可配置 endpoint、模型、API key、目标语言、prompt、显示方式、文本样式和并发请求数。
- 页面打开期间会在内存里缓存已翻译段落，所以关闭/重新开启页面翻译不会重复请求已经翻译过的段落。

Chrome 可能会保留 unpacked extension 的旧快捷键绑定。如果快捷键没有更新，请打开 `chrome://extensions/shortcuts` 手动修改。

## 隐私

没有登录 / 账号 / analytics / 项目服务器。扩展不会记录或收集使用数据。它只会把选中文本或页面文本发送到你配置的 endpoint。如果你配置的是 `127.0.0.1`，数据就留在你自己的机器上。如果你配置远程 API，那就是你的选择，对应服务商的隐私政策适用。

## 从源码安装

要求:

- Chrome 或其他 Chromium 浏览器
- [Bun](https://bun.sh/)
- 一个本地或自托管翻译 endpoint

克隆并构建:

```bash
git clone https://github.com/summereasy/local-llm-translator.git
cd local-llm-translator
bun install
bun run build
```

加载扩展:

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 点击 "Load unpacked"。
4. 选择 `bun run build` 生成的 `dist/` 文件夹。

## 从 Release 安装

Release 会包含打包好的 `dist/` zip。

1. 从 GitHub Releases 下载最新 zip。
2. 解压。
3. 打开 `chrome://extensions`。
4. 开启开发者模式。
5. 点击 "Load unpacked"。
6. 选择解压后的文件夹。

## Chrome Web Store

目前不可用。

以后可能会有。

## 开发

```bash
bun install
bun run typecheck
bun run build
```

构建产物会输出到 `dist/`。

`dist/` 会被 git 忽略。Release artifact 应该从干净构建生成。

## 说明

这个项目有意保持范围很窄。它不是词典应用，不是 SaaS 翻译服务，也不是 provider marketplace。主要目标是为本地和自托管 LLM endpoint 提供一个好用的浏览器翻译体验。

## 致谢

感谢 Immersive Translate 和 Qingshan Translate。它们不是开源项目，但我借鉴了其中的一些产品和交互想法。

这个项目是在 GPT-5.5 (Codex) 的帮助下完成的。

## 贡献

如果你觉得哪里坏了，欢迎提交 issue 或 PR。

不保证每个问题都会修，但清晰的 bug report 和小 PR 都欢迎。
