/*!
 * 空回守卫 Empty Reply Guard v2.4.0
 * 自动检测并修复酒馆(SillyTavern)的“空回复”（仅供私人使用）。
 * v2.0 新增“请求层修复”：包装 window.fetch，在生成请求到达酒馆解析器之前
 * 就完成 空流自动重试 → 非流式兜底 → 格式修复 → 工具调用提示，
 * 让酒馆“第一次就不空”（纯本地运行，不依赖任何服务器）。
 * v2.2 新增：把“空流类错误”（如 empty_stream: 上游返回空流(无 contentBlock)，
 * 常见于中转站 Claude 渠道）也纳入自动重试/非流式兜底，而不是透传报错。
 * v2.4 新增：非流式请求也由请求层接管（关掉流式的用户同样有“空内容自动重试”），
 * 新开空白窗口的随机空回/空流同样被兜住。
 * v2.5 新增：流式请求遇到 5xx（502/503 等渠道临时故障）也自动重试，不再直接报错。
 * v2.6 新增：请求自动瘦身——监听酒馆 chat_completion_prompt_ready 事件，
 * 在发送前对完整请求体（含预设/世界书/角色卡/系统提示）自动精简：
 * 超长内容截断 + 总预算超限裁剪最旧消息。不修改任何存档。
 * v2.7 新增：深瘦身——截断后仍超预算时，用当前模型（走酒馆自己的 key）
 * 把最长的预设/世界书条目做成要点摘要替换，几千 token 压到几百。
 * v2.8 新增：长输出保护——单轮 max_tokens 设置过大时在发送前钳制到安全值，
 * 避免超长输出把渠道/网关超时全部撞爆（配合酒馆“自动续写”使用更佳）。
 * v2.10 新增：自动换路——连续失败（空回/5xx/边缘线路问题）时自动把 API 地址
 * 切到备用地址（默认 .online <-> .xyz 互换），全程静默，无需任何手动操作。
 * License: MIT
 */
(function (global) {
    'use strict';

    const PLUGIN_KEY = 'emptyReplyGuard';
    const PLUGIN_NAME = '空回守卫 · Empty Reply Guard';
    const VERSION = '2.10.0';

    // =========================================================
    // 默认设置（会合并进 extension_settings.emptyReplyGuard）
    // =========================================================
    const DEFAULTS = {
        enabled: true,                 // 总开关
        maxRetries: 2,                 // 常规 regenerate 重试次数（0-5）
        useNonStreamFallback: true,    // 重试仍空时，临时关流式用非流式再试一次
        retryDelayMs: 3500,            // 首次重试等待毫秒
        backoffFactor: 1.6,            // 每次递增系数（指数退避）
        treatPlaceholderAsEmpty: true, // 把 "..." 占位消息视为空回复
        handleTypes: 'normal, regenerate', // 处理哪些生成类型（逗号分隔）
        debug: false,                  // 控制台调试日志
        enableFetchGuard: true,        // 请求层修复：拦截生成请求，第一次就不空
        fetchMaxRetries: 2,            // 请求层空流自动重试次数（0-5）
        fetchFallbackNonStream: true,  // 请求层重试仍空 → 用非流式兜底
        enableContextGuard: true,      // 上下文护栏：防止 token 爆掉导致空回
        contextThreshold: 0.80,        // 上下文占用达到该比例时触发保护（0.5-0.95）
        contextAutoTrim: true,         // 自动裁剪最旧消息（关 = 仅提醒不裁剪）
        contextMinKeep: 6,             // 裁剪时至少保留的最后消息条数（含第一条定场）
        enableSlimPrompt: true,        // 请求自动瘦身：发送前精简超长预设/世界书内容
        slimThreshold: 0.70,           // 请求总预算达到该比例时触发瘦身（0.5-0.95）
        slimMaxContentChars: 4000,     // 单条内容超过该字符数则截断
        enableDeepSlim: true,          // 深瘦身：截断后仍超预算 → 用模型把最长条目压缩成摘要
        slimSummaryTargetChars: 1200,  // 摘要目标字符数
        slimSummaryMaxItems: 2,        // 每轮最多摘要的条目数
        enableLongOutputGuard: true,   // 长输出保护：单轮 max_tokens 过大时钳制
        longOutputMaxTokens: 8192,     // 单轮输出上限（超过则发送前钳制；配合自动续写）
        enableFailover: true,          // 自动换路：连续失败自动切换备用 API 地址
        failoverUrls: 'https://emtf.aipm9527.online/v1, https://emtf.aipm9527.xyz/v1', // 备用地址（逗号分隔，可改成自己的站）
        failoverThreshold: 3,          // 连续失败 N 次触发换路
        failoverCooldownSec: 300,      // 同一地址切换冷却（秒）
    };

    // =========================================================
    // 纯函数部分（Node 测试可直接 require 本文件使用）
    // =========================================================

    /** 判断一段文本是否“空”（含白字符与占位符）。 */
    function isEmptyMessage(mes, opts) {
        if (mes === null || mes === undefined) return true;
        if (typeof mes !== 'string') mes = String(mes);
        const t = mes.trim();
        if (t.length === 0) return true;
        if (opts && opts.treatPlaceholderAsEmpty) {
            if (t === '...' || t === '…' || /^[.…]+$/.test(t)) return true;
        }
        return false;
    }

    /** 指数退避等待时间（毫秒），封顶 15s，避免一直等。 */
    function computeWaitMs(baseMs, backoffFactor, attemptIndex) {
        const raw = Math.round(baseMs * Math.pow(backoffFactor, attemptIndex));
        return Math.max(0, Math.min(15000, raw));
    }

    /** 把各种形状的异常转成人类可读文本（ST 常 throw new Error(jsonObject)）。 */
    function friendlyError(err) {
        if (!err) return '未知错误';
        if (typeof err === 'string') return err;
        const m = err.message;
        if (m && typeof m === 'object') {
            return m.error?.message || m.message || safeJson(m, 300) || '未知错误';
        }
        if (m) {
            // ST 的 tryParseStreamingError 会 throw new Error(jsonObject)，
            // 此时 message 被引擎变成 '[object Object]'，真实信息在酒馆自己的红色 toast 里。
            if (m === '[object Object]') {
                return err.error?.message || '接口返回错误（详情见酒馆红色错误提示）';
            }
            return String(m);
        }
        if (err.error?.message) return String(err.error.message);
        if (err.statusText) return String(err.statusText);
        return safeJson(err, 300) || '未知错误';
    }

    function safeJson(value, maxLen) {
        try {
            const s = JSON.stringify(value);
            if (!s) return '';
            return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
        } catch (_) {
            return String(value) || '';
        }
    }

    /**
     * 创建一次“空回复恢复会话”。
     * 依赖全部由外部注入，便于在 Node 中做单元测试。
     *
     * @param {object} deps
     *  - isEnabled(): boolean           当前总开关
     *  - getOpts(): object              当前设置快照 {maxRetries, useNonStreamFallback, retryDelayMs, backoffFactor, treatPlaceholderAsEmpty}
     *  - getChat(): array               当前聊天消息数组（实时引用）
     *  - isOpenAi(): boolean            当前源是否是 OpenAI 兼容
     *  - generate(): Promise<void>      执行一次 regenerate（失败抛异常）
     *  - setStreaming(value): Promise<boolean>  切换流式开关，返回是否成功
     *  - notify(text, type): void       toast 提示：type ∈ info|warning|error|success
     *  - recordError(err): void         记录异常
     *  - recordEvent(name, extra): void 记录诊断事件
     *  - isAborted(): boolean           是否已被用户中止（stop/发消息/换聊天等）
     *  - delay(ms): Promise<void>       等待
     * @returns {{ run: () => Promise<'recovered'|'failed'|'aborted'|'skipped'> }}
     */
    function createRecoverySession(deps) {
        function lastState() {
            const chat = deps.getChat();
            const last = Array.isArray(chat) && chat.length ? chat[chat.length - 1] : null;
            if (!last) return 'none';
            if (last.is_user) return 'user';
            if (last.is_system) return 'system';
            return isEmptyMessage(last.mes, deps.getOpts()) ? 'empty' : 'content';
        }

        return {
            async run() {
                const opts0 = deps.getOpts();
                if (!deps.isEnabled()) return 'skipped';
                if (lastState() !== 'empty') return 'skipped';

                const fallbackAvailable = !!opts0.useNonStreamFallback && deps.isOpenAi();
                const totalAttempts = Math.max(0, Number(opts0.maxRetries) || 0) + (fallbackAvailable ? 1 : 0);
                if (totalAttempts <= 0) return 'skipped';

                deps.recordEvent('recovery-start', { attempts: totalAttempts, fallback: fallbackAvailable });

                for (let attempt = 0; attempt < totalAttempts; attempt++) {
                    if (deps.isAborted()) return 'aborted';

                    const isFallback = attempt >= (Number(opts0.maxRetries) || 0);
                    const waitMs = computeWaitMs(opts0.retryDelayMs, opts0.backoffFactor, attempt);
                    deps.recordEvent('retry-scheduled', { attempt: attempt + 1, total: totalAttempts, isFallback, waitMs });
                    deps.notify(
                        '检测到空回复，' + Math.max(1, Math.round(waitMs / 1000)) + ' 秒后自动重试' +
                        '（第 ' + (attempt + 1) + '/' + totalAttempts + ' 次' + (isFallback ? '，非流式回退' : '') + '）',
                        'warning'
                    );
                    await deps.delay(waitMs);
                    if (deps.isAborted()) return 'aborted';

                    // 等待期间可能已被其它途径修复 / 用户操作改变了聊天
                    const pre = lastState();
                    if (pre === 'content') { deps.recordEvent('recovered-externally', {}); return 'recovered'; }
                    if (pre === 'none' || pre === 'system') return 'skipped';

                    let toggled = false;
                    if (isFallback) {
                        toggled = await deps.setStreaming(false);
                        if (!toggled) {
                            deps.notify('未能自动切换到非流式（未找到流式设置项）。若仍失败，可在 API 设置中手动关闭“流式(Streaming)”后手动重新生成。', 'warning');
                        }
                    }

                    deps.recordEvent('generate', { attempt: attempt + 1, isFallback, streamingToggled: toggled });
                    try {
                        await deps.generate();
                    } catch (err) {
                        deps.recordError(err);
                        deps.notify('第 ' + (attempt + 1) + ' 次重试失败：' + friendlyError(err), 'error');
                    } finally {
                        // 无论成败都恢复流式开关，避免影响用户后续使用
                        if (toggled) {
                            try { await deps.setStreaming(true); } catch (_) { /* ignore */ }
                        }
                    }

                    if (deps.isAborted()) return 'aborted';

                    const after = lastState();
                    if (after === 'content') { deps.recordEvent('recovered', { attempt: attempt + 1, isFallback }); return 'recovered'; }
                    if (after === 'none') return 'failed';
                    // 'empty' 或 'user'（上一次生成报错导致无消息产出）→ 继续下一轮
                }

                deps.recordEvent('recovery-failed', { attempts: totalAttempts });
                return 'failed';
            },
        };
    }

    // =========================================================
    // v2.0 请求层修复：包装 window.fetch，让酒馆“第一次就不空”
    // =========================================================

    function ergTryJson(s) {
        try { return JSON.parse(s); } catch { return null; }
    }

    /** 按行解析 SSE（兼容标准 SSE 与 ndjson / 纯 JSON 行）。 */
    async function* ergParseSSE(reader, decoder) {
        let buffer = '';
        let pendingLines = [];
        const flushEvent = () => {
            if (!pendingLines.length) return null;
            const d = pendingLines.join('\n');
            pendingLines = [];
            return d;
        };
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let m;
            while ((m = /\r?\n/.exec(buffer)) !== null) {
                const line = buffer.slice(0, m.index).replace(/\r$/, '');
                buffer = buffer.slice(m.index + m[0].length);
                if (line === '') {
                    const d = flushEvent();
                    if (d) yield { data: d };
                    continue;
                }
                if (line.startsWith('data:')) {
                    pendingLines.push(line.slice(5).replace(/^ /, ''));
                } else if (!line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('id:') && !line.startsWith('retry:')) {
                    if (ergTryJson(line)) {
                        const d = flushEvent();
                        if (d) yield { data: d };
                        yield { data: line };
                    } else if (typeof console !== 'undefined') {
                        console.debug('[空回守卫] 忽略无法解析的行:', line.slice(0, 160));
                    }
                }
            }
        }
        if (buffer.trim()) {
            const line = buffer.replace(/\r$/, '');
            if (line.startsWith('data:')) pendingLines.push(line.slice(5).replace(/^ /, ''));
            else if (ergTryJson(line)) {
                const d = flushEvent();
                if (d) yield { data: d };
                yield { data: line };
            }
        }
        const d = flushEvent();
        if (d) yield { data: d };
    }

    /** 从任意 OpenAI 兼容 chunk/响应里提取“正文文本”（思考不算正文）。 */
    function ergExtractContentText(obj) {
        if (!obj || typeof obj !== 'object') return '';
        const parts = [];
        const choices = Array.isArray(obj.choices) ? obj.choices : [];
        for (const c of choices) {
            let t = '';
            const d = c && c.delta;
            if (d) {
                if (typeof d.content === 'string') t = d.content;
                else if (Array.isArray(d.content)) t = d.content.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('');
                else if (typeof d.text === 'string') t = d.text;
            } else {
                const m = c && c.message;
                if (m && typeof m.content === 'string') t = m.content;
                else if (m && Array.isArray(m.content)) t = m.content.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('');
                else if (c && typeof c.text === 'string') t = c.text;
            }
            if (t) parts.push(t);
        }
        if (!parts.length && Array.isArray(obj.candidates)) {
            const partsArr = obj.candidates[0]?.content?.parts;
            if (Array.isArray(partsArr)) {
                const t = partsArr.map((p) => (p && typeof p.text === 'string' && !p.thought) ? p.text : '').join('');
                if (t) parts.push(t);
            }
        }
        return parts.join('');
    }

    /** 是否包含工具调用(tool_calls)。 */
    function ergHasToolCalls(obj) {
        if (!obj || typeof obj !== 'object') return false;
        const choices = Array.isArray(obj.choices) ? obj.choices : [];
        for (const c of choices) {
            if (!c) continue;
            if (c.delta && Array.isArray(c.delta.tool_calls) && c.delta.tool_calls.length) return true;
            if (c.message && Array.isArray(c.message.tool_calls) && c.message.tool_calls.length) return true;
        }
        return false;
    }

    /**
     * 判断错误消息是否为“空流类”错误（中转站 Claude 渠道常见）：
     *   empty_stream: 上游返回空流 (无 contentBlock) / 空流 / empty response ...
     * 这类错误应视为“空流”处理（自动重试 + 非流式兜底），而不是透传给酒馆报错。
     */
    function ergIsEmptyStreamError(msg) {
        const m = String(msg || '');
        return /empty[\s_-]?stream|空流|no content[\s_-]?block|empty response|无 contentblock|stream.*empty/i.test(m);
    }

    /**
     * 创建 fetch 守卫包装器（纯逻辑，可在 Node 测试）。
     * @param {object} deps
     *  - fetchImpl: 原始 fetch 实现
     *  - getOptions(): {enabled, maxRetries, fallbackNonStream, delayMs}
     *  - log(msg): void
     *  - isTarget(inputStr, bodyJson): boolean —— 是否拦截此请求
     * @returns {(input: any, init?: any) => Promise<Response>}
     */
    function createFetchGuard(deps) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const TOOLCALL_HINT = '上游只返回了工具调用(tool calls)、没有正文内容。多半是当前客户端/预设开启了“工具/函数调用”而该中转站或渠道不支持，请关闭工具调用后再试。';

        async function doFetch(input, init, bodyJson, stream) {
            const req = (typeof input === 'string' || input instanceof URL)
                ? new Request(String(input), { ...init, body: JSON.stringify({ ...bodyJson, stream: !!stream }) })
                : new Request(input, { ...init, body: JSON.stringify({ ...bodyJson, stream: !!stream }) });
            return await deps.fetchImpl(req);
        }

        function enq(controller, enc, s) { try { controller.enqueue(enc.encode(s)); } catch (_) { /* closed */ } }

        async function handleStreaming(controller, enc, input, init, bodyJson, opts) {
            const maxAttempts = 1 + Math.max(0, Number(opts.maxRetries) || 0);
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (attempt > 0) {
                    deps.log('空流，第 ' + attempt + '/' + opts.maxRetries + ' 次自动重试（请求层）...');
                    await sleep(opts.delayMs);
                }
                const resp = await doFetch(input, init, bodyJson, true);
                if (!resp.ok) {
                    const errText = await resp.clone().text().catch(() => '');
                    deps.log('生成请求失败 status=' + resp.status);
                    if (resp.status >= 500 && attempt < maxAttempts - 1) {
                        // v2.5.0：5xx 属于渠道临时故障，自动重试而不是直接报错
                        deps.log('5xx 错误（渠道可能临时故障），自动重试...');
                        continue;
                    }
                    enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: '生成请求失败：' + resp.status + ' ' + String(errText).slice(0, 200) } }) + '\n\n');
                    return;
                }
                const outcome = await streamRewrite(controller, enc, resp);
                if (outcome === 'ok') return;
                if (outcome === 'toolcalls') {
                    deps.log('上游只返回了工具调用，没有正文');
                    enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: TOOLCALL_HINT } }) + '\n\n');
                    return;
                }
                if (outcome === 'error') return; // 错误已发给酒馆显示，不再重试
                // 'empty' → 继续下一轮重试
            }

            if (opts.fallbackNonStream) {
                deps.log('流式重试仍为空，改用非流式兜底...');
                // 非流式兜底最多尝试 2 次（空流类错误 / 5xx / 空内容时再来一次）
                const fallbackTries = 2;
                for (let t = 0; t < fallbackTries; t++) {
                    if (t > 0) {
                        deps.log('非流式兜底第 ' + (t + 1) + '/' + fallbackTries + ' 次...');
                        await sleep(opts.delayMs);
                    }
                    const resp = await doFetch(input, init, bodyJson, false);
                    if (resp.ok) {
                        const json = await resp.json().catch(() => null);
                        const text = json ? ergExtractContentText(json) : '';
                        if (text) {
                            const chunk = {
                                id: (json && json.id) || ('chatcmpl-' + Date.now()),
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: (json && json.model) || '',
                                choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: (json && json.choices && json.choices[0] && json.choices[0].finish_reason) || 'stop' }],
                            };
                            enq(controller, enc, 'data: ' + JSON.stringify(chunk) + '\n\n');
                            deps.log('非流式兜底成功（已转成 SSE 回给酒馆）');
                            return;
                        }
                        if (json && json.error) {
                            const rawMsg = String(json.error.message || '');
                            if (ergIsEmptyStreamError(rawMsg) && t < fallbackTries - 1) {
                                deps.log('兜底遇到空流类错误，继续重试');
                                continue;
                            }
                            enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: json.error.message || '上游错误' } }) + '\n\n');
                            return;
                        }
                        // 响应 200 但无正文且无错误信息：再试一次
                        if (t < fallbackTries - 1) continue;
                    } else if (resp.status >= 500 && t < fallbackTries - 1) {
                        deps.log('兜底请求 5xx，继续重试');
                        continue;
                    }
                    enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: '非流式兜底失败（上游返回 ' + resp.status + '，详情见控制台/扩展日志）' } }) + '\n\n');
                    return;
                }
                enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: '上游连续 ' + maxAttempts + ' 次返回空流，且非流式兜底失败（详情见控制台/扩展日志）' } }) + '\n\n');
                return;
            }
            enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: '上游连续 ' + maxAttempts + ' 次返回空流（空回守卫已自动重试，仍未成功）' } }) + '\n\n');
        }

        /** 消费上游流：缓冲至出现正文再开闸；返回 'ok' | 'empty' | 'toolcalls' | 'error'。 */
        async function streamRewrite(controller, enc, resp) {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let contentSeen = false;
            let toolCallsSeen = false;
            let errorSeen = false;
            let opened = false;
            const pending = [];
            const LIMIT = 400;
            for await (const ev of ergParseSSE(reader, decoder)) {
                const d = ev.data;
                if (d === '[DONE]') break;
                const json = ergTryJson(d);
                if (json && json.error) {
                    const rawMsg = String(json.error.message || json.error.type || '未知错误');
                    const msg = '上游在流内返回错误: ' + rawMsg;
                    deps.log(msg);
                    // 空流类错误（中转站 Claude 渠道常见，如 "empty_stream: 上游返回空流 (无 contentBlock)"）
                    // → 当作“空流”处理，走自动重试/非流式兜底，而不是透传报错
                    if (!opened && ergIsEmptyStreamError(rawMsg)) {
                        deps.log('识别为空流类错误，按空流处理（自动重试 / 非流式兜底）');
                        return 'empty';
                    }
                    const errSSE = 'data: ' + JSON.stringify({ error: { message: msg } }) + '\n\n';
                    if (opened) enq(controller, enc, errSSE);
                    else pending.push(errSSE);
                    errorSeen = true;
                    break;
                }
                if (ergHasToolCalls(json)) toolCallsSeen = true;
                const text = ergExtractContentText(json);
                const norm = 'data: ' + d + '\n\n';
                if (text) {
                    contentSeen = true;
                    if (!opened) {
                        for (const p of pending) enq(controller, enc, p);
                        opened = true;
                    }
                    enq(controller, enc, norm);
                } else if (opened) {
                    enq(controller, enc, norm);
                } else if (pending.length < LIMIT) {
                    pending.push(norm);
                }
            }
            try { await reader.cancel(); } catch (_) { /* ignore */ }
            if (contentSeen) return 'ok';
            if (errorSeen) {
                // 未开闸时把缓冲（含错误信息）补发给酒馆，让酒馆显示真实报错
                if (!opened) for (const p of pending) enq(controller, enc, p);
                return 'error';
            }
            return toolCallsSeen ? 'toolcalls' : 'empty';
        }

        /**
         * 非流式请求守卫（v2.4.0）：客户端关闭流式时也生效。
         * 上游返回空内容/空流类错误 → 自动重试；仍空 → 返回可读结果。
         * @returns {{status:number, json:object}}
         */
        async function guardPlain(input, init, bodyJson, opts) {
            const maxAttempts = 1 + Math.max(0, Number(opts.maxRetries) || 0);
            let lastJson = null;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (attempt > 0) {
                    deps.log('非流式空内容，第 ' + attempt + '/' + opts.maxRetries + ' 次自动重试...');
                    await sleep(opts.delayMs);
                }
                const resp = await doFetch(input, init, bodyJson, false);
                if (!resp.ok) {
                    const text = await resp.clone().text().catch(() => '');
                    const errJson = tryJsonParse(text);
                    if (errJson && errJson.error) return { status: resp.status, json: errJson };
                    if (resp.status >= 500 && attempt < maxAttempts - 1) {
                        deps.log('上游 5xx status=' + resp.status + '，自动重试...');
                        continue;
                    }
                    return { status: resp.status, json: { error: { message: '生成请求失败：' + resp.status + ' ' + String(text).slice(0, 200) } } };
                }
                const json = await resp.json().catch(() => null);
                lastJson = json;
                if (json && json.error) {
                    const rawMsg = String(json.error.message || '');
                    if (ergIsEmptyStreamError(rawMsg) && attempt < maxAttempts - 1) {
                        deps.log('非流式遇到空流类错误，继续重试...');
                        continue;
                    }
                    return { status: resp.status, json };
                }
                const text = json ? ergExtractContentText(json) : '';
                if (text) return { status: 200, json };
                if (ergHasToolCalls(json)) {
                    deps.log('上游只返回了工具调用，没有正文');
                    return { status: 200, json: { error: { message: TOOLCALL_HINT } } };
                }
                // 空内容 → 下一轮重试
            }
            // 重试用尽：返回最后一次响应（如果存在）
            if (lastJson) return { status: 200, json: lastJson };
            return { status: 502, json: { error: { message: '上游连续 ' + maxAttempts + ' 次返回空内容（空回守卫已自动重试）' } } };
        }

        function tryJsonParse(s) {
            try { return JSON.parse(s); } catch { return null; }
        }

        return async function guardedFetch(input, init) {
            const opts = deps.getOptions();
            if (!opts || !opts.enabled) return deps.fetchImpl(input, init);
            let bodyJson = null;
            try {
                if (typeof input === 'string' || input instanceof URL) {
                    if (init && typeof init.body === 'string') bodyJson = JSON.parse(init.body);
                } else if (input instanceof Request && !input.bodyUsed) {
                    bodyJson = JSON.parse(await input.clone().text());
                }
            } catch (_) { bodyJson = null; }
            if (!bodyJson || !deps.isTarget(String(input), bodyJson)) {
                return deps.fetchImpl(input, init);
            }
            // v2.8.0 长输出保护：单轮 max_tokens 过大 → 发送前钳制（防止超长输出撞爆渠道超时）
            let sendBody = bodyJson;
            const maxOut = Number(opts.maxOutputTokens) || 0;
            if (maxOut > 0 && Number(bodyJson.max_tokens) > maxOut) {
                deps.log('检测到超大单轮输出 max_tokens=' + bodyJson.max_tokens + '，发送前钳制为 ' + maxOut + '（防止长输出被渠道超时掐断，配合酒馆“自动续写”更佳）');
                sendBody = { ...bodyJson, max_tokens: maxOut };
            }
            deps.log('拦截生成请求（请求层修复）：model=' + (sendBody.model || '(未指定)') + (Array.isArray(sendBody.tools) && sendBody.tools.length ? '（带 tools）' : ''));
            if (bodyJson.stream) {
                // 流式请求：缓冲+空流重试+非流式兜底，输出标准 SSE
                const enc = new TextEncoder();
                const out = new ReadableStream({
                    async start(controller) {
                        try {
                            await handleStreaming(controller, enc, input, init, sendBody, opts);
                        } catch (e) {
                            enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: '空回守卫请求层错误: ' + ((e && e.message) || e) } }) + '\n\n');
                        } finally {
                            enq(controller, enc, 'data: [DONE]\n\n');
                            try { controller.close(); } catch (_) { /* already closed */ }
                        }
                    },
                });
                return new Response(out, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store' },
                });
            }
            // 非流式请求：空内容自动重试，仍按 JSON 返回
            const result = await guardPlain(input, init, sendBody, opts);
            return new Response(JSON.stringify(result.json), {
                status: result.status,
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            });
        };
    }

    // =========================================================
    // 上下文护栏（v2.3.0）：防止 token 超限导致空回
    // =========================================================

    /**
     * 计算“需要裁剪哪些消息”的纯决策函数（可单测）。
     * @param {array} chat 消息数组 [{is_user,is_system,mes,...}]
     * @param {object} opts { maxTokens, threshold, minKeep, estimateTokens: (text)=>number }
     * @returns {{totalTokens:number, targetTokens:number, remove:number[], safe:boolean}}
     */
    function planContextTrim(chat, opts) {
        const msgs = Array.isArray(chat) ? chat : [];
        const { maxTokens, threshold, minKeep, estimateTokens } = opts;
        const N = msgs.length;
        if (!maxTokens || maxTokens <= 0 || !N) return { totalTokens: 0, targetTokens: 0, remove: [], safe: true };

        // 逐条估算 token（estimateTokens 注入，浏览器里用真 tokenizer，测试用近似）
        const perTok = msgs.map((m) => Math.max(0, estimateTokens(String((m && m.mes) || ''))));
        const totalTokens = perTok.reduce((a, b) => a + b, 0);
        const targetTokens = Math.max(1, Math.round(maxTokens * threshold));

        // 需要删掉的 token 量（留一点余量：多删 5% 避免二次触发）
        const needRemove = Math.max(0, totalTokens - Math.floor(targetTokens * 0.95));
        if (needRemove === 0) return { totalTokens, targetTokens, remove: [], safe: true };

        // 可删范围（第一轮）：保留第一条（定场）和最后 minKeep 条
        const keepTail = Math.max(2, minKeep);
        const removableLo = 1;                       // 永远保留 msgs[0]
        let toRemove = 0;
        const remove = [];
        const consider = (list) => {
            for (const i of list) {
                if (toRemove >= needRemove) break;
                if (remove.includes(i)) continue;
                remove.push(i);
                toRemove += perTok[i];
            }
        };
        const firstRound = [];
        for (let i = removableLo; i <= Math.min(N - keepTail - 1, N - 2); i++) firstRound.push(i);
        consider(firstRound);
        if (toRemove < needRemove) {
            // 第二轮：放宽保护区（只保留第一条 + 末尾 2 条）
            const secondRound = [];
            for (let i = removableLo; i <= N - 3; i++) secondRound.push(i);
            consider(secondRound);
        }
        if (toRemove < needRemove) {
            // 第三轮：保底（只保留第一条 + 末尾 1 条）
            const thirdRound = [];
            for (let i = removableLo; i <= N - 2; i++) thirdRound.push(i);
            consider(thirdRound);
        }
        remove.sort((a, b) => a - b);
        return { totalTokens, targetTokens, remove, safe: toRemove >= needRemove };
    }

    // =========================================================
    // 请求自动瘦身（v2.6.0）：发送前精简完整请求体（含预设/世界书）
    // =========================================================

    /**
     * 纯决策函数（可单测）：截断超长内容 + 超预算裁剪最旧消息。
     * @param {array} chat 消息数组 [{role, content|mes, ...}]
     * @param {object} opts { maxTokens, threshold, maxContentChars, estimateTokens }
     * @returns {{chat:array, clipped:number, trimmed:number, totalTokens:number}}
     */
    function slimChatMessages(chat, opts) {
        const arr = Array.isArray(chat) ? chat.map((m) => ({ ...m })) : [];
        const { maxTokens, threshold, maxContentChars, estimateTokens } = opts;

        // 1) 截断超长单条内容（保留首尾，中间省略）
        let clipped = 0;
        for (const m of arr) {
            const raw = String(m.content ?? m.mes ?? '');
            if (raw.length > maxContentChars) {
                const headLen = Math.floor(maxContentChars * 0.55);
                const tailLen = Math.floor(maxContentChars * 0.35);
                const slim = raw.slice(0, headLen) + '\n…[空回守卫自动精简]…\n' + raw.slice(-tailLen);
                m.content = slim;
                if (m.mes !== undefined) m.mes = slim;
                clipped++;
            }
        }

        // 2) 总预算裁剪（从最早的非第一条消息删起，保留 messages[0]）
        let total = arr.reduce((a, m) => a + Math.max(0, estimateTokens(String(m.content ?? m.mes ?? ''))), 0);
        const target = Math.max(1, Math.round(maxTokens * threshold));
        let trimmed = 0;
        let idx = 1;
        const hardCap = Math.max(10, arr.length);
        while (total > Math.floor(target * 0.95) && idx < arr.length && trimmed < hardCap) {
            total -= Math.max(0, estimateTokens(String(arr[idx].content ?? arr[idx].mes ?? '')));
            arr.splice(idx, 1);
            trimmed++;
        }
        return { chat: arr, clipped, trimmed, totalTokens: total };
    }

    /**
     * 深瘦身（v2.7.0）：对最长条目做语义摘要替换。
     * @param {array} chat 消息数组
     * @param {object} opts { targetTokens, maxItems, minLen, estimateTokens}
     * @param {(text:string)=>Promise<string|null>} summarize 摘要函数（测试注入 mock）
     * @returns {Promise<{chat:array, summarized:number}>}
     */
    async function deepSlimChat(chat, opts, summarize) {
        const arr = Array.isArray(chat) ? chat : [];
        const { targetTokens, maxItems, minLen, estimateTokens } = opts;
        let summarized = 0;
        const budget = () => arr.reduce((a, m) => a + Math.max(0, estimateTokens(String(m.content ?? m.mes ?? ''))), 0);
        let current = budget();
        const candidates = arr
            .map((m, i) => ({ i, len: String(m.content ?? m.mes ?? '').length }))
            .filter((c) => {
                const m = arr[c.i];
                // 用户本次输入保留；system/assistant（世界书、预设、旧对话）都可被摘要
                return !(m && (m.is_user || m.role === 'user')) && c.len >= minLen;
            })
            .sort((a, b) => b.len - a.len)
            .slice(0, Math.max(1, Number(maxItems) || 2));
        for (const c of candidates) {
            if (current <= targetTokens) break;
            const m = arr[c.i];
            const raw = String(m.content ?? m.mes ?? '');
            let summary = null;
            try { summary = await summarize(raw); } catch (_) { summary = null; }
            if (summary && summary.trim().length >= 15) {
                const slim = '［压缩摘要］' + summary.trim();
                m.content = slim;
                if (m.mes !== undefined) m.mes = slim;
                summarized++;
                current = budget();
            }
        }
        return { chat: arr, summarized };
    }

    // =========================================================
    // 自动换路（v2.10.0）：备用地址解析
    // =========================================================

    /** 解析备用地址列表（逗号/空格/换行分隔），去空、去重、统一加 /v1。 */
    function parseFailoverUrls(raw) {
        const out = [];
        for (const part of String(raw || '').split(/[,，\s\n]+/)) {
            let u = part.trim().replace(/\/+$/, '');
            if (!u) continue;
            if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
            if (!/\/v1$/i.test(u)) u += '/v1';
            if (!out.includes(u)) out.push(u);
        }
        return out;
    }

    /** 选出下一个要尝试的候选地址（排除当前地址和最近已试过的地址）。 */
    function pickNextFailover(currentUrl, allUrls, excludeSet) {
        for (const u of allUrls) {
            if (u === currentUrl) continue;
            if (excludeSet && excludeSet.has(u)) continue;
            return u;
        }
        return null;
    }

    // =========================================================
    // 浏览器/酒馆环境
    // =========================================================
    if (typeof global.document === 'undefined' || !global.document.documentElement) {
        // Node / 测试环境：只导出可测试部分
        if (typeof module !== 'undefined' && module.exports) {
            module.exports = {
                VERSION,
                DEFAULTS,
                isEmptyMessage,
                computeWaitMs,
                friendlyError,
                createRecoverySession,
                createFetchGuard,
                planContextTrim,
                slimChatMessages,
                deepSlimChat,
                parseFailoverUrls,
                pickNextFailover,
            };
        }
        return;
    }

    // ---------- 运行状态 ----------
    const state = {
        busy: false,          // 恢复会话进行中
        abandoned: false,     // 用户中止
        selfGenerating: false, // 正在执行我们发起的 regenerate（忽略其衍生事件）
        session: null,
        recentErrors: [],     // 最近错误（诊断用）
        recentEvents: [],     // 最近事件（诊断用）
        slimHinted: false,    // 请求瘦身首次提示标记
        summaryCache: {},     // 深瘦身摘要缓存（会话级）
        failSeq: 0,           // 连续失败计数（自动换路用）
        failoverTried: [],    // 本轮已试过的地址
        lastFailoverAt: 0,    // 上次换路时间戳
        stats: { detected: 0, recovered: 0, failed: 0, attempts: 0 },
    };

    let settings = { ...DEFAULTS };
    let ctx = null;

    function debugLog(...args) {
        if (settings.debug) console.debug('[EmptyReplyGuard]', ...args);
    }

    function recordError(err) {
        state.recentErrors.push({ at: new Date().toISOString(), text: friendlyError(err) });
        if (state.recentErrors.length > 10) state.recentErrors.shift();
        debugLog('error:', err);
    }

    function recordEvent(name, extra) {
        state.recentEvents.push({ at: new Date().toISOString(), name, ...(extra || {}) });
        if (state.recentEvents.length > 40) state.recentEvents.shift();
        debugLog('event:', name, extra || '');
    }

    function notify(text, type = 'info', timeout = 6000) {
        recordEvent('toast', { text, type });
        try {
            const toastr = global.toastr;
            if (toastr) {
                const fn = toastr[type] || toastr.info;
                fn.call(toastr, text, PLUGIN_NAME, { timeOut: timeout, extendedTimeOut: timeout + 3000 });
            }
        } catch (_) { /* toastr 不存在时静默 */ }
        console.log('[' + PLUGIN_NAME + ']', text);
    }

    // ---------- 设置读写 ----------
    function clampInt(v, min, max, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    }
    function clampFloat(v, min, max, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    function loadSettings() {
        const ext = ctx && ctx.extensionSettings;
        const stored = ext && ext[PLUGIN_KEY] ? ext[PLUGIN_KEY] : {};
        settings = { ...DEFAULTS, ...stored };
        settings.maxRetries = clampInt(settings.maxRetries, 0, 5, DEFAULTS.maxRetries);
        settings.retryDelayMs = clampInt(settings.retryDelayMs, 500, 30000, DEFAULTS.retryDelayMs);
        settings.backoffFactor = clampFloat(settings.backoffFactor, 1, 3, DEFAULTS.backoffFactor);
        settings.fetchMaxRetries = clampInt(settings.fetchMaxRetries, 0, 5, DEFAULTS.fetchMaxRetries);
        settings.contextThreshold = clampFloat(settings.contextThreshold, 0.5, 0.95, DEFAULTS.contextThreshold);
        settings.contextMinKeep = clampInt(settings.contextMinKeep, 2, 50, DEFAULTS.contextMinKeep);
        settings.slimThreshold = clampFloat(settings.slimThreshold, 0.5, 0.95, DEFAULTS.slimThreshold);
        settings.slimMaxContentChars = clampInt(settings.slimMaxContentChars, 500, 20000, DEFAULTS.slimMaxContentChars);
        settings.slimSummaryTargetChars = clampInt(settings.slimSummaryTargetChars, 200, 8000, DEFAULTS.slimSummaryTargetChars);
        settings.slimSummaryMaxItems = clampInt(settings.slimSummaryMaxItems, 1, 5, DEFAULTS.slimSummaryMaxItems);
        settings.longOutputMaxTokens = clampInt(settings.longOutputMaxTokens, 1024, 65536, DEFAULTS.longOutputMaxTokens);
        settings.failoverThreshold = clampInt(settings.failoverThreshold, 1, 20, DEFAULTS.failoverThreshold);
        settings.failoverCooldownSec = clampInt(settings.failoverCooldownSec, 60, 3600, DEFAULTS.failoverCooldownSec);
        if (typeof settings.failoverUrls !== 'string') settings.failoverUrls = DEFAULTS.failoverUrls;
        if (typeof settings.handleTypes !== 'string') settings.handleTypes = DEFAULTS.handleTypes;
    }

    function saveSettings() {
        try {
            if (!ctx || !ctx.extensionSettings) return;
            ctx.extensionSettings[PLUGIN_KEY] = { ...settings };
            if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) {
            debugLog('saveSettings failed', e);
        }
    }

    // ---------- 流式开关 ----------
    function findStreamingSink() {
        // 1) 新版（1.13.5+/1.18）：getContext 直接暴露 chatCompletionSettings（即 oai_settings）
        if (ctx && ctx.chatCompletionSettings && typeof ctx.chatCompletionSettings === 'object' && 'stream_openai' in ctx.chatCompletionSettings) {
            return { kind: 'obj', obj: ctx.chatCompletionSettings };
        }
        // 2) 个别构建把 oai_settings 挂到了全局
        if (global.oai_settings && typeof global.oai_settings === 'object' && 'stream_openai' in global.oai_settings) {
            return { kind: 'obj', obj: global.oai_settings };
        }
        // 3) 老版本：退回 UI 复选框（候选 id）
        const $ = global.jQuery;
        if ($) {
            const ids = ['#stream_toggle', '#stream_openai'];
            for (const id of ids) {
                const el = $(id);
                if (el && el.length) return { kind: 'ui', el };
            }
            // 4) 在聊天补全设置面板里按可见文案找复选框（兜底）
            const panel = $('#chat_completion_settings, #openai_settings').filter(':visible').first();
            if (panel.length) {
                const hit = panel.find('input[type=checkbox]').filter(function () {
                    const label = $(this).closest('label').text() || '';
                    return /streaming|流式|stream/i.test(label);
                }).first();
                if (hit.length) return { kind: 'ui', el: hit };
            }
        }
        return null;
    }

    async function setStreaming(value) {
        const sink = findStreamingSink();
        if (!sink) return false;
        try {
            if (sink.kind === 'obj') {
                sink.obj.stream_openai = !!value;
                if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
            } else {
                sink.el.prop('checked', !!value).trigger('change');
            }
            debugLog('stream_openai ->', !!value);
            return true;
        } catch (e) {
            debugLog('setStreaming failed', e);
            return false;
        }
    }

    // ---------- 中止条件 ----------
    function abandon(reason) {
        if (!state.busy) return;
        state.abandoned = true;
        recordEvent('abandoned', { reason });
        debugLog('aborted:', reason);
    }

    function isAborted() {
        return state.abandoned;
    }

    // ---------- 恢复会话接线 ----------
    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function buildSessionDeps() {
        return {
            isEnabled: () => !!settings.enabled,
            getOpts: () => ({ ...settings }),
            getChat: () => (ctx && Array.isArray(ctx.chat) ? ctx.chat : []),
            isOpenAi: () => ctx && ctx.mainApi === 'openai',
            generate: async () => {
                if (!ctx || typeof ctx.generate !== 'function') {
                    throw new Error('当前版本未暴露 generate API（getContext().generate），无法自动重试。');
                }
                state.selfGenerating = true;
                state.stats.attempts += 1;
                try {
                    // 官方“重新生成最后一条消息”入口：会先删除最后一条（空）消息再按原上下文生成
                    await ctx.generate('regenerate', {});
                } finally {
                    state.selfGenerating = false;
                }
            },
            setStreaming: (v) => setStreaming(v),
            notify,
            recordError,
            recordEvent,
            isAborted,
            delay,
        };
    }

    function refreshStatsUi() {
        const el = global.document && document.getElementById('erg_stats');
        if (!el) return;
        const s = state.stats;
        el.textContent = '检测空回复 ' + s.detected + ' 次 · 自动修复成功 ' + s.recovered + ' 次 · 失败 ' + s.failed + ' 次 · 共重试 ' + s.attempts + ' 次';
    }

    async function handleVerdict(verdict) {
        debugLog('verdict:', verdict);
        if (verdict === 'recovered') {
            state.stats.recovered += 1;
            notify('空回复已自动修复 ✔', 'success', 5000);
        } else if (verdict === 'failed') {
            state.stats.failed += 1;
            bumpFailSeq();
            const errs = state.recentErrors.slice(-3).map((e) => e.text);
            notify(
                '空回复自动修复失败（已重试）。' +
                (errs.length ? '接口报错：' + errs.join(' | ') : '接口始终没有返回内容。') +
                ' 建议点击设置面板“复制诊断信息”排查；也可在 API 设置中尝试关闭“流式(Streaming)”。',
                'error', 12000
            );
        }
        refreshStatsUi();
    }

    async function startRecoverySession() {
        if (state.busy) return;
        state.busy = true;
        state.abandoned = false;
        state.session = createRecoverySession(buildSessionDeps());
        state.stats.detected += 1;
        refreshStatsUi();
        try {
            const verdict = await state.session.run();
            await handleVerdict(verdict);
        } catch (e) {
            recordError(e);
            debugLog('recovery crashed', e);
        } finally {
            state.session = null;
            state.busy = false;
            refreshStatsUi();
        }
    }

    // ---------- 上下文护栏（v2.3.0）----------
    function estimateTokenByChars(text) {
        // 无 tokenizer 可用时的字符近似（足够做护栏判断）
        return Math.max(1, Math.round(String(text).length / 2));
    }

    async function estimateChatTokensTotal(chat) {
        const text = chat.map((m) => String((m && m.mes) || '')).join('\n');
        try {
            if (typeof ctx.getTokenCountAsync === 'function') {
                return await ctx.getTokenCountAsync(text, 0);
            }
            if (typeof ctx.getTokenCount === 'function') {
                return await ctx.getTokenCount(text, 0);
            }
        } catch (_) { /* fallthrough */ }
        return Math.round(text.length / 2);
    }

    async function runContextGuard() {
        try {
            if (!settings.enabled || !settings.enableContextGuard || !ctx || !Array.isArray(ctx.chat)) return;
            const chat = ctx.chat;
            const maxTokens = Number(ctx.maxContext || 0);
            if (!maxTokens || chat.length < 3) return;

            let total = 0;
            try {
                total = await estimateChatTokensTotal(chat);
            } catch (_) {
                total = chat.reduce((a, m) => a + estimateTokenByChars(String((m && m.mes) || '')), 0);
            }

            const plan = planContextTrim(chat, {
                maxTokens,
                threshold: settings.contextThreshold,
                minKeep: settings.contextMinKeep,
                estimateTokens: estimateTokenByChars,
            });
            const pct = Math.round((total / maxTokens) * 100);
            if (plan.safe) {
                debugLog('上下文占用安全: ' + pct + '%');
                return;
            }
            if (plan.remove.length === 0) {
                // 删无可删（比如消息太少）仍超限 → 只能提醒
                notify('上下文已达 ' + pct + '%（上限约 ' + maxTokens + ' tokens），但消息太少无法自动裁剪，建议精简世界书或清理聊天。', 'warning', 10000);
                recordEvent('context-warn', { pct, unableToTrim: true });
                return;
            }

            if (!settings.contextAutoTrim) {
                notify('上下文已达 ' + pct + '%（上限约 ' + maxTokens + ' tokens）。接近满分容易导致 token 超限空回，建议清理旧消息或开“自动裁剪”。', 'warning', 10000);
                recordEvent('context-warn', { pct });
                return;
            }

            // 从后往前删除（保持索引有效）
            const removeSorted = [...plan.remove].sort((a, b) => b - a);
            for (const idx of removeSorted) {
                if (idx > 0 && idx < chat.length) chat.splice(idx, 1);
            }
            if (removeSorted.length && typeof ctx.saveChat === 'function') {
                try { ctx.saveChat(); } catch (_) { /* ignore */ }
            }
            notify('上下文已达 ' + pct + '%，已自动裁剪最旧消息 ' + removeSorted.length + ' 条（防止 token 超限空回）。', 'warning', 8000);
            recordEvent('context-trim', { pct, removed: removeSorted.length });
            debugLog('context trim removed:', removeSorted.length);
        } catch (e) {
            debugLog('runContextGuard failed', e);
        }
    }

    function scheduleContextGuard() {
        if (!settings.enabled || !settings.enableContextGuard) return;
        // 消息入列后再算（延迟一点让聊天数组更新完成）
        setTimeout(() => { runContextGuard(); }, 400);
    }

    // ---------- 自动换路（v2.10.0）----------
    function currentApiUrl() {
        if (!ctx || !ctx.chatCompletionSettings) return '';
        return String(ctx.chatCompletionSettings.custom_url || ctx.chatCompletionSettings.reverse_proxy || '');
    }

    /** 探测地址连通性（GET /v1/models，无需 key——能收到 HTTP 响应即连通）。 */
    async function probeUrl(u) {
        try {
            const base = String(u).replace(/\/+$/, '');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                const resp = await fetch(base + '/models', { method: 'GET', signal: controller.signal, cache: 'no-store' });
                return resp.status >= 200 && resp.status < 600; // 200/401/403 都说明链路通
            } finally {
                clearTimeout(timer);
            }
        } catch (_) {
            return false;
        }
    }

    async function performFailover() {
        try {
            if (!settings.enabled || !settings.enableFailover) return;
            const cc = ctx && ctx.chatCompletionSettings;
            if (!cc) return;
            const now = Date.now();
            if (now - state.lastFailoverAt < settings.failoverCooldownSec * 1000) return; // 冷却中
            const cur = currentApiUrl();
            const all = parseFailoverUrls(settings.failoverUrls);
            if (all.length < 2) return;
            const candidate = pickNextFailover(cur, all, new Set(state.failoverTried));
            if (!candidate) {
                // 全部试过一轮：重置试过列表，静默回家
                state.failoverTried = [];
                return;
            }
            // 先探测再切（避免切到同样坏的线路）
            const ok = await probeUrl(candidate);
            if (!ok) {
                state.failoverTried.push(candidate);
                debugLog('备用地址不可达，跳过:', candidate);
                return;
            }
            // 写入酒馆设置并保存
            if (typeof cc.custom_url === 'string' && cc.custom_url) cc.custom_url = candidate;
            else cc.reverse_proxy = candidate;
            if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
            state.failoverTried = [];
            state.lastFailoverAt = now;
            state.failSeq = 0;
            recordEvent('failover', { from: cur, to: candidate });
            debugLog('已自动切换 API 地址: ' + candidate);
            notify('已自动切换备用线路（' + candidate.replace(/^https?:\/\//, '') + '），无需任何操作。', 'info', 6000);
        } catch (e) {
            debugLog('performFailover failed', e);
        }
    }

    function bumpFailSeq() {
        if (!settings.enabled || !settings.enableFailover) return;
        state.failSeq += 1;
        if (state.failSeq >= settings.failoverThreshold) {
            state.failSeq = 0;
            performFailover();
        }
    }

    // ---------- 请求自动瘦身（v2.6.0 / 深瘦身 v2.7.0）----------
    async function summarizeText(text) {
        try {
            if (!ctx || typeof ctx.sendGenerationRequest !== 'function') return null;
            const targetChars = settings.slimSummaryTargetChars;
            const prompt = [
                { role: 'system', content: '你是内容压缩助手。把用户提供的内容压缩成要点摘要，保留关键设定、人名、地点、数字和重要细节，不要客套话，输出纯文本。' },
                { role: 'user', content: '请把以下内容压缩为不超过约 ' + targetChars + ' 个字符的要点摘要：\n\n' + String(text).slice(0, 24000) },
            ];
            // type='quiet'：走酒馆当前配置的模型与 key，且强制非流式；不写入聊天
            const data = await ctx.sendGenerationRequest('quiet', { prompt }, {});
            const out = data?.choices?.[0]?.message?.content;
            if (typeof out === 'string' && out.trim().length >= 15) return out.trim();
        } catch (e) {
            debugLog('深瘦身摘要请求失败:', e);
        }
        return null;
    }

    async function handlePromptReady(data) {
        if (!settings.enabled || !settings.enableSlimPrompt || !data || !Array.isArray(data.chat) || data.dryRun) return;
        const maxTokens = Number(ctx.maxContext || 0);
        if (!maxTokens || data.chat.length === 0) return;
        try {
            // 快速字符估算判断是否超线（不逐条调 tokenizer，省性能）
            const estByChars = (t) => Math.max(1, Math.round(String(t).length / 2));
            const rough = data.chat.reduce((a, m) => a + estByChars(String(m.content ?? m.mes ?? '')), 0);
            if (rough <= maxTokens * settings.slimThreshold * 1.1) return; // 明显安全则跳过
            const result = slimChatMessages(data.chat, {
                maxTokens,
                threshold: settings.slimThreshold,
                maxContentChars: settings.slimMaxContentChars,
                estimateTokens: estByChars,
            });
            // 深瘦身：截断/裁剪后仍超预算 → 对最长条目做语义摘要
            let summarized = 0;
            const targetForDeep = Math.max(1, Math.round(maxTokens * settings.slimThreshold * 0.95));
            if (settings.enableDeepSlim) {
                const cache = state.summaryCache;
                const deepResult = await deepSlimChat(result.chat, {
                    targetTokens: targetForDeep,
                    maxItems: settings.slimSummaryMaxItems,
                    minLen: 2000,
                    estimateTokens: estByChars,
                }, async (raw) => {
                    const key = raw.slice(0, 80) + ':' + raw.length;
                    if (cache[key] !== undefined) return cache[key];
                    const s = await summarizeText(raw);
                    cache[key] = s || null;
                    return s;
                });
                result.chat = deepResult.chat;
                summarized = deepResult.summarized;
            }
            // 写回原数组（事件负载可能被酒馆继续引用）
            data.chat.length = 0;
            for (const m of result.chat) data.chat.push(m);
            if (result.clipped || result.trimmed || summarized) {
                recordEvent('slim-prompt', { clipped: result.clipped, trimmed: result.trimmed, summarized, total: result.totalTokens });
                debugLog('请求瘦身: 截断 ' + result.clipped + ' 条 / 删除 ' + result.trimmed + ' 条 / 摘要 ' + summarized + ' 条');
                if (!state.slimHinted) {
                    state.slimHinted = true;
                    notify('请求自动瘦身已生效：超长预设/世界书内容会在发送前自动精简或压缩成摘要（不修改存档）。', 'info', 8000);
                }
            }
        } catch (e) {
            debugLog('handlePromptReady failed', e);
        }
    }

    // ---------- 事件接线 ----------
    function handleMessageReceived(messageId, type) {
        if (!settings.enabled || state.busy) return;
        if (!ctx || !Array.isArray(ctx.chat)) return;

        const normType = String(type ?? 'normal').toLowerCase();
        const allowed = String(settings.handleTypes || '')
            .split(',')
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean);
        if (!allowed.includes(normType)) return;

        const idx = Number(messageId);
        if (!Number.isInteger(idx) || idx < 0 || idx >= ctx.chat.length) return;
        const msg = ctx.chat[idx];
        if (!msg || msg.is_user || msg.is_system) return;
        // 成功收到一条回复 → 线路健康，失败计数清零
        if (state.failSeq > 0 && !isEmptyMessage(msg.mes, settings)) {
            state.failSeq = 0;
        }
        // 只处理“最后一条消息”为空的情况（regenerate 语义所在）
        if (idx !== ctx.chat.length - 1) return;
        if (!isEmptyMessage(msg.mes, settings)) return;

        debugLog('empty reply detected:', idx, JSON.stringify(String(msg.mes).slice(0, 80)));
        startRecoverySession();
    }

    function bindEvents() {
        const et = ctx && (ctx.eventTypes || ctx.event_types);
        if (!ctx || !ctx.eventSource || !et) {
            notify('未找到 eventSource/eventTypes，空回守卫无法监听事件。', 'error');
            return;
        }
        const on = (name, fn) => ctx.eventSource.on(et[name] ?? name, fn);

        on('MESSAGE_RECEIVED', handleMessageReceived);
        // 用户主动中止/切换 → 停止重试
        on('GENERATION_STOPPED', () => { if (!state.selfGenerating) abandon('用户停止了生成'); });
        on('MESSAGE_SENT', () => { abandon('用户发送了新消息'); scheduleContextGuard(); });
        on('MESSAGE_SWIPED', () => { if (!state.selfGenerating) abandon('用户切换了 swipes'); });
        on('CHAT_CHANGED', () => abandon('切换了聊天'));
        on('MESSAGE_DELETED', () => { if (!state.selfGenerating) abandon('消息被删除'); });
        // 请求自动瘦身：在酒馆组装完发送内容之后、发出请求之前精简
        if (et.CHAT_COMPLETION_PROMPT_READY) {
            ctx.eventSource.on(et.CHAT_COMPLETION_PROMPT_READY, handlePromptReady);
        }
        debugLog('events bound');
    }

    // ---------- 设置面板 UI ----------
    function buildSettingsHtml() {
        return [
            '<div class="empty-reply-guard-settings">',
            '  <h4 data-i18n="Empty Reply Guard">空回守卫 · Empty Reply Guard <small>v' + VERSION + '</small></h4>',
            '  <small class="erg-hint">自动修复“空回复”（有输入没输出 / 只有 … 占位）：自动重试 → 必要时切非流式再试 → 实时显示接口真实报错。适用于 new-api / one-api / 各类中转站。</small>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_enabled"> 启用自动修复</label>',
            '  <div class="erg-row"><span>常规重试次数</span><input type="number" id="erg_max_retries" min="0" max="5" step="1"></div>',
            '  <div class="erg-row"><span>重试间隔(ms)</span><input type="number" id="erg_retry_delay" min="500" max="30000" step="500"></div>',
            '  <div class="erg-row"><span>退避系数</span><input type="number" id="erg_backoff" min="1" max="3" step="0.1"></div>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_fallback"> 常规重试失败后用非流式再试一次</label>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_fetch_enable"> ⭐ 请求层修复（推荐：第一次就不空）</label>',
            '  <div class="erg-row"><span>请求层重试次数</span><input type="number" id="erg_fetch_retries" min="0" max="5" step="1"></div>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_fetch_fallback"> 请求层非流式兜底</label>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_placeholder"> 把「...」占位消息视为空回复</label>',
            '  <div class="erg-row"><span>处理的生成类型</span><input type="text" id="erg_handle_types" placeholder="normal, regenerate"></div>',
            '  <h4 class="erg-sub">上下文护栏（防 token 爆掉）</h4>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_ctx_enable"> 发送前检测上下文占用，防止 token 超限空回</label>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_ctx_trim"> 超限时自动裁剪最旧消息（关=仅提醒）</label>',
            '  <div class="erg-row"><span>触发阈值（占用比例）</span><input type="number" id="erg_ctx_threshold" min="0.5" max="0.95" step="0.05"></div>',
            '  <div class="erg-row"><span>最少保留消息条数</span><input type="number" id="erg_ctx_minkeep" min="2" max="50" step="1"></div>',
            '  <h4 class="erg-sub">请求自动瘦身（防预设/世界书过大）</h4>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_slim_enable"> 发送前自动精简超长预设/世界书内容（不修改存档）</label>',
            '  <div class="erg-row"><span>总预算阈值（占 max_context）</span><input type="number" id="erg_slim_threshold" min="0.5" max="0.95" step="0.05"></div>',
            '  <div class="erg-row"><span>单条内容最大字符数</span><input type="number" id="erg_slim_chars" min="500" max="20000" step="500"></div>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_deepslim_enable"> 深瘦身：仍超预算时用模型压缩成摘要（用你自己的 key）</label>',
            '  <div class="erg-row"><span>摘要目标字符数</span><input type="number" id="erg_deepslim_chars" min="200" max="8000" step="100"></div>',
            '  <div class="erg-row"><span>每轮最多摘要条数</span><input type="number" id="erg_deepslim_items" min="1" max="5" step="1"></div>',
            '  <h4 class="erg-sub">长输出保护（防单轮拉满被掐断）</h4>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_long_enable"> 单轮 max_tokens 过大时发送前钳制</label>',
            '  <div class="erg-row"><span>单轮输出上限 tokens</span><input type="number" id="erg_long_max" min="1024" max="65536" step="1024"></div>',
            '  <h4 class="erg-sub">自动换路（连续失败自动切备用线路）</h4>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_fail_enable"> 连续失败 N 次自动切换备用 API 地址（静默）</label>',
            '  <div class="erg-row"><span>备用地址列表</span><input type="text" id="erg_fail_urls" placeholder="https://站1/v1, https://站2/v1"></div>',
            '  <div class="erg-row"><span>触发阈值（连续失败次数）</span><input type="number" id="erg_fail_threshold" min="1" max="20" step="1"></div>',
            '  <label class="checkbox_label"><input type="checkbox" id="erg_debug"> 调试日志（控制台）</label>',
            '  <div class="erg-stats" id="erg_stats"></div>',
            '  <div class="erg-buttons">',
            '    <button id="erg_retry_now">立即重试上一条</button>',
            '    <button id="erg_copy_diag">复制诊断信息</button>',
            '    <button id="erg_reset_stats">清零统计</button>',
            '  </div>',

            '</div>',
        ].join('\n');
    }

    function applySettingsToUi() {
        const $ = global.jQuery;
        if (!$) return;
        $('#erg_enabled').prop('checked', !!settings.enabled);
        $('#erg_max_retries').val(settings.maxRetries);
        $('#erg_retry_delay').val(settings.retryDelayMs);
        $('#erg_backoff').val(settings.backoffFactor);
        $('#erg_fallback').prop('checked', !!settings.useNonStreamFallback);
        $('#erg_fetch_enable').prop('checked', !!settings.enableFetchGuard);
        $('#erg_fetch_retries').val(settings.fetchMaxRetries);
        $('#erg_fetch_fallback').prop('checked', !!settings.fetchFallbackNonStream);
        $('#erg_placeholder').prop('checked', !!settings.treatPlaceholderAsEmpty);
        $('#erg_handle_types').val(settings.handleTypes);
        $('#erg_ctx_enable').prop('checked', !!settings.enableContextGuard);
        $('#erg_ctx_trim').prop('checked', !!settings.contextAutoTrim);
        $('#erg_ctx_threshold').val(settings.contextThreshold);
        $('#erg_ctx_minkeep').val(settings.contextMinKeep);
        $('#erg_slim_enable').prop('checked', !!settings.enableSlimPrompt);
        $('#erg_slim_threshold').val(settings.slimThreshold);
        $('#erg_slim_chars').val(settings.slimMaxContentChars);
        $('#erg_deepslim_enable').prop('checked', !!settings.enableDeepSlim);
        $('#erg_deepslim_chars').val(settings.slimSummaryTargetChars);
        $('#erg_deepslim_items').val(settings.slimSummaryMaxItems);
        $('#erg_long_enable').prop('checked', !!settings.enableLongOutputGuard);
        $('#erg_long_max').val(settings.longOutputMaxTokens);
        $('#erg_fail_enable').prop('checked', !!settings.enableFailover);
        $('#erg_fail_urls').val(settings.failoverUrls);
        $('#erg_fail_threshold').val(settings.failoverThreshold);
        $('#erg_debug').prop('checked', !!settings.debug);
        refreshStatsUi();
    }

    function bindSettingsUi() {
        const $ = global.jQuery;
        if (!$) return;
        $('#erg_enabled').on('change', function () {
            settings.enabled = $(this).prop('checked');
            if (!settings.enabled) abandon('已禁用');
            saveSettings();
        });
        $('#erg_max_retries').on('change', function () {
            settings.maxRetries = clampInt($(this).val(), 0, 5, DEFAULTS.maxRetries);
            $(this).val(settings.maxRetries);
            saveSettings();
        });
        $('#erg_retry_delay').on('change', function () {
            settings.retryDelayMs = clampInt($(this).val(), 500, 30000, DEFAULTS.retryDelayMs);
            $(this).val(settings.retryDelayMs);
            saveSettings();
        });
        $('#erg_backoff').on('change', function () {
            settings.backoffFactor = clampFloat($(this).val(), 1, 3, DEFAULTS.backoffFactor);
            $(this).val(settings.backoffFactor);
            saveSettings();
        });
        $('#erg_fallback').on('change', function () {
            settings.useNonStreamFallback = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_fetch_enable').on('change', function () {
            settings.enableFetchGuard = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_fetch_retries').on('change', function () {
            settings.fetchMaxRetries = clampInt($(this).val(), 0, 5, DEFAULTS.fetchMaxRetries);
            $(this).val(settings.fetchMaxRetries);
            saveSettings();
        });
        $('#erg_fetch_fallback').on('change', function () {
            settings.fetchFallbackNonStream = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_placeholder').on('change', function () {
            settings.treatPlaceholderAsEmpty = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_handle_types').on('change', function () {
            settings.handleTypes = String($(this).val() || '').trim() || DEFAULTS.handleTypes;
            saveSettings();
        });
        $('#erg_ctx_enable').on('change', function () {
            settings.enableContextGuard = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_ctx_trim').on('change', function () {
            settings.contextAutoTrim = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_ctx_threshold').on('change', function () {
            settings.contextThreshold = clampFloat($(this).val(), 0.5, 0.95, DEFAULTS.contextThreshold);
            $(this).val(settings.contextThreshold);
            saveSettings();
        });
        $('#erg_ctx_minkeep').on('change', function () {
            settings.contextMinKeep = clampInt($(this).val(), 2, 50, DEFAULTS.contextMinKeep);
            $(this).val(settings.contextMinKeep);
            saveSettings();
        });
        $('#erg_slim_enable').on('change', function () {
            settings.enableSlimPrompt = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_slim_threshold').on('change', function () {
            settings.slimThreshold = clampFloat($(this).val(), 0.5, 0.95, DEFAULTS.slimThreshold);
            $(this).val(settings.slimThreshold);
            saveSettings();
        });
        $('#erg_slim_chars').on('change', function () {
            settings.slimMaxContentChars = clampInt($(this).val(), 500, 20000, DEFAULTS.slimMaxContentChars);
            $(this).val(settings.slimMaxContentChars);
            saveSettings();
        });
        $('#erg_deepslim_enable').on('change', function () {
            settings.enableDeepSlim = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_deepslim_chars').on('change', function () {
            settings.slimSummaryTargetChars = clampInt($(this).val(), 200, 8000, DEFAULTS.slimSummaryTargetChars);
            $(this).val(settings.slimSummaryTargetChars);
            saveSettings();
        });
        $('#erg_deepslim_items').on('change', function () {
            settings.slimSummaryMaxItems = clampInt($(this).val(), 1, 5, DEFAULTS.slimSummaryMaxItems);
            $(this).val(settings.slimSummaryMaxItems);
            saveSettings();
        });
        $('#erg_long_enable').on('change', function () {
            settings.enableLongOutputGuard = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_long_max').on('change', function () {
            settings.longOutputMaxTokens = clampInt($(this).val(), 1024, 65536, DEFAULTS.longOutputMaxTokens);
            $(this).val(settings.longOutputMaxTokens);
            saveSettings();
        });
        $('#erg_fail_enable').on('change', function () {
            settings.enableFailover = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_fail_urls').on('change', function () {
            settings.failoverUrls = String($(this).val() || '').trim() || DEFAULTS.failoverUrls;
            $(this).val(settings.failoverUrls);
            saveSettings();
        });
        $('#erg_fail_threshold').on('change', function () {
            settings.failoverThreshold = clampInt($(this).val(), 1, 20, DEFAULTS.failoverThreshold);
            $(this).val(settings.failoverThreshold);
            saveSettings();
        });
        $('#erg_debug').on('change', function () {
            settings.debug = $(this).prop('checked');
            saveSettings();
        });
        $('#erg_retry_now').on('click', function () {
            if (state.busy) { notify('正在自动重试中，请稍候…', 'warning'); return; }
            const chat = ctx && ctx.chat;
            const last = Array.isArray(chat) && chat.length ? chat[chat.length - 1] : null;
            if (!last || last.is_user || last.is_system || !isEmptyMessage(last.mes, settings)) {
                notify('当前最后一条消息不是空回复，无需重试。', 'info');
                return;
            }
            startRecoverySession();
        });
        $('#erg_copy_diag').on('click', copyDiagnostics);
        $('#erg_reset_stats').on('click', function () {
            state.stats = { detected: 0, recovered: 0, failed: 0, attempts: 0 };
            state.recentErrors = [];
            state.recentEvents = [];
            refreshStatsUi();
            notify('统计已清零。', 'info');
        });

    }

    // ---------- 诊断 ----------
    function buildDiagnostics() {
        const cc = ctx && ctx.chatCompletionSettings ? ctx.chatCompletionSettings : null;
        const chatTail = Array.isArray(ctx && ctx.chat) ? ctx.chat.slice(-6).map((m) => ({
            is_user: !!m.is_user,
            is_system: !!m.is_system,
            len: (m.mes || '').length,
            swipes: Array.isArray(m.swipes) ? m.swipes.length : null,
        })) : [];
        return {
            plugin: { name: PLUGIN_NAME, version: VERSION },
            generatedAt: new Date().toISOString(),
            settings,
            stats: { ...state.stats },
            api: {
                mainApi: ctx ? ctx.mainApi : null,
                source: cc ? cc.chat_completion_source : null,
                model: cc ? (cc.openai_model || cc.custom_model || null) : null,
                streaming: cc ? cc.stream_openai : null,
                url: cc ? (cc.custom_url || cc.reverse_proxy || null) : null,
            },
            recentErrors: state.recentErrors.slice(-10),
            recentEvents: state.recentEvents.slice(-40),
            chatTail,
            hints: buildHints(),
        };
    }

    function buildHints() {
        const hints = [];
        const cc = ctx && ctx.chatCompletionSettings ? ctx.chatCompletionSettings : null;
        if (cc && cc.stream_openai === false && state.stats.failed > 0) {
            hints.push('已处于非流式模式仍空回：通常说明接口确实没返回内容，请查看 recentErrors（例如额度/负载/模型名错误）。');
        }
        const errs = state.recentErrors.map((e) => e.text).join(' ');
        if (/status 5\d\d|502|503|504|upstream|bad gateway|超时|timeout/i.test(errs)) {
            hints.push('检测到 5xx/超时类报错：多为接口站或其上游渠道临时故障，重试通常可恢复。');
        }
        if (/quota|insufficient|额度|余额|429/i.test(errs)) {
            hints.push('检测到额度/限流类报错：请检查接口站账户余额或订阅额度。');
        }
        if (/invalid token|401|403|key|密钥/i.test(errs)) {
            hints.push('检测到鉴权报错：请检查酒馆里填写的 API Key / 自定义 Headers。');
        }
        if (/model|模型|not found/i.test(errs)) {
            hints.push('检测到模型相关报错：请确认所选模型在该接口站确实可用（模型名一致）。');
        }
        return hints;
    }

    function copyDiagnostics() {
        try {
            const json = JSON.stringify(buildDiagnostics(), null, 2);
            const done = () => notify('诊断信息已复制 ✔（可粘贴给接口站管理员或到反馈帖中）', 'success', 6000);
            if (global.navigator && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(json).then(done, () => legacyCopy(json, done));
            } else {
                legacyCopy(json, done);
            }
        } catch (e) {
            notify('复制失败：' + friendlyError(e), 'error');
        }
    }

    function legacyCopy(text, onDone) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            if (onDone) onDone();
        } catch (e) {
            notify('复制失败，请在控制台执行 EmptyReplyGuardDiag() 查看诊断。', 'error');
        }
    }

    // ---------- 请求层修复安装（v2.0） ----------
    function isTargetFetch(urlStr, bodyJson) {
        try {
            const u = new URL(String(urlStr), global.location ? global.location.href : undefined);
            const p = u.pathname;
            // v2.4.0：流式与非流式生成请求都接管（关流式的用户同样有请求层修复）
            return (p.endsWith('/chat/completions') || p.indexOf('/api/backends/chat-completions/generate') !== -1)
                && bodyJson && typeof bodyJson.stream === 'boolean' && Array.isArray(bodyJson.messages);
        } catch (_) { return false; }
    }

    function installFetchGuard() {
        try {
            if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
            if (window.__ergFetchGuardInstalled) return;
            window.__ergFetchGuardInstalled = true;
            const originalFetch = window.fetch.bind(window);
            window.fetch = createFetchGuard({
                fetchImpl: originalFetch,
                getOptions: () => ({
                    enabled: !!settings.enabled && !!settings.enableFetchGuard,
                    maxRetries: settings.fetchMaxRetries,
                    fallbackNonStream: !!settings.fetchFallbackNonStream,
                    delayMs: 1200,
                    maxOutputTokens: settings.enableLongOutputGuard ? settings.longOutputMaxTokens : 0,
                }),
                log: (msg) => {
                    console.log('[空回守卫]', msg);
                    recordEvent('fetch-guard', { msg });
                    if (/失败|错误|5xx|不可用/i.test(msg)) bumpFailSeq();
                },
                isTarget: isTargetFetch,
            });
            debugLog('请求层修复已安装（window.fetch 已包装）');
        } catch (e) {
            console.warn('[空回守卫] 请求层修复安装失败：', e);
        }
    }

    // ---------- 初始化 ----------
    function tryInit(retriesLeft) {
        if (!global.SillyTavern || typeof global.SillyTavern.getContext !== 'function') {
            if (retriesLeft <= 0) {
                console.warn('[' + PLUGIN_NAME + '] SillyTavern API 未就绪，初始化失败。');
                return;
            }
            setTimeout(() => tryInit(retriesLeft - 1), 500);
            return;
        }
        try {
            ctx = global.SillyTavern.getContext();
        } catch (e) {
            console.warn('[' + PLUGIN_NAME + '] getContext() 失败，稍后重试。', e);
            setTimeout(() => tryInit(retriesLeft - 1), 500);
            return;
        }
        loadSettings();
        installFetchGuard();
        bindEvents();
        const $ = global.jQuery;
        if ($) {
            const $container = $('#extensions_settings');
            if ($container.length) {
                $container.append(buildSettingsHtml());
                applySettingsToUi();
                bindSettingsUi();
            } else {
                console.warn('[' + PLUGIN_NAME + '] 未找到 #extensions_settings 容器，设置面板未挂载。');
            }
        }
        notify('空回守卫已加载（自动修复空回复）。', 'info', 4000);
        console.log('[' + PLUGIN_NAME + '] v' + VERSION + ' loaded. 诊断: EmptyReplyGuardDiag()');
        // 暴露诊断函数，方便用户在控制台调用
        global.EmptyReplyGuardDiag = () => buildDiagnostics();
    }

    tryInit(40); // 最多等 20 秒
})(typeof globalThis !== 'undefined' ? globalThis : this);
