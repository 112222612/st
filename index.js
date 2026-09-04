/*!
 * 空回守卫 Empty Reply Guard v2.2.0
 * 自动检测并修复酒馆(SillyTavern)的“空回复”（仅供私人使用）。
 * v2.0 新增“请求层修复”：包装 window.fetch，在生成请求到达酒馆解析器之前
 * 就完成 空流自动重试 → 非流式兜底 → 格式修复 → 工具调用提示，
 * 让酒馆“第一次就不空”（纯本地运行，不依赖任何服务器）。
 * v2.2 新增：把“空流类错误”（如 empty_stream: 上游返回空流(无 contentBlock)，
 * 常见于中转站 Claude 渠道）也纳入自动重试/非流式兜底，而不是透传报错。
 * License: MIT
 */
(function (global) {
    'use strict';

    const PLUGIN_KEY = 'emptyReplyGuard';
    const PLUGIN_NAME = '空回守卫 · Empty Reply Guard';
    const VERSION = '2.2.0';

    // =========================================================
    // 默认设置（会合并进 extension_settings.emptyReplyGuard）
    // =========================================================
    const DEFAULTS = {
        enabled: true,
        maxRetries: 2,
        useNonStreamFallback: true,
        retryDelayMs: 3500,
        backoffFactor: 1.6,
        treatPlaceholderAsEmpty: true,
        handleTypes: 'normal, regenerate',
        debug: false,
        enableFetchGuard: true,
        fetchMaxRetries: 2,
        fetchFallbackNonStream: true,
    };

    // =========================================================
    // 纯函数部分（Node 测试可直接 require 本文件使用）
    // =========================================================

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

    function computeWaitMs(baseMs, backoffFactor, attemptIndex) {
        const raw = Math.round(baseMs * Math.pow(backoffFactor, attemptIndex));
        return Math.max(0, Math.min(15000, raw));
    }

    function friendlyError(err) {
        if (!err) return '未知错误';
        if (typeof err === 'string') return err;
        const m = err.message;
        if (m && typeof m === 'object') {
            return m.error?.message || m.message || safeJson(m, 300) || '未知错误';
        }
        if (m) {
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

                    const pre = lastState();
                    if (pre === 'content') { deps.recordEvent('recovered-externally', {}); return 'recovered'; }
                    if (pre === 'none' || pre === 'system') return 'skipped';

                    let toggled = false;
                    if (isFallback) {
                        toggled = await deps.setStreaming(false);
                        if (!toggled) {
                            deps.notify('未能自动切换到非流式（未找到流式设置项）。若仍失败，可在 API 设置中手动关闭"流式(Streaming)"后手动重新生成。', 'warning');
                        }
                    }

                    deps.recordEvent('generate', { attempt: attempt + 1, isFallback, streamingToggled: toggled });
                    try {
                        await deps.generate();
                    } catch (err) {
                        deps.recordError(err);
                        deps.notify('第 ' + (attempt + 1) + ' 次重试失败：' + friendlyError(err), 'error');
                    } finally {
                        if (toggled) {
                            try { await deps.setStreaming(true); } catch (_) { /* ignore */ }
                        }
                    }

                    if (deps.isAborted()) return 'aborted';

                    const after = lastState();
                    if (after === 'content') { deps.recordEvent('recovered', { attempt: attempt + 1, isFallback }); return 'recovered'; }
                    if (after === 'none') return 'failed';
                }

                deps.recordEvent('recovery-failed', { attempts: totalAttempts });
                return 'failed';
            },
        };
    }

    // =========================================================
    // v2.0 请求层修复：包装 window.fetch，让酒馆"第一次就不空"
    // =========================================================

    function ergTryJson(s) {
        try { return JSON.parse(s); } catch { return null; }
    }

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
        const TOOLCALL_HINT = '上游只返回了工具调用(tool calls)、没有正文内容。多半是当前客户端/预设开启了"工具/函数调用"而该中转站或渠道不支持，请关闭工具调用后再试。';

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
                    enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: '生成请求失败：' + resp.status + ' ' + String(errText).slice(0, 200) } }) + '\n\n');
                    return;
                }
                const outcome = await streamRewrite(controller, enc, resp);
                if (outcome === 'ok') return;
                if (outcome === 'thinking-only') {
                    deps.log('上游只返回了思考内容，没有正文（thinking-only）');
                    enq(controller, enc, 'data: ' + JSON.stringify({
                        error: { message: '上游模型只输出了思考(reasoning)、没有正文内容。可能是思考链过长导致流中断，建议：1) 缩短预设/上下文 2) 调长超时时间 3) 换用不带 thinking 的模型' }
                    }) + '\n\n');
                    return;
                }
                if (outcome === 'toolcalls') {
                    deps.log('上游只返回了工具调用，没有正文');
                    enq(controller, enc, 'data: ' + JSON.stringify({ error: { message: TOOLCALL_HINT } }) + '\n\n');
                    return;
                }
                if (outcome === 'error') return;
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

        /** 消费上游流：缓冲至出现正文或思考再开闸；返回 'ok' | 'empty' | 'thinking-only' | 'toolcalls' | 'error'。 */
        async function streamRewrite(controller, enc, resp) {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let contentSeen = false;
            let thinkingSeen = false;
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
                const hasThinking = ergHasThinking(json);
                if (hasThinking) thinkingSeen = true;
                const text = ergExtractContentText(json);
                const norm = 'data: ' + d + '\n\n';
                if (text) {
                    contentSeen = true;
                    if (!opened) {
                        for (const p of pending) enq(controller, enc, p);
                        opened = true;
                    }
                    enq(controller, enc, norm);
                } else if (hasThinking) {
                    // 思考 chunk：立即开闸放行，防止缓冲溢出和超时
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
                if (!opened) for (const p of pending) enq(controller, enc, p);
                return 'error';
            }
            if (thinkingSeen) return 'thinking-only';
            return toolCallsSeen ? 'toolcalls' : 'empty';
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
            deps.log('拦截生成请求（请求层修复）：model=' + (bodyJson.model || '(未指定)') + (Array.isArray(bodyJson.tools) && bodyJson.tools.length ? '（带 tools）' : ''));
            const enc = new TextEncoder();
            const out = new ReadableStream({
                async start(controller) {
                    try {
                        await handleStreaming(controller, enc, input, init, bodyJson, opts);
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
        };
    }

    // =========================================================
    // 浏览器/酒馆环境
    // =========================================================
    if (typeof global.document === 'undefined' || !global.document.documentElement) {
        if (typeof module !== 'undefined' && module.exports) {
            module.exports = {
                VERSION,
                DEFAULTS,
                isEmptyMessage,
                computeWaitMs,
                friendlyError,
                createRecoverySession,
                createFetchGuard,
            };
        }
        return;
    }

    // ---------- 运行状态 ----------
    const state = {
        busy: false,
        abandoned: false,
        selfGenerating: false,
        session: null,
        recentErrors: [],
        recentEvents: [],
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
        if (ctx && ctx.chatCompletionSettings && typeof ctx.chatCompletionSettings === 'object' && 'stream_openai' in ctx.chatCompletionSettings) {
            return { kind: 'obj', obj: ctx.chatCompletionSettings };
        }
        if (global.oai_settings && typeof global.oai_settings === 'object' && 'stream_openai' in global.oai_settings) {
            return { kind: 'obj', obj: global.oai_settings };
        }
        const $ = global.jQuery;
        if ($) {
            const ids = ['#stream_toggle', '#stream_openai'];
            for (const id of ids) {
                const el = $(id);
                if (el && el.length) return { kind: 'ui', el };
            }
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
            const errs = state.recentErrors.slice(-3).map((e) => e.text);
            notify(
                '空回复自动修复失败（已重试）。' +
                (errs.length ? '接口报错：' + errs.join(' | ') : '接口始终没有返回内容。') +
                ' 建议点击设置面板"复制诊断信息"排查；也可在 API 设置中尝试关闭"流式(Streaming)"。',
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
        on('GENERATION_STOPPED', () => { if (!state.selfGenerating) abandon('用户停止了生成'); });
        on('MESSAGE_SENT', () => abandon('用户发送了新消息'));
        on('MESSAGE_SWIPED', () => { if (!state.selfGenerating) abandon('用户切换了 swipes'); });
        on('CHAT_CHANGED', () => abandon('切换了聊天'));
        on('MESSAGE_DELETED', () => { if (!state.selfGenerating) abandon('消息被删除'); });
        debugLog('events bound');
    }

    // ---------- 设置面板 UI ----------
    function buildSettingsHtml() {
        return [
            '<div class="empty-reply-guard-settings">',
            '  <h4 data-i18n="Empty Reply Guard">空回守卫 · Empty Reply Guard <small>v' + VERSION + '</small></h4>',
            '  <small class="erg-hint">自动修复"空回复"（有输入没输出 / 只有 … 占位）：自动重试 → 必要时切非流式再试 → 实时显示接口真实报错。适用于 new-api / one-api / 各类中转站。</small>',
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
            return (p.endsWith('/chat/completions') || p.indexOf('/api/backends/chat-completions/generate') !== -1)
                && bodyJson && bodyJson.stream === true && Array.isArray(bodyJson.messages);
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
                }),
                log: (msg) => { console.log('[空回守卫]', msg); recordEvent('fetch-guard', { msg }); },
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
        global.EmptyReplyGuardDiag = () => buildDiagnostics();
    }

    tryInit(40);
})(typeof globalThis !== 'undefined' ? globalThis : this);
