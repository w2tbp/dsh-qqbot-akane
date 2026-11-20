/**
 * 记忆库跨 fiber 的开关影子
 *
 * 热重载只让新 fiber 不挂载（`memory/index.ts` 的 `if (!enabled) return` 早退），
 * 但**撤不掉旧 fiber 已注册的工具与后台作业** —— `tools.register` 的 disposer 绑在
 * 宿主服务 scope，插件拿不到；`setInterval` 的句柄也只在 `ctx.effect` 里登记，
 * 而宿主是否 dispose 旧 fiber 的 effect 没有公开契约。
 *
 * 所以 enabled 判断必须有一道在 `execute()` 与 `tick()` 里读这个**共享状态**，
 * 关掉才能当场生效。挂载判仍只有一处（`index.ts` 早退），那道纪律针对的是
 * 「开启分支别在别处再判一次」；运行时判是另一回事，它让关闭态在旧 fiber 里
 * 也立即停止写与查。
 *
 * 每次 `startMemoryFeature` 挂载都同步这个值，跨 fiber 生效。
 */
export const memorySwitch = { on: false };
//# sourceMappingURL=switch.js.map