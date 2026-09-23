# 景区角色排班服务

这是景区角色场次的后端服务基线，应用监听 8080 端口，`/healthz` 用于检查进程状态。运行数据放在工程目录的 SQLite 文件中，部署时可通过环境变量调整路径。

执行 `npm install && npm test` 检查测试入口，`npm run build && npm start` 启动编译后的服务。Dockerfile 提供 Node.js 22 的容器运行方式。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 编译或构建：`npm run build`
