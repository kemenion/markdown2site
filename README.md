# MarkdownToWebSite

把一堆 Markdown 变成一个带**左目录 / 中正文 / 右大纲**的文档站，观感对齐 docsify + vue 主题。

**零依赖、无构建步骤**：站点 = `index.html`（零配置外壳）+ `app/`（三个文件）+ `docs/`（全部内容 + 站点配置），
丢进任意静态服务器就能看，`docs/` 还能整包搬到别的项目里。

```bash
python3 -m http.server 8080     # 在仓库根目录执行，然后打开 http://localhost:8080/
```

> 必须走 HTTP：正文是 `fetch()` 出来的，双击 `index.html`（`file://`）读不到 Markdown。

使用说明就在站点里（`docs/` 既是内容根、也是它自己的说明书）：从 [`docs/README.md`](docs/README.md)
开始读——配置、左栏清单、Markdown 语法、路由规则、界面与移动端、仓库结构都在里面。
测试与验证脚本不在仓库里：`test/` 已被 `.gitignore` 忽略、历史上从未入库。解析器（`app/markdown.js`）
是纯函数，开发期用 Node 直接断言 AST、再用 Playwright 打开真实页面看渲染就够，见 [`docs/参考/项目结构.md`](docs/参考/项目结构.md)。

