<a id="readme-top"></a>

[![License][license-shield]][license-url]
[![Issues][issues-shield]][issues-url]
[![Stars][stars-shield]][stars-url]

<br />
<div align="center">
  <a href="https://github.com/Stephen-Xu-X/bosszhipin_companyINFO">
    <img src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png" alt="GitHub" width="80" height="80">
  </a>

  <h3 align="center">BOSS直聘脚本</h3>

  <p align="center">
    面向 BOSS 直聘与前程无忧的公司信息查询和岗位信息辅助显示油猴脚本。
    <br />
    <a href="#安装"><strong>查看安装方式 »</strong></a>
    <br />
    <br />
    <a href="https://github.com/Stephen-Xu-X/bosszhipin_companyINFO/issues">报告问题</a>
    ·
    <a href="https://github.com/Stephen-Xu-X/bosszhipin_companyINFO/issues">提出建议</a>
  </p>
</div>

<details>
  <summary>目录</summary>
  <ol>
    <li><a href="#更新日志">更新日志</a></li>
    <li><a href="#关于项目">关于项目</a></li>
    <li><a href="#功能">功能</a></li>
    <li><a href="#安装">安装</a></li>
    <li><a href="#使用说明">使用说明</a></li>
    <li><a href="#反馈">反馈</a></li>
    <li><a href="#许可证">许可证</a></li>
  </ol>
</details>

## 更新日志

### 2.0.0

- 重构 BOSS 页头控制：新增 `Power On/Off` 开关和 GitHub 仓库入口。
- 修复反复切换开关后重复插入查询图标的问题。
- 移除油猴扩展菜单命令，统一脚本名称和启动文案。
- 自动更新 Raw 链接将在首个正式版本发布后补充。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

## 关于项目

本脚本在 BOSS 直聘和前程无忧页面中提供公司查询入口及岗位信息辅助显示。公司查询基于 `kjxb.org` 的公开搜索页面；未命中时会提供对应搜索入口。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

## 功能

- BOSS 直聘搜索页、职位详情页、用户页和公司页显示公司查询入口。
- BOSS 页头提供 `Power On/Off` 开关，可即时暂停或恢复查询。
- 页头 GitHub 图标可直接打开本仓库。
- 前程无忧岗位列表显示岗位发布时间、学历和经验等页面已有信息。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

## 安装

1. 在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容的用户脚本管理器。
2. 打开 [scripts/blacklist-combined.js](scripts/blacklist-combined.js)，复制全部内容。
3. 在脚本管理器中新建脚本，粘贴并保存。
4. 打开 BOSS 直聘或前程无忧页面即可运行。

> 正式发布后会补充一键安装和自动更新链接。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

## 使用说明

- BOSS 页面右上角显示 `Power On/Off` 开关；关闭后会清除已插入的查询标记并暂停扫描。
- 查询结果来自外部公开页面，结果完整性与可用性取决于该站点。
- 脚本不会上传用户的账号、简历或浏览记录。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

## 反馈

问题反馈和功能建议请通过 [Issues][issues-url] 提交。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

## 许可证

本项目采用 [GPL-3.0][license-url] 许可证。

<p align="right">(<a href="#readme-top">返回顶部</a>)</p>

<!-- Markdown reference links -->
[license-shield]: https://img.shields.io/github/license/Stephen-Xu-X/bosszhipin_companyINFO.svg?style=for-the-badge
[license-url]: https://github.com/Stephen-Xu-X/bosszhipin_companyINFO/blob/main/LICENSE
[issues-shield]: https://img.shields.io/github/issues/Stephen-Xu-X/bosszhipin_companyINFO.svg?style=for-the-badge
[issues-url]: https://github.com/Stephen-Xu-X/bosszhipin_companyINFO/issues
[stars-shield]: https://img.shields.io/github/stars/Stephen-Xu-X/bosszhipin_companyINFO.svg?style=for-the-badge
[stars-url]: https://github.com/Stephen-Xu-X/bosszhipin_companyINFO/stargazers
