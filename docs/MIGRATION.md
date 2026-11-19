# 接入与快照边界

此候选包含八个框架包及合成 fixture，不带旧仓历史、真实业务数据或归档分支。React/Vue 接入与生命周期见 DEVELOPER-GUIDE.md，页面协议与观测绑定见 PAGE-PERCEPTION.md。

page 模式使用页面 snapshotId、bindingRef、intent 和 arguments。legacy 动作接入不等于完整页面模式；迁移时应逐项声明可见区域、动作绑定、guard 与执行结果的 observationRequired，而不是只替换 import。

配套应用和评测仓库拟名 `yankuang608/WebWorkBench`，不作为本仓构建依赖；新仓和公开镜像另行验证。
