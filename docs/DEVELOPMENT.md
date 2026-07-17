# 开发说明

## 入口

- 正式脚本：`scripts/bosszhipin-company-info.user.js`
- 用户说明：[README.md](../README.md)
- 数据来源：[kjxb.org](https://kjxb.org/)

## 修改范围

- BOSS 逻辑位于 `if (isBOSS)` 分支，包括页头开关、页面扫描和查询结果插入。
- 51job 逻辑位于 `if (is51job)` 分支。除非任务明确涉及 51job，不修改该分支。
- 公司查询仅请求 `kjxb.org` 的公开搜索页面，不新增其他数据源。

## BOSS 查询流程

1. 脚本从 BOSS 页面提取公司名称。
2. `queryBlacklist` 向 `kjxb.org` 发起公开搜索请求，并缓存结果。
3. 命中时插入结果链接和标记；未命中时插入搜索入口。
4. `Power On/Off` 控制 BOSS 扫描。`bossScanGeneration` 使旧批次的异步回调失效，避免重复插入标记。

## 修改与验证

1. 先定位任务所属模块，只修改必要代码。
2. 修改脚本后执行：

   ```powershell
   node --check scripts/bosszhipin-company-info.user.js
   ```

3. 在 BOSS 页面验证开关、查询标记和重复开关后的行为。
4. 若修改脚本头部或发布路径，同时更新 README 的安装链接和更新日志。

## 发布

1. 脚本发生功能变更时递增 `@version`。
2. 保持 `@updateURL` 与 `@downloadURL` 指向正式 `.user.js` Raw 地址。
3. 提交脚本、README 和必要图片；不要提交数据库备份、本地工具目录或 `.git/`。
4. 合并到 `main` 后，验证 README 安装链接和 Raw 脚本元数据。
