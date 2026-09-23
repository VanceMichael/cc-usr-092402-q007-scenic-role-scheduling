import Koa from "koa";
import Router from "@koa/router";

const app = new Koa();
const router = new Router();
router.get("/healthz", (ctx) => { ctx.body = { status: "ok" }; });
app.use(router.routes()).use(router.allowedMethods());
app.listen(Number(process.env.PORT ?? 8080));

