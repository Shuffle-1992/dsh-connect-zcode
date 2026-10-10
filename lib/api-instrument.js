/**
 * api-instrument.js —— 线协议层的并发预算（信号量，PROTOCOL §5.2 N=2）与额度记账拦截。
 *
 * 拦截点（T20 调研实证）：provider.stream/streamSimple 把调用委托给
 * `api.stream(model, context, options)` / `api.streamSimple(...)`（pi-ai 导出为**同步箭头函数**，
 * 返回事件流对象）；适配器侧 `toStreamChunks` 以 `for await` 消费，提前退出调 `iterator.return()`。
 * 因此包装器必须保持同步调用语义（绝不能返回 Promise，否则 for await 直接 TypeError）：
 *   - 同步调用原 api（同步异常原样抛出并记账）；
 *   - 返回异步可迭代时，用 Proxy 包一层观察生成器——**首个 next() 才获取信号量**（排队计入等待），
 *     完成/出错/提前 return 都触发恰好一次记账与释放；
 *   - 万一返回 Promise（防御分支，实证形态不会出现）：then 链内获取信号量后记账。
 *
 * 记账行经 ledger.appendProviderRun 落 collab/logs/zcode-runs.jsonl（channel=provider）；
 * usage 从事件里鸭子式提取（input_tokens/output_tokens 或 input/output），取不到记 null。
 *
 * ⚠️ 已知语义（R-05，2026-10-06 实测记录，**当前为接受现状**）：
 * async generator 挂起在 `await acquire()` 时，消费者调 `return()` 要等该 await 完成才走
 * finally —— 即**中止一个正在排队的请求，其清理协程会等到名额轮转**（长对话下可达分钟级）。
 * 预算配对最终正确（无泄漏、无幽灵占用），只是中止响应性退化为排队时长。
 * 修复方案（acquire 与 signal 竞速）会改变"排队计入耗时"的记账语义且需处理竞速输家的
 * 名额释放，复杂度不划算 —— 故**记录为已知语义，不修**。后见者请勿当 bug 顺手改。
 */

/** 简单计数信号量：超过上限的 acquire 排队等待（不拒绝、不自动升限）。 */
export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Math.trunc(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}

function isAsyncIterable(value) {
  return !!value && typeof value[Symbol.asyncIterator] === 'function';
}

function isPromise(value) {
  return !!value && typeof value.then === 'function' && typeof value[Symbol.asyncIterator] !== 'function';
}

/** 从事件/结果对象里鸭子式提取 usage（pi-ai 事件流与 Simple 结果形状都覆盖）。 */
function noteUsageInto(usage, ev) {
  const u = ev?.usage ?? (ev?.type === 'usage' ? ev : null);
  if (!u) return usage;
  const input = u.input_tokens ?? u.input;
  const output = u.output_tokens ?? u.output;
  if (typeof input !== 'number' && typeof output !== 'number') return usage;
  return { input: typeof input === 'number' ? input : null, output: typeof output === 'number' ? output : null };
}

/**
 * 给 api 描述符包上并发预算 + 记账。
 * @param {object} rawApi anthropicMessagesApi() 的返回值。
 * @param {{ semaphore: Semaphore, record: (info: {model?:string|null, endpoint?:string|null,
 *            exit:number|string, input?:number|null, output?:number|null, elapsedMs:number}) => void }} env
 */
export function instrumentApi(rawApi, env) {
  if (!rawApi || typeof rawApi !== 'object') return rawApi;
  const wrapped = Object.create(rawApi);
  for (const name of ['stream', 'streamSimple']) {
    const fn = rawApi[name];
    if (typeof fn !== 'function') continue;
    wrapped[name] = function (...args) {
      const model = args[0];
      const modelId = typeof model?.id === 'string' ? model.id : null;
      const endpoint = typeof model?.baseUrl === 'string' ? model.baseUrl : null;
      const startedAt = Date.now();
      let finished = false;
      /** 恰好记一次账；withSlot=true 时同时释放并发预算（仅对已获取过预算的路径）。 */
      const settle = (withSlot, err, usage) => {
        if (finished) return;
        finished = true;
        if (withSlot) env.semaphore.release();
        env.record({
          model: modelId,
          endpoint,
          exit: err ? `error: ${err?.message ?? err}` : 0,
          input: usage?.input ?? null,
          output: usage?.output ?? null,
          elapsedMs: Date.now() - startedAt,
        });
      };
      const finish = (err, usage) => settle(true, err, usage);
      const recordWithoutSlot = (err, usage) => settle(false, err, usage);
      let result;
      try {
        result = fn.apply(rawApi, args);
      } catch (err) {
        recordWithoutSlot(err, null); // 同步失败：未占用预算、未上 wire，只记失败行
        throw err;
      }
      if (isAsyncIterable(result)) {
        const source = result[Symbol.asyncIterator](); // 只取一次迭代体，循环复用
        const observed = (async function* () {
          let usage = null;
          try {
            await env.semaphore.acquire(); // 懒获取：首个 next() 才占预算（排队等待计入耗时）
            while (true) {
              const { value, done } = await source.next();
              if (done) break;
              usage = noteUsageInto(usage, value);
              yield value;
            }
            finish(null, usage);
          } catch (err) {
            finish(err, usage);
            throw err;
          } finally {
            /* 消费者提前 return()/throw()（如中止）也释放预算并记一次账；正常路径此处是空操作。
             *
             * ⚠️ 必须先向内层传播 return()（2026-10-06 复核实测）：原先只 finish() 不关内层，
             * 消费者 break 后内层 generator 的 finally 永不执行（实测 innerClosed=false）——
             * 上游网关继续生成、**额度继续消耗而台账只记 aborted（usage=null）**。
             * 迭代协议义务：外层迭代器终止时必须向内层传播 return()。
             * 顺序不能反：先关内层再 finish —— 正常完成路径（done 后落到此处）时
             * source 已结束，`source.return?.()` 是空操作，不影响既有记账断言。 */
            try {
              await source.return?.();
            } catch {
              /* 内层清理失败不影响记账与预算释放 */
            }
            finish({ message: 'aborted' }, usage);
          }
        })();
        return new Proxy(result, {
          get(target, prop) {
            if (prop === Symbol.asyncIterator) return () => observed;
            /* ⚠️ 手动迭代方法也必须转发到 observed（2026-10-06 复核实测）：
             * 原实现只拦 Symbol.asyncIterator ⇒ 消费方直接 `result.next()` 时
             * **并发预算与记账双双静默绕过**（实测 records=0、active=0，事件照常到达）。
             * 这是本项目两条红线（N=2 预算 + 额度记账）共同依赖的单一假设，
             * 上游改用手动迭代即整体失效且无任何报警。for await 行为不受影响。 */
            if (prop === 'next' || prop === 'return' || prop === 'throw') {
              return (...args) => observed[prop](...args);
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      if (isPromise(result)) {
        return (async () => {
          await env.semaphore.acquire();
          try {
            const resolved = await result;
            finish(null, noteUsageInto(null, resolved));
            return resolved;
          } catch (err) {
            finish(err, null);
            throw err;
          }
        })();
      }
      recordWithoutSlot(null, noteUsageInto(null, result));
      return result;
    };
  }
  return wrapped;
}
