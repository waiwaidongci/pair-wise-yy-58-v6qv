# pair-wise-yy-58 大型构件吊装三维校核平台

围绕大型转换桁架吊装方案，提供三维场景、时间轴校核、冲突定位、条件评论和多角色签署工作流。

## 核心机制

- **参数快照绑定**：步骤顺序 + 全部数值生成内容哈希快照（`src/snapshot.ts`）。每份签署记录全量快照 ID、本角色职责域哈希、步骤顺序哈希及签署时职责内数值。
- **职责域失效**：四个角色（总包 / 设备 / 安全 / 方案）各有负责字段。签署后只有该角色职责内数值变化才令其本人签署失效；他人修改其他域不连带作废。步骤顺序是全体共享项，顺序调整四角色全部失效需重签。
- **乐观并发（OCC/CAS）**：文档带单调递增 `revision` 令牌，所有编辑、排序、签署、评论、发布都走事务（`store.ts::_transact` + `storage.ts::commitDoc`）。两个窗口并发时，后提交者基于过期 revision 会被拒绝，绝不覆盖先到结果；其修改意图自动进入"待复核冲突队列"，可放弃或基于最新快照重新套用。
- **崩溃恢复**：localStorage 主/备份双 key 原子写入（带 FNV-1a 校验和），主快照损坏自动回退备份；未提交编辑按窗口保存草稿，浏览器崩溃重开后恢复完整快照与编辑现场。
- **原子发布**：仅当四角色签署对当前快照全部有效、规则冲突 / 并发冲突 / 未关闭评论全部清零、且该快照尚未发布时，才在一次 CAS 提交中生成不可变版本（内嵌步骤、评论、签署与快照 ID），并同步写入 Apollo 缓存；任一条件不满足则整笔回滚，不产生版本号。

## 技术栈

Vue 3、Quasar、Pinia、Vue Router、Apollo Client、GraphQL、Three.js、Vite、TypeScript。

## 运行

```bash
npm install
npm run dev
```

端口：`62058`

```bash
npm run build
```

## 逻辑验证

`verify-flow.ts` 为纯 Node 逻辑验证（模拟双窗口并发、签署按职责域失效、崩溃恢复、原子发布）：

```bash
npx esbuild verify-flow.ts --bundle --platform=node --format=esm --outfile=/tmp/verify.mjs && node /tmp/verify.mjs
```

文档通过主/备份双份 envelope 保存在浏览器 `localStorage`，发布版本快照同时写入 Apollo 内存缓存。
