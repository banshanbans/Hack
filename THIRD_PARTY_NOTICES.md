# 第三方许可记录

## RASSAR

- 来源：<https://github.com/makeabilitylab/RASSAR>
- 版权所有：Copyright (c) 2024 UW Makeability Lab
- 许可：MIT，全文见 `LICENSE`
- 状态：已保留原版权声明、LICENSE 和 NOTICE 署名。

## 上游 Core ML 模型

- 文件：`RASSAR App/YOLOv5/yolov5-Medium.mlmodel`、`RASSAR App/YOLOv5/yolov5-iOS.mlmodel`
- 来源：随 RASSAR 上游仓库提供；README 将其描述为基于相关数据集训练的模型。
- 状态：上游仓库未在模型目录中提供单独的模型或数据集许可文件。
- 发布要求：在公开分发、提交应用商店或继续训练前，必须由项目负责人确认模型权重与训练数据集的再分发和商用许可。未经确认，不得把上游 MIT 代码许可自动解释为数据集许可。

## 新增依赖

- `AnjuCore` 是本仓库内的本地 Swift Package，不是外部依赖。
- 本地开发后端只使用 Python 标准库。
- 当前改造没有新增第三方二进制依赖或模型权重。
