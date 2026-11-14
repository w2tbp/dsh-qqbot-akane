export class GroupHistoryStore {
    buffers = new Map();
    /** 追加一条，按 messageId 去重，超出 limit 从头淘汰 */
    append(groupKey, entry, limit) {
        let buf = this.buffers.get(groupKey);
        if (!buf) {
            buf = [];
            this.buffers.set(groupKey, buf);
        }
        if (buf.some(e => e.messageId === entry.messageId))
            return;
        buf.push(entry);
        if (buf.length > limit)
            buf.splice(0, buf.length - limit);
    }
    /** 取最近 limit 条（oldest → newest） */
    list(groupKey, limit) {
        const buf = this.buffers.get(groupKey);
        if (!buf)
            return [];
        return buf.slice(-limit);
    }
    clear(groupKey) {
        this.buffers.delete(groupKey);
    }
    /** 诊断：有多少个群有缓冲 */
    size() {
        return this.buffers.size;
    }
}
let _store = null;
/** 获取共享历史存储（单例），供中间件写入、inbound 回复后清空 */
export function getHistoryStore() {
    if (!_store)
        _store = new GroupHistoryStore();
    return _store;
}
/** 用 appId 前缀隔离群历史（单账号下等价于 groupOpenid，保留多账号扩展） */
export function historyGroupKey(appId, groupId) {
    return `${appId}:${groupId}`;
}
/** 清空群历史（回复后调用，避免下次 @ 时重复组包） */
export function clearGroupHistory(appId, groupId) {
    _store?.clear(historyGroupKey(appId, groupId));
}
//# sourceMappingURL=history-store.js.map