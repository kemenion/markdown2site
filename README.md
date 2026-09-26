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
测试相关的一切（E2E 套件、失败模式清单、夹具）在 [`test/`](test/README.md)，与站点运行无关，可整个删掉。

