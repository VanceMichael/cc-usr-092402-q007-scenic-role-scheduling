# 景区角色排班服务

沉浸式景区节假日加场场景下的角色场次动态编排服务。维护演员资质及有效期、场次模板、步行转场时间、休息约束与区域容量，自动生成排班方案；锁定已确认的游客预约，为应急替补保留可解释余量；支持调度员并发调整的版本冲突检测、设施故障/迟到的增量重算、演员确认与超时升级，以及服务重启后未确认通知的恢复。

运行数据放在工程目录的 SQLite 文件中（默认 `data/schedule.sqlite`，可用环境变量 `DB_PATH` 调整）。应用监听 8080 端口，`/healthz` 用于检查进程状态。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 编译：`npm run build`；启动：`npm start`（或 `npm run dev`）
- 环境变量：`PORT`（默认 8080）、`DB_PATH`、`SWEEP_INTERVAL_MS`（超时清扫间隔，默认 10000）

## 概念模型

| 概念 | 说明 |
| --- | --- |
| 演员 / 资质 | 演员可持多个角色资质，资质带有效期（`validFrom`/`validUntil`），过期即不可排 |
| 区域 / 转场 | 区域有容量；区域间配置步行分钟数，用于赶场冲突判定 |
| 场次模板 | 定义区域、时长与角色需求 `[{role, count}]` |
| 场次 | 由模板实例化，状态流转 `scheduled → started → finished`，另有 `cancelled` |
| 预约 | 已确认预约会锁定场次：优先生成人员、分配标记 `locked`，容量不足记为未满足 |
| 分配 | 每次分配持久化约束判定轨迹（trace），解释接口可回放 |
| 通知 | 分配/取消都生成待确认通知，超时升级值班主管；持久化存储，重启后恢复 |

调度规则通过 `GET/PUT /rules` 调整：`minRestMinutes`（相邻场次最小休息）、`maxSessionsPerDay`、`reservePerRole`（每角色应急替补保留人数）、`confirmTimeoutSec`（确认超时）、`dutySupervisor`（值班主管）。

## 主要接口

### 基础数据

- `POST/GET /actors`，`GET/PATCH /actors/:id`，`POST /actors/:id/qualifications`，`DELETE /qualifications/:id`
- `POST/GET /zones`，`POST /zones/:id/outage`（设施故障停演），`POST /zones/:id/reopen`
- `POST/GET /transfers`（区域间步行分钟，同名 upsert）
- `POST/GET /templates`
- `POST/GET /sessions`，`GET /sessions/:id`，`PATCH /sessions/:id`（改期，原分配失效并通知演员）
- `POST /sessions/:id/cancel`（已开始场次需 `force: true`），`POST /sessions/:id/start|finish`
- `POST /sessions/:id/reservations`，`DELETE /reservations/:id`

### 方案生成与解释

- `POST /plans/generate { from, to }`：填充区间内未开始场次的角色空缺。有已确认预约的场次优先并允许动用应急余量；无预约场次严格保留 `reservePerRole` 名应急替补，排不出记为未满足需求。
- `GET /plans/explain?from&to`、`GET /sessions/:id/explain`：每场的人员安排（含完整约束轨迹与确认状态）、未满足需求（原因与说明）、应急替补余量快照、容量核对。

### 增量重算（只影响受影响区间）

- `POST /zones/:id/outage { from, to, reason }`：窗口内未开始场次停演并通知演员；已开始场次列入 `skippedStartedSessionIds`，绝不改写。
- `POST /actors/:id/checkin { status: "late", lateMinutes }`：只重算该演员到岗前开场的未开始场次，启用应急替补（允许动用余量），其余分配保持不变。

### 并发与变更确认

- 所有写操作携带 `expectedVersion`（实体当前版本），版本不匹配返回 `409` 与冲突说明；同一演员/场次/分配的并发调整必有一方失败。
- 已开始（含按时间已开始）的场次：生成跳过、人工调整与改期返回 `422`，停演必须显式 `force`。
- `GET /notifications?status=&actorId=`，`POST /notifications/:id/confirm { actorId }`：演员确认变更；超时由后台清扫器升级，`GET /escalations` 查看值班主管待办。服务重启时自动恢复未确认通知继续跟踪。
- `GET /events`：全部调度变更的审计流水。

### 人工调整

- `POST /sessions/:id/assignments { actorId, role, expectedVersion, force? }`：违反约束返回 `422` 及违规明细；`force: true` 强制执行并把违规项以 `overridden` 记入轨迹。
- `DELETE /assignments/:id { expectedVersion }`：撤销分配并向演员发送待确认取消通知。
