# 景区角色排班服务

沉浸式景区节假日加场场景下的角色场次动态排班后端。应用监听 8080 端口，`/healthz` 用于检查进程状态。运行数据放在工程目录的 SQLite 文件中（默认 `./data/schedule.db`，可用环境变量 `SCHEDULE_DB_PATH` 调整）。

执行 `npm install && npm test` 检查测试入口，`npm run build && npm start` 启动编译后的服务。Dockerfile 提供 Node.js 22 的容器运行方式。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 类型检查：`npm run typecheck`
- 编译或构建：`npm run build`

## 动态编排能力

- **领域数据**：演员资质及有效期、场次模板（角色需求/关键角色）、区域间步行转场时间、休息约束、区域容量，均通过 REST 接口维护。
- **方案生成**（`POST /plan/generate`）：在资质有效期、时间不重叠、步行+休息间隔等约束下贪心排班；有已确认预约的场次被锁定不改写；为每个岗位显式计算应急替补余量（`min_backup_slack`），不足时输出未满足需求。
- **乐观锁**：演员与场次均带版本号，并发调整同一演员资质或同一场次安排时返回 `409 version_conflict`。
- **事件局部重算**：设施故障停演（`POST /incidents/facility-outage`）与迟到打卡（`POST /incidents/late-checkin`）只重算受影响时间区间；已开始场次一律不静默改写，进入 `blockedStarted` 清单交人工处置。
- **通知与升级**：分配/取消变更生成待确认通知，演员在 `confirm_timeout_seconds` 内确认，超时由周期清扫升级为值班主管；通知持久化于 SQLite，服务重启时自动恢复（重启期间过期的立即升级）。
- **可解释接口**：`GET /plan/explain` 返回每次分配采用的约束检查明细与候选评估、`GET /demands/unmet` 返回未满足需求（容量溢出、岗位空缺、替补余量不足、孤儿预约等）。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| GET/PUT | `/config` | 运行参数（休息分钟、确认超时、替补余量、值班主管等） |
| POST/GET | `/actors`、`/actors/:id` | 演员维护 |
| PUT | `/actors/:id/qualifications` | 资质及有效期（需 `expectedVersion`） |
| POST/GET | `/zones`、`/transfers` | 区域容量与步行转场时间 |
| POST/GET | `/templates` | 场次模板与角色需求 |
| POST/GET | `/sessions` | 场次排期 |
| POST | `/sessions/:id/start` `/complete` `/cancel` | 场次生命周期（需 `expectedVersion`，已开始不可取消） |
| POST | `/reservations`、`/reservations/:id/cancel` | 游客预约 |
| POST | `/plan/generate` | 生成排班方案 `{from, to}` |
| GET | `/plan/explain?from&to` | 分配约束明细、替补余量、未满足需求 |
| GET | `/demands/unmet` | 当前未满足需求 |
| POST | `/sessions/:id/assignments` | 手工指派（`expectedVersion`，违反约束 422，`force:true` 可显式覆盖并留痕） |
| POST | `/assignments/:id/remove` | 移除分配（`expectedVersion`） |
| POST | `/incidents/facility-outage` | 设施故障停演 `{zoneId, from, to, reason}` |
| POST | `/incidents/late-checkin` | 迟到打卡 `{actorId, availableFrom}` |
| GET | `/notifications`、`/notifications/pending` | 通知查询 |
| POST | `/notifications/:id/confirm` | 演员确认 `{actorId}` |
| POST | `/notifications/sweep` | 手动触发超时清扫（演示/测试用） |
| GET | `/audit` | 审计日志 |

## 目录结构

- `src/db.ts` — SQLite schema 与默认配置
- `src/store.ts` — 领域类型与数据访问
- `src/constraints.ts` — 约束评估器（输出可解释检查清单）
- `src/planner.ts` — 方案生成（预约锁定、替补余量、未满足需求）
- `src/incidents.ts` — 事件局部重算（停演、迟到）
- `src/notifications.ts` — 通知确认、超时升级、重启恢复
- `src/service.ts` — 应用门面（事务与版本冲突）
- `src/app.ts` / `src/server.ts` — HTTP 层与进程入口
