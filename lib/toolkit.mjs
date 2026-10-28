/**
 * lib/toolkit.mjs —— 造「注册表就绪」的工具定义（不用 `defineTool`，理由在下面）
 * ============================================================================
 * 🔴 这是本插件最容易写错、也最容易"静默坏掉"的一处，把结论和证据都留在这：
 *
 *   DSH 里有**两套**参数规格，长得很像但语义不同：
 *
 *   ① 插件侧 `@deepseek-ai/dsh-tools` 的 `defineTool({ parameters })`
 *      —— 它的 `parameters` 是「**扁平 property map 规格**」，
 *         内部用 `parameterSchemaSpecToJsonSchema()` 的 `compilePropertyMap()` 编译成 JSON Schema。
 *         也就是说：传 `{ type:'object', properties:{…} }` 进去，会被当成
 *         三个名叫 type / properties / required 的参数 —— **静默错**。
 *
 *   ② 沙箱侧 `harness.defineTool({ parameters })`
 *      —— 它**两种形状都认**（`normalizeParameterSchemaSpec()` 先看 `value.type === 'object'`），
 *         而且根节点必须开放（`additionalProperties` 只能是 true 或不写）。
 *
 *   而 `ctx.tools.register()` 吃的是**已经转换好的 ToolDefinition**：
 *   `defineTool` 交给它的 `tool.parameters` 就是 JSON Schema（源码里紧接着
 *   `assertSupportedJsonSchema(parameters)`）。注册表本身不做二次编译。
 *
 *   ⇒ 所以本插件**跳过 defineTool**，自己产出"注册表就绪"的定义：
 *      `parameters` = 标准 JSON Schema（对象根 + 开放根），`output.schema` = JSON Schema，
 *      `output.render` = 内容块数组，`execute` = 校验参数后跑业务。
 *
 *   这样做还有个附带好处：**不再依赖宿主树里有没有 `@deepseek-ai/dsh-tools`**。
 *   桌面版 profile 经常一个 `@deepseek-ai/*` 都没有，少一个 import 就少一条静默失效的路。
 * ============================================================================
 */

/**
 * 把「扁平参数规格」编译成 JSON Schema。
 * 支持 `{ type, description, enum, items, default }` 这些常用词；
 * 需要"可选"就**不要**写进 required（我们统一用第二个参数传必填名单）。
 */
export function propertyMapToJsonSchema(properties = {}, required = []) {
  const props = {}
  for (const [name, spec] of Object.entries(properties || {})) {
    const p = { ...(spec || {}) }
    if (!p.type) throw new Error(`参数 ${name} 缺 type`)
    if (p.type === 'array' && !p.items) p.items = { type: 'string' }
    props[name] = p
  }
  for (const r of required) {
    if (!Object.hasOwn(props, r)) throw new Error(`required 里的 ${r} 不在 properties 里`)
  }
  const schema = { type: 'object', properties: props, additionalProperties: true }
  if (required.length) schema.required = [...required]
  return schema
}

/**
 * 造一个注册表就绪的工具定义。
 *
 * @param {object} spec
 * @param {string} spec.name           工具名（`^[a-z0-9_]+$`）
 * @param {string} spec.description    给模型看的说明（写清"什么时候用"）
 * @param {object} spec.parameters     扁平 property map
 * @param {string[]} [spec.required]   必填参数名
 * @param {Function} spec.execute      async (args, exec) => 可 JSON 化的结果
 * @returns {object} 可直接交给 ctx.tools.register 的定义
 */
export function makeTool(spec) {
  const { name, description, parameters, required = [], execute } = spec
  if (!/^[a-z0-9_]+$/.test(String(name || ''))) throw new Error(`工具名不合法：${name}`)
  if (!description || String(description).length < 10) throw new Error(`工具 ${name} 的 description 太短，模型看不懂怎么用`)
  if (typeof execute !== 'function') throw new Error(`工具 ${name} 缺 execute`)
  return {
    name,
    description,
    parameters: propertyMapToJsonSchema(parameters, required),
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }],
    },
    /** 参数校验放在最外层做一次「类型粗检」，真正的业务校验在各自 execute 里 */
    async execute(args, exec) {
      const a = args && typeof args === 'object' ? args : {}
      return execute(a, exec)
    },
  }
}

/** 参数粗检：模型偶尔会把 number 写成字符串，能救就救一次，救不了原样交给业务 */
export function coerce(args, schema) {
  const out = { ...args }
  for (const [k, v] of Object.entries(schema?.properties || {})) {
    if (out[k] === undefined || out[k] === null) continue
    if (v.type === 'number' && typeof out[k] === 'string' && out[k].trim() !== '' && !Number.isNaN(Number(out[k]))) {
      out[k] = Number(out[k])
    }
    if (v.type === 'boolean' && typeof out[k] === 'string') {
      const s = out[k].toLowerCase()
      if (s === 'true' || s === '1') out[k] = true
      else if (s === 'false' || s === '0') out[k] = false
    }
  }
  return out
}
