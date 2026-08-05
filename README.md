# Mercury Fleet MVP v1.1

Mercury Fleet 是一个面向本地集装箱拖车业务的协作系统。Operator 在运营端创建订单、选择车队、比较报价和审核运输文件；车队在独立的聊天工作区中报价、接单、更新整票运输状态并上传文件。

本项目当前是可在本地运行和演示的 MVP，不是生产环境成品。

## 在线演示（静态，无需安装）

<https://zzlippy.github.io/mercury-fleet-chat/> — 无需本地环境即可查看界面，登录页已预填演示账号。这是纯前端的静态构建，使用预先录制的示例数据模拟后端（见 [apps/web/src/demo/README.md](apps/web/src/demo/README.md)），登录、发消息等操作不会保存，刷新页面即重置。真实的完整功能（含 PostgreSQL 后端）见下方“快速启动”。

## 先读什么

建议按下面顺序阅读：

1. 本文件：了解项目目标、当前范围和快速启动方式；
2. [docs/01_产品规则.md](docs/01_产品规则.md)：了解业务对象、订单类型、报价、车队档案和运输状态；
3. [docs/02_安装运行与测试.md](docs/02_安装运行与测试.md)：在 Windows 上安装、启动和测试；
4. [docs/03_演示与验收流程.md](docs/03_演示与验收流程.md)：用 Operator 和 Fleet 账号走通完整场景；
5. [docs/04_开发维护指南.md](docs/04_开发维护指南.md)：继续开发时查看代码结构、修改原则和已知边界。

## 当前最重要的产品规则

- 一张 Order 是一项独立的本地集装箱拖车任务，不引入 Transport Leg。
- 支持两类订单：
  - `EXPORT_DRAYAGE`（送港）：提空箱 → 仓库／工厂装货 → 将重箱交还码头；
  - `IMPORT_DRAYAGE`（提港）：码头提重箱 → 仓库／工厂送货 → 归还空箱。
- 核心关系是 `Order → RFQ → Quote → Booking → Shipment`。
- 一张订单可以包含多个集装箱，但第一版必须由一家车队承接整票；不记录司机、车牌和车辆分配。
- 车队的业务选择不用按钮，系统显示 `1. / 2. / 3.` 文本选项，车队回复数字完成选择。
- 登录、退出、上传文件、编辑档案等普通界面控件仍然使用按钮。
- 车队自行填写档案；能力字段修改后由 Operator 审核。暂停／恢复接单立即生效。
- 系统根据服务国家、危险品能力、冷藏箱能力、接单状态和系统账号状态生成候选车队；Operator 最终手动选择发送对象。
- Operator 修改已发出 RFQ 的车队可见条件后，旧报价失效并保留历史，车队必须重新报价或确认价格不变。
- Shipment 只有在必需文件经过 Operator 审核后才能完成。

## 演示账号

所有演示账号的密码都是 `mercury`。用户名不包含 `@` 或邮箱后缀。

| 入口 | 用户名 | 数量 |
| --- | --- | ---: |
| 车队端 | `fleet1` 至 `fleet10` | 10 |
| 运营端 | `operator1` 至 `operator3` | 3 |

每个 `fleetN` 属于独立车队组织；三个 `operatorN` 属于同一个 Mercury 运营组织。

## 快速启动

需要 Node.js 22–24、pnpm 9.15.9 和 PostgreSQL 15 或更高版本。完整 Windows 指南见 [docs/02_安装运行与测试.md](docs/02_安装运行与测试.md)。

```bash
pnpm install
pnpm migrate
pnpm seed
pnpm build:web
pnpm dev:api
```

启动后访问：

- 车队端：<http://localhost:4000/fleet/login>
- 运营端：<http://localhost:4000/operator/login>

`pnpm seed` 当前应输出类似：

```text
Seed complete. Password for all demo accounts: mercury
Fleet accounts: fleet1 ... fleet10
Operator accounts: operator1 ... operator3
```

如果输出仍然出现其他密码或邮箱式演示账号，说明运行的不是这份 v1.1 源码，或终端所在目录不正确。

## 当前已经实现

- Fleet 与 Operator 两套独立登录入口和独立 Cookie，可在同一浏览器中同时登录；
- 送港和提港两类订单，以及多箱整票任务；
- 候选车队匹配与 Operator 手动调整收件人；
- 任务级聊天、编号文本选择和数字回复解析；
- 报价确认、报价历史、订单变更后的报价失效与重新确认；
- Booking 与两类 Shipment 状态机；
- 车队档案提交、Operator 审核、接单开关和系统账号停用；
- 文件上传、Operator 审核、退回重传和确定性结案；
- 事务、幂等处理、版本校验、审计日志、Outbox 和服务器端未读状态；
- Web 界面，以及 WhatsApp／微信的编号文本渲染适配层。

## 暂不包含

- 客户端门户、海运订舱和船期跟踪；
- Transport Leg、跨境陆运和普通仓库到仓库运输；
- 一张订单拆给多家车队或按单箱记录进度；
- 司机、车牌和具体车辆安排；
- 基于历史表现、准时率或响应速度的车队排名；
- 计费、付款、发票和结算；
- 微信／WhatsApp 的真实生产账号接入；
- 生产级部署、监控、备份、灾难恢复和安全加固。

## 文档维护规则

本目录中的五份 Markdown 是当前交付文档。任何人修改账号、命令、业务状态、数据库字段或操作流程时，必须同时更新相应文档；不得保留与当前代码冲突的旧说明。

发生冲突时，以用户最新确认的业务决定为最高优先级，其次是 `docs/01_产品规则.md`，最后才是代码中的历史兼容结构。
